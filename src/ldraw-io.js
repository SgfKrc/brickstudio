// .ldr 文件读写 v2:零件姿态使用完整 3x3 旋转矩阵(支持 SNOT 全 24 向)。
// 内部模型: brick = { id, partId, colorCode, x, y, z, m:[9], group }
// 分组以 "0 !BRICKSTUDIO GROUP <n>: i j k" 元行保存(行号索引),其他软件会忽略。

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// 3x3 矩阵乘法(行主序)
export function mul3(A, B) {
  const R = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    R[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return R;
}

export function apply3(m, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

// 绕世界轴的 90° 旋转(LDraw 坐标,+Y 向下)
export const ROT_Y90 = [0, 0, -1, 0, 1, 0, 1, 0, 0];
export const ROT_X90 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
export const ROT_Z90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];

function fmt(n) {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
}

// 按"层"给零件排序分步:LDraw +Y 向下,y 越大越靠近地面 → 从地面往上搭。
// 返回 [[brick,...], ...](每层一步)。若零件带显式 step(来自含 0 STEP 的文件),优先按 step 分组。
export function stepGroups(bricks) {
  if (!bricks.length) return [];
  if (bricks.some(b => (b.step ?? 0) > 0)) {
    const map = new Map();
    for (const b of bricks) {
      const s = b.step ?? 0;
      if (!map.has(s)) map.set(s, []);
      map.get(s).push(b);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }
  // 以零件底面高度分层(量化到 4 LDU,容忍非整层零件)
  const byLayer = new Map();
  for (const b of bricks) {
    const key = Math.round(b.y / 4) * 4;
    if (!byLayer.has(key)) byLayer.set(key, []);
    byLayer.get(key).push(b);
  }
  return [...byLayer.entries()].sort((a, b) => b[0] - a[0]).map(e =>
    e[1].sort((p, q) => (p.z - q.z) || (p.x - q.x)));
}

export function serializeLDR(bricks, groups = null, modelName = 'BrickStudio Model', opts = {}) {
  const lines = [];
  lines.push(`0 ${modelName}`);
  lines.push(`0 Name: model.ldr`);
  lines.push(`0 Author: BrickStudio`);
  lines.push(`0 !LDRAW_ORG Unofficial_Model`);
  const lineIndex = new Map(); // brickId -> 零件行序号
  const emit = (b) => {
    lineIndex.set(b.id, lineIndex.size);
    const m = b.m || IDENTITY;
    lines.push(
      `1 ${b.colorCode} ${fmt(b.x)} ${fmt(b.y)} ${fmt(b.z)} ` +
      m.map(fmt).join(' ') + ` ${b.partId}.dat`
    );
  };
  if (opts.steps) {
    // 按层导出并插入 0 STEP,BrickLink Studio / LeoCAD 会显示为搭建步骤
    const groups2 = stepGroups(bricks);
    groups2.forEach((layer, i) => {
      for (const b of layer) emit(b);
      if (i < groups2.length - 1) lines.push('0 STEP');
    });
  } else {
    for (const b of bricks) emit(b);
  }
  // 分组元数据
  const groupIds = new Map();
  for (const b of bricks) {
    if (b.group == null) continue;
    if (!groupIds.has(b.group)) groupIds.set(b.group, []);
    groupIds.get(b.group).push(lineIndex.get(b.id));
  }
  let gi = 1;
  for (const [, members] of groupIds) {
    if (members.length > 1) lines.push(`0 !BRICKSTUDIO GROUP ${gi++}: ${members.join(' ')}`);
  }
  lines.push('0');
  return lines.join('\r\n') + '\r\n';
}

let nextId = 1;
export function newBrickId() { return nextId++; }

// 解析 .ldr / .mpd。MPD 的子模型引用会带变换递归展开(拍平为零件列表)。
export function parseLDR(text) {
  const warnings = [];
  const bricks = [];
  const groupLines = [];

  // 拆分 MPD 的 FILE 段
  const sections = new Map(); // 小写名 -> 行数组
  let mainLines;
  if (/^0\s+FILE\s+/im.test(text)) {
    const re = /^0\s+FILE\s+(.+)$/gim;
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) marks.push({ name: m[1].trim(), start: m.index + m[0].length });
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? text.lastIndexOf('0 FILE', marks[i + 1].start) : text.length;
      const body = text.slice(marks[i].start, end).split(/\r?\n/);
      sections.set(marks[i].name.toLowerCase(), body);
      if (!mainLines) mainLines = body;
    }
  } else {
    mainLines = text.split(/\r?\n/);
  }

  const findSection = (file) => {
    const f = file.toLowerCase();
    return sections.get(f) || sections.get(f.replace(/\.(ldr|dat|mpd)$/i, '')) || null;
  };

  // 递归展开;parent = {m, x, y, z, color}
  const stepRef = { n: 0, used: false };
  const walk = (lines, parent, depth, stack, isMain) => {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (isMain) {
        const gm = line.match(/^0\s+!BRICKSTUDIO\s+GROUP\s+\S+:\s*([\d\s]+)$/i);
        if (gm) { groupLines.push(gm[1].trim().split(/\s+/).map(Number)); continue; }
        if (/^0\s+STEP\s*$/i.test(line)) { stepRef.n++; stepRef.used = true; continue; }
      }
      if (!line.startsWith('1 ')) continue;
      const tok = line.split(/\s+/);
      if (tok.length < 15) { warnings.push(`跳过格式异常行: ${line.slice(0, 60)}`); continue; }
      const rawColor = parseInt(tok[1], 10);
      const nums = tok.slice(2, 14).map(Number);
      if (nums.some(Number.isNaN)) { warnings.push(`跳过数值异常行: ${line.slice(0, 60)}`); continue; }
      const file = tok.slice(14).join(' ');
      const [x, y, z, ...lm] = nums;
      // 组合变换到世界(主模型)坐标
      const [wx, wy, wz] = apply3(parent.m, x, y, z);
      const pos = { x: parent.x + wx, y: parent.y + wy, z: parent.z + wz };
      const wm = mul3(parent.m, lm);
      const color = (Number.isNaN(rawColor) || rawColor === 16 || rawColor === 24) ? parent.color : rawColor;
      const sub = findSection(file);
      if (sub) {
        if (depth >= 10 || stack.has(file.toLowerCase())) {
          warnings.push(`子模型嵌套过深或循环引用: ${file}`);
          continue;
        }
        stack.add(file.toLowerCase());
        walk(sub, { m: wm, ...pos, color }, depth + 1, stack, false);
        stack.delete(file.toLowerCase());
      } else {
        const partId = file.replace(/\.dat$/i, '').replace(/\\/g, '/').split('/').pop().toLowerCase();
        bricks.push({
          id: newBrickId(),
          partId,
          colorCode: color === undefined ? 16 : color,
          x: pos.x, y: pos.y, z: pos.z,
          m: wm,
          group: null,
          step: stepRef.n,
        });
      }
    }
  };

  walk(mainLines, { m: IDENTITY, x: 0, y: 0, z: 0, color: 7 }, 0, new Set(), true);

  // 还原分组(仅主模型的自有文件)
  let g = 1;
  for (const members of groupLines) {
    const gid = `g${g++}`;
    for (const idx of members) {
      if (bricks[idx]) bricks[idx].group = gid;
    }
  }
  return { bricks, warnings };
}

import { saveTextFile } from './save-file.js';

export function downloadText(filename, text) {
  saveTextFile(text, filename);
}
