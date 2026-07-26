// 零件库打包 v2:
//  - 按类别从完整 LDraw 库自动筛选常用零件(数百~上千个)
//  - 复制零件及全部递归依赖到 public/ldraw/
//  - 递归解析 stud* 基元引用,精确提取每个零件的柱钉位置与朝向(卡扣/SNOT 检测数据)
//  - 生成 src/parts-meta.gen.json:{ id: { d:描述, c:类别, s:[[x,y,z,dx,dy,dz],..] | g:[x0,z0,nx,nz,y] } }
// 用法: node tools/pack-parts.mjs <ldraw库根目录> [--full]
//   --full: 额外收录人仔/动物/火车/船/电子/全科技等重资源类(约 +3400 零件、+160MB 磁盘)。
//           适合前后端版(零件按需加载,只占磁盘不占内存);单文件版勿用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projRoot = path.resolve(__dirname, '..');
const libRoot = process.argv[2];
if (!libRoot || !fs.existsSync(path.join(libRoot, 'parts'))) {
  console.error('用法: node tools/pack-parts.mjs <ldraw库根目录>');
  process.exit(1);
}

// ---------- 库索引(大小写不敏感) ----------
const index = new Map();
function walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else index.set(r.toLowerCase(), path.join(dir, e.name));
  }
}
for (const sub of ['parts', 'p']) walk(path.join(libRoot, sub), sub);

// ---------- 零件筛选 ----------
const KEEP_CATS = new Set(['Brick', 'Plate', 'Tile', 'Slope', 'Arch', 'Cylinder', 'Cone', 'Dish',
  'Wedge', 'Panel', 'Window', 'Door', 'Bar', 'Bracket', 'Plant', 'Support', 'Fence', 'Turntable',
  // v4 扩充:轻量建筑类
  'Hinge', 'Ladder', 'Staircase', 'Platform', 'Roadsign', 'Flag', 'Antenna', 'Glass',
  'Container', 'Homemaker', 'Tap', 'Sphere', 'Magnet', 'Rack', 'Arm', 'Garage', 'Conveyor',
  // v4 扩充:车辆体系
  'Wheel', 'Tyre', 'Vehicle', 'Car', 'Windscreen', 'Plane', 'Cockpit', 'Tail', 'Wing',
  'Propeller', 'Exhaust', 'Tipper', 'Tractor', 'Trailer', 'Crane', 'Winch']);

// --full 档:重资源类(仅推荐前后端版使用)
const FULL = process.argv.includes('--full');
const FULL_CATS = new Set(['Minifig', 'Minifig Accessory', 'Minifig Headwear', 'Minifig Neckwear',
  'Minifig Footwear', 'Minifig Hipwear', 'Figure', 'Figure Accessory', 'Animal',
  'Train', 'Monorail', 'Boat', 'Electric', 'Sphere', 'Rock', 'Staircase']);
if (FULL) for (const c of FULL_CATS) KEEP_CATS.add(c);
// 保留 v1 手选零件,保证旧文件兼容
const LEGACY = ['3005','3004','3622','3010','3009','3008','3003','3002','3001','2456','3007','2357',
  '3024','3023','3623','3710','3666','3460','3022','3021','3020','3795','3034','3031','3032','3035',
  '3958','3036','41539','92438','3070b','3069b','63864','2431','6636','4162','3068b','87079',
  '54200','3040','3039','3038','3037','4286','3298','3665','3660','4073','3062b','4589','4032',
  '3941','30367a','87087','4070','99781','3700','3701','3705'];

