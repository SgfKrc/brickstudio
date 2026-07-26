/**
 * xlsx-export.js — zero-dependency, browser-ready table export module.
 *
 * Exports:
 *   makeZip(entries)          -> Uint8Array (ZIP, stored/no compression)
 *   makeXlsx(rows, sheetName) -> Uint8Array (minimal valid .xlsx)
 *   makeCsv(rows)             -> string (UTF-8 BOM prefixed CSV)
 *
 * Uses only Web-standard APIs (TextEncoder), so it also runs in Node.
 */

const textEncoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* CRC32 (table-based)                                                */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Little-endian byte writer helpers                                  */
/* ------------------------------------------------------------------ */

function u16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function u32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  return textEncoder.encode(String(data));
}

/* ------------------------------------------------------------------ */
/* makeZip: ZIP container, store (method 0), UTF-8 names (bit 11)     */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<{name: string, data: Uint8Array|string}>} entries
 * @returns {Uint8Array}
 */
export function makeZip(entries) {
  const GP_FLAG_UTF8 = 0x0800; // bit 11: filename & comment are UTF-8
  const VERSION = 20;          // 2.0
  const DOS_TIME = 0;          // fixed value, valid enough for readers
  const DOS_DATE = 0x21;       // 1980-01-01 (some readers dislike 0)

  const files = entries.map((entry) => {
    const nameBytes = textEncoder.encode(entry.name);
    const dataBytes = toBytes(entry.data);
    return {
      nameBytes,
      dataBytes,
      crc: crc32(dataBytes),
      size: dataBytes.length,
      offset: 0,
    };
  });

  // Compute total size: local headers + data + central directory + EOCD.
  let localSize = 0;
  let centralSize = 0;
  for (const f of files) {
    localSize += 30 + f.nameBytes.length + f.size;
    centralSize += 46 + f.nameBytes.length;
  }
  const total = localSize + centralSize + 22;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;

  // Local file headers + data
  for (const f of files) {
    f.offset = pos;
    u32(view, pos, 0x04034B50);              // local file header signature
    u16(view, pos + 4, VERSION);             // version needed to extract
    u16(view, pos + 6, GP_FLAG_UTF8);        // general purpose bit flag
    u16(view, pos + 8, 0);                   // compression method: store
    u16(view, pos + 10, DOS_TIME);           // last mod time
    u16(view, pos + 12, DOS_DATE);           // last mod date
    u32(view, pos + 14, f.crc);              // CRC-32
    u32(view, pos + 18, f.size);             // compressed size
    u32(view, pos + 22, f.size);             // uncompressed size
    u16(view, pos + 26, f.nameBytes.length); // file name length
    u16(view, pos + 28, 0);                  // extra field length
    pos += 30;
    out.set(f.nameBytes, pos);
    pos += f.nameBytes.length;
    out.set(f.dataBytes, pos);
    pos += f.size;
  }

  // Central directory
  const centralStart = pos;
  for (const f of files) {
    u32(view, pos, 0x02014B50);              // central directory signature
    u16(view, pos + 4, VERSION);             // version made by
    u16(view, pos + 6, VERSION);             // version needed to extract
    u16(view, pos + 8, GP_FLAG_UTF8);        // general purpose bit flag
    u16(view, pos + 10, 0);                  // compression method: store
    u16(view, pos + 12, DOS_TIME);           // last mod time
    u16(view, pos + 14, DOS_DATE);           // last mod date
    u32(view, pos + 16, f.crc);              // CRC-32
    u32(view, pos + 20, f.size);             // compressed size
    u32(view, pos + 24, f.size);             // uncompressed size
    u16(view, pos + 28, f.nameBytes.length); // file name length
    u16(view, pos + 30, 0);                  // extra field length
    u16(view, pos + 32, 0);                  // file comment length
    u16(view, pos + 34, 0);                  // disk number start
    u16(view, pos + 36, 0);                  // internal file attributes
    u32(view, pos + 38, 0);                  // external file attributes
    u32(view, pos + 42, f.offset);           // relative offset of local header
    pos += 46;
    out.set(f.nameBytes, pos);
    pos += f.nameBytes.length;
  }
  const centralEnd = pos;

  // End of central directory record
  u32(view, pos, 0x06054B50);                    // EOCD signature
  u16(view, pos + 4, 0);                         // number of this disk
  u16(view, pos + 6, 0);                         // disk with central dir
  u16(view, pos + 8, files.length);              // entries on this disk
  u16(view, pos + 10, files.length);             // total entries
  u32(view, pos + 12, centralEnd - centralStart);// central directory size
  u32(view, pos + 16, centralStart);             // central directory offset
  u16(view, pos + 20, 0);                        // comment length

  return out;
}

/* ------------------------------------------------------------------ */
/* XML helpers                                                        */
/* ------------------------------------------------------------------ */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control chars invalid in XML 1.0 (keep \t \n \r).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function columnRef(index) {
  // 0 -> A, 25 -> Z, 26 -> AA ...
  let ref = '';
  let n = index;
  do {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return ref;
}

function sanitizeSheetName(name) {
  let clean = String(name == null ? '' : name)
    .replace(/[\\\/\?\*\[\]:]/g, '')  // characters Excel forbids
    .replace(/^'+|'+$/g, '')          // may not start/end with apostrophe
    .slice(0, 31);                    // max 31 chars
  if (!clean.trim()) clean = 'Sheet1';
  return clean;
}

/* ------------------------------------------------------------------ */
/* makeXlsx: minimal OOXML spreadsheet                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<Array<string|number>>} rows
 * @param {string} [sheetName]
 * @returns {Uint8Array}
 */
export function makeXlsx(rows, sheetName = 'Sheet1') {
  const name = sanitizeSheetName(sheetName);

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + escapeXml(name) + '" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  let sheetRows = '';
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    let cells = '';
    for (let c = 0; c < row.length; c++) {
      const value = row[c];
      if (value == null) continue;
      const ref = columnRef(c) + (r + 1);
      if (typeof value === 'number' && Number.isFinite(value)) {
        cells += '<c r="' + ref + '"><v>' + value + '</v></c>';
      } else {
        cells +=
          '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
          escapeXml(value) +
          '</t></is></c>';
      }
    }
    sheetRows += '<row r="' + (r + 1) + '">' + cells + '</row>';
  }

  const worksheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + sheetRows + '</sheetData>' +
    '</worksheet>';

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: worksheet },
  ]);
}

/* ------------------------------------------------------------------ */
/* makeCsv: UTF-8 BOM, RFC-4180 quoting                               */
/* ------------------------------------------------------------------ */

/**
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
export function makeCsv(rows) {
  const lines = rows.map((row) =>
    (row || [])
      .map((value) => {
        const s = value == null ? '' : String(value);
        if (/[",\r\n]/.test(s)) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      })
      .join(',')
  );
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
