// APK 体检:检查打包好的 APK 里到底有没有前端资源(assets/www)。
// 用途:排查安卓版打开后报 net::ERR_CACHE_MISS / 白屏 —— 那基本都是 assets 没打进去。
// 零依赖,只读 ZIP 中央目录,不解压。
// 用法: node tools/apk-check.mjs [APK路径]     默认 <项目根>/BrickStudio.apk
import { readFileSync, existsSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 新版壳(自己用 AssetManager 服资源)在 MainActivity 里定义的标记常量,
// 会以字符串形式出现在 classes.dex 中,用来判断 APK 是否包含最新 Java 代码
const SHELL_MARKER = 'BRICKSTUDIO_SHELL_V2_ASSETMANAGER';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apk = path.resolve(process.argv[2] || path.join(ROOT, 'BrickStudio.apk'));

if (!existsSync(apk)) {
  console.error(`找不到 APK: ${apk}`);
  console.error('请先运行「打包安卓版.bat」,或把 APK 路径作为参数传入。');
  process.exit(1);
}

/** 只解析 ZIP 中央目录,列出所有条目名与大小 */
function listZip(zipPath) {
  const buf = readFileSync(zipPath);
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) { eocd = i; break; }
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/APK(未找到 EOCD)');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const method = buf.readUInt16LE(off + 10);
    const localOff = buf.readUInt32LE(off + 42);
    entries.push({ name, compSize, uncompSize, method, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return { entries, buf };
}

/** 取出某个条目的解压内容(仅支持 store/deflate,足够 APK 用) */
function readEntry(buf, e) {
  const LOC_SIG = 0x04034b50;
  if (buf.readUInt32LE(e.localOff) !== LOC_SIG) return null;
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  try {
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
  } catch {
    return null;
  }
  return null;
}

/** 检查 classes*.dex 里是否含有新版壳的标记字符串 */
function detectShell(buf, entries) {
  const dexes = entries.filter(e => /^classes\d*\.dex$/.test(e.name));
  if (!dexes.length) return { found: false, dexCount: 0 };
  for (const d of dexes) {
    const data = readEntry(buf, d);
    if (data && data.includes(SHELL_MARKER)) return { found: true, dexCount: dexes.length };
  }
  return { found: false, dexCount: dexes.length };
}

const { entries, buf } = listZip(apk);
const shell = detectShell(buf, entries);
const www = entries.filter(e => e.name.startsWith('assets/www/'));
const ldraw = www.filter(e => e.name.startsWith('assets/www/ldraw/'));
const hasIndex = www.some(e => e.name === 'assets/www/index.html');
const hasApp = www.some(e => e.name === 'assets/www/assets/app.js');
const hasConfig = www.some(e => e.name === 'assets/www/ldraw/LDConfig.ldr');
const totalBytes = www.reduce((s, e) => s + e.uncompSize, 0);

const size = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

console.log(`\nAPK: ${apk}`);
console.log(`  条目总数: ${entries.length}`);
console.log(`  assets/www 条目: ${www.length}(其中零件文件 ${ldraw.length} 个),解压后约 ${size(totalBytes)}`);
console.log(`  assets/www/index.html          ${hasIndex ? '✓ 有' : '✗ 缺失'}`);
console.log(`  assets/www/assets/app.js       ${hasApp ? '✓ 有' : '✗ 缺失'}`);
console.log(`  assets/www/ldraw/LDConfig.ldr  ${hasConfig ? '✓ 有' : '✗ 缺失'}`);
console.log(`  Java 壳版本                    ${shell.found ? '✓ 新版(AssetManager 直供)' : '✗ 旧版(仍用 WebViewAssetLoader)'}`);

if (!hasIndex || !hasApp) {
  console.log('\n✗ 诊断:前端资源没有被打进 APK —— 这正是打开后报 net::ERR_CACHE_MISS / 白屏的原因。');
  console.log('  修复:在项目根目录依次执行');
  console.log('     npm run build');
  console.log('     node tools\\android-assets.mjs      (确认输出 "共 NNNN 个文件")');
  console.log('     打包安卓版.bat');
  console.log('  若仍然缺失,检查 android\\app\\src\\main\\assets\\www\\index.html 是否真实存在,');
  console.log('  以及构建时是否有别的进程占用/清理了该目录。');
  process.exit(2);
} else if (!shell.found) {
  console.log('\n✗ 诊断:资源没问题,但 APK 里是【旧版 Java 壳】—— 这正是报');
  console.log('  net::ERR_CACHE_MISS / ERR_HTTP_RESPONSE_CODE_FAILURE 的原因。');
  console.log('  修复在 Java 代码里(已改为用 AssetManager 直接供给资源),必须重新打包:');
  console.log('     打包安卓版.bat');
  console.log('  然后手机上【先卸载旧版再安装】(签名/版本不同会覆盖失败甚至闪退)。');
  process.exit(4);
} else if (ldraw.length < 100) {
  console.log(`\n⚠ 前端在,但零件文件只有 ${ldraw.length} 个,零件会加载失败。`);
  console.log('  多半是 dist/ldraw 不全:先 node tools\\pack-parts.mjs complete\\ldraw 再 npm run build。');
  process.exit(3);
} else {
  console.log('\n✓ APK 内资源完整。若仍打不开,请把手机上的报错原文发来(新版壳会直接显示中文原因)。');
}