const partsDir = path.join(libRoot, 'parts');
const selected = new Map(); // id -> {desc, cat}
for (const f of fs.readdirSync(partsDir)) {
  if (!f.endsWith('.dat')) continue;
  const id = f.slice(0, -4);
  const head = fs.readFileSync(path.join(partsDir, f), 'utf8').slice(0, 800);
  const lines = head.split(/\r?\n/);
  const desc = (lines[0] || '').replace(/^0\s*/, '').trim();
  if (/^[~=_|]/.test(desc)) continue;
  if (/Pattern|Sticker|Obsolete|Moved/i.test(desc)) continue;
  if (/Duplo|Modulex|Quatro|Primo|Znap|Fabuland|Belville|Scala|\bBionicle\b|Braille|DOTS/i.test(desc)) continue;
  const catLine = lines.find(l => l.startsWith('0 !CATEGORY'));
  const cat = catLine ? catLine.replace('0 !CATEGORY', '').trim() : desc.split(' ')[0];
  let keep = false;
  if (KEEP_CATS.has(cat)) keep = true;
  if (cat === 'Baseplate') keep = /^Baseplate\s+\d+\s*x\s*\d+$/i.test(desc);
  if (cat === 'Technic') keep = FULL || /^Technic\s+(Brick|Beam|Axle(?!\s+Flexible)|Pin\b|Bush|Cross Block|Connector)/i.test(desc);
  // 太长的异形描述通常是特殊件,粗过滤降低噪音
  if (keep && desc.length > 90) keep = false;
  if (keep) selected.set(id.toLowerCase(), { desc, cat: cat === 'Baseplate' ? 'Baseplate' : cat });
}
for (const id of LEGACY) {
  if (!selected.has(id.toLowerCase()) && index.has(`parts/${id.toLowerCase()}.dat`)) {
    const head = fs.readFileSync(index.get(`parts/${id.toLowerCase()}.dat`), 'utf8').slice(0, 800);
    const lines = head.split(/\r?\n/);
    const desc = (lines[0] || '').replace(/^0\s*/, '').trim();
    const catLine = lines.find(l => l.startsWith('0 !CATEGORY'));
    const cat = catLine ? catLine.replace('0 !CATEGORY', '').trim() : desc.split(' ')[0];
    // 重定向/内部件:保留在库中(旧文件兼容),但不在零件面板显示
    const hidden = /^[~=_|]/.test(desc);
    selected.set(id.toLowerCase(), { desc, cat, hidden });
  }
}
console.log(`筛选零件: ${selected.size} 个`);

// ---------- 依赖收集 + 柱钉提取 ----------
const isTopStud = base => /^stud(?!3|4)[a-z0-9]*\.dat$/i.test(base.replace(/^(8\\|48\\|8\/|48\/)/i, ''));

function resolveRef(ref, fromDir) {
  const norm = ref.replace(/\\/g, '/').toLowerCase();
  for (const c of [norm, `parts/${norm}`, `p/${norm}`, fromDir ? `${fromDir}/${norm}` : null]) {
    if (c && index.has(c)) return c;
  }
  return null;
}

// 4x4 矩阵工具(行主序 16)
const matMul = (A, B) => {
  const R = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
    for (let k = 0; k < 4; k++) R[i * 4 + j] += A[i * 4 + k] * B[k * 4 + j];
  return R;
};
const lineToMat = (t) => {
  const [x, y, z, a, b, c, d, e, f, g, h, i] = t;
  return [a, b, c, x, d, e, f, y, g, h, i, z, 0, 0, 0, 1];
};

const fileCache = new Map();   // rel -> {refs:[{rel, mat}], isStud:boolean}
function parseFile(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  const abs = index.get(rel);
  const refs = [];
  if (abs) {
    const text = fs.readFileSync(abs, 'utf8');
    const fromDir = path.dirname(rel);
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t.startsWith('1 ')) continue;
      const tok = t.split(/\s+/);
      if (tok.length < 15) continue;
      const nums = tok.slice(2, 14).map(Number);
      if (nums.some(Number.isNaN)) continue;
      const file = tok.slice(14).join(' ');
      const r = resolveRef(file, fromDir);
      const base = file.replace(/\\/g, '/').split('/').pop();
      refs.push({ rel: r, base, mat: lineToMat(nums) });
    }
  }
  const entry = { refs };
  fileCache.set(rel, entry);
  return entry;
}

// 每文件的柱钉(文件局部坐标),备忘录化
const studCache = new Map();
function studsOf(rel, depth = 0) {
  if (studCache.has(rel)) return studCache.get(rel);
  if (depth > 12) return [];
  const out = [];
  const { refs } = parseFile(rel);
  for (const r of refs) {
    if (isTopStud(r.base)) {
      // 柱钉基元:原点在底面中心,向 -Y 方向凸起。方向 = M * (0,-1,0)
      const m = r.mat;
      const px = m[3], py = m[7], pz = m[11];
      let dx = -m[1], dy = -m[5], dz = -m[9];
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      out.push([px, py, pz, dx, dy, dz]);
    } else if (r.rel) {
      for (const s of studsOf(r.rel, depth + 1)) {
        const m = r.mat;
        const px = m[0] * s[0] + m[1] * s[1] + m[2] * s[2] + m[3];
        const py = m[4] * s[0] + m[5] * s[1] + m[6] * s[2] + m[7];
        const pz = m[8] * s[0] + m[9] * s[1] + m[10] * s[2] + m[11];
        let dx = m[0] * s[3] + m[1] * s[4] + m[2] * s[5];
        let dy = m[4] * s[3] + m[5] * s[4] + m[6] * s[5];
        let dz = m[8] * s[3] + m[9] * s[4] + m[10] * s[5];
        const len = Math.hypot(dx, dy, dz) || 1;
        out.push([px, py, pz, dx / len, dy / len, dz / len]);
      }
    }
  }
  studCache.set(rel, out);
  return out;
}

// 依赖收集
const needed = new Map();
function collect(rel, depth = 0) {
  if (needed.has(rel) || depth > 16) return;
  needed.set(rel, index.get(rel));
  for (const r of parseFile(rel).refs) {
    if (r.rel) collect(r.rel, depth + 1);
  }
}

const meta = {};
const failed = [];
for (const [id, info] of selected) {
  const rel = `parts/${id}.dat`;
  if (!index.has(rel)) { failed.push(id); continue; }
  collect(rel);
  let studs = studsOf(rel).map(s => s.map(v => Math.round(v * 100) / 100));
  // 去重(不同 LOD 可能重复)
  const seen = new Set();
  studs = studs.filter(s => {
    const k = s.map(v => Math.round(v)).join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const entry = { d: info.desc, c: info.cat };
  if (info.hidden) entry.h = 1;
  // 压缩表示:全部朝上且构成完整矩形网格 -> g:[x0,z0,nx,nz,y]
  const allUp = studs.length > 0 && studs.every(s => Math.abs(s[3]) < 0.01 && s[4] < -0.99 && Math.abs(s[5]) < 0.01);
  let packed = false;
  if (allUp && studs.length >= 4) {
    const xs = [...new Set(studs.map(s => s[0]))].sort((a, b) => a - b);
    const zs = [...new Set(studs.map(s => s[2]))].sort((a, b) => a - b);
    const ys = [...new Set(studs.map(s => s[1]))];
    const gridOk = ys.length === 1 &&
      xs.every((x, i) => i === 0 || Math.abs(x - xs[i - 1] - 20) < 0.1) &&
      zs.every((z, i) => i === 0 || Math.abs(z - zs[i - 1] - 20) < 0.1) &&
      studs.length === xs.length * zs.length;
    if (gridOk) {
      entry.g = [xs[0], zs[0], xs.length, zs.length, ys[0]];
      packed = true;
    }
  }
  if (!packed && studs.length) entry.s = studs;
  meta[id] = entry;
}

// ---------- 输出 ----------
const outRoot = path.join(projRoot, 'public/ldraw');
fs.rmSync(outRoot, { recursive: true, force: true });
let bytes = 0;
for (const [rel, abs] of needed) {
  if (!abs) continue;
  const dest = path.join(outRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  bytes += fs.statSync(abs).size;
}
for (const cfg of ['LDConfig.ldr', 'ldconfig.ldr']) {
  const p = path.join(libRoot, cfg);
  if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(outRoot, 'LDConfig.ldr')); break; }
}

// ---------- 颜色表(LDConfig.ldr -> colors.gen.json) ----------
const ldcPath = path.join(libRoot, 'LDConfig.ldr');
if (fs.existsSync(ldcPath)) {
  const colors = [];
  for (const raw of fs.readFileSync(ldcPath, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+(#[0-9A-Fa-f]{6})\s+EDGE\s+\S+(.*)$/);
    if (!m) continue;
    const [, name, code, hex, rest] = m;
    if (/Rubber|Glitter|Speckle|Fabric/i.test(name)) continue;
    const c = { code: +code, en: name.replace(/_/g, ' '), hex };
    const alpha = rest.match(/ALPHA\s+(\d+)/);
    if (alpha) c.alpha = Math.round(+alpha[1] / 255 * 100) / 100;
    if (/CHROME/.test(rest)) c.fin = 'chrome';
    else if (/PEARLESCENT/.test(rest)) c.fin = 'pearl';
    else if (/METAL/.test(rest)) c.fin = 'metal';
    if (+code >= 256 && +code <= 511 && !c.fin && !alpha) { /* 保留 */ }
    colors.push(c);
  }
  fs.writeFileSync(path.join(projRoot, 'src/colors.gen.json'), JSON.stringify(colors));
  console.log(`颜色: ${colors.length} 种`);
}

const metaPath = path.join(projRoot, 'src/parts-meta.gen.json');
fs.writeFileSync(metaPath, JSON.stringify(meta));
const gridCount = Object.values(meta).filter(m => m.g).length;
const listCount = Object.values(meta).filter(m => m.s).length;
console.log(`零件: ${Object.keys(meta).length} | 网格柱钉: ${gridCount} | 列表柱钉: ${listCount} | 无柱钉: ${Object.keys(meta).length - gridCount - listCount}`);
console.log(`依赖文件: ${needed.size} 个, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`元数据: ${(fs.statSync(metaPath).size / 1024).toFixed(1)} KB`);
if (failed.length) console.log(`缺失: ${failed.join(', ')}`);
