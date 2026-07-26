// 零件目录 v2:由 tools/pack-parts.mjs 生成的 parts-meta.gen.json 驱动。
// 提供:UI 分类、自动中文名、搜索(编号/英文/中文关键词)、柱钉元数据展开。
import META from './parts-meta.gen.json';

// LDraw 类别 -> UI 页签
const CAT_MAP = {
  Brick: 'brick', Plate: 'plate', Tile: 'tile', Slope: 'slope',
  Arch: 'round', Cylinder: 'round', Cone: 'round', Dish: 'round', Sphere: 'round',
  Wedge: 'wedge', Wing: 'wedge',
  Panel: 'panel', Support: 'panel', Fence: 'panel', Ladder: 'panel', Staircase: 'panel',
  Platform: 'panel', Roadsign: 'panel', Flag: 'panel', Antenna: 'panel', Garage: 'panel', Conveyor: 'panel',
  Window: 'windoor', Door: 'windoor', Glass: 'windoor',
  Bar: 'bar', Plant: 'bar',
  Bracket: 'snot', Hinge: 'snot', Turntable: 'snot', Magnet: 'snot', Rack: 'snot', Arm: 'snot',
  Wheel: 'vehicle', Tyre: 'vehicle', Vehicle: 'vehicle', Car: 'vehicle', Windscreen: 'vehicle',
  Plane: 'vehicle', Cockpit: 'vehicle', Tail: 'vehicle', Propeller: 'vehicle', Exhaust: 'vehicle',
  Tipper: 'vehicle', Tractor: 'vehicle', Trailer: 'vehicle', Crane: 'vehicle', Winch: 'vehicle',
  Technic: 'technic', Baseplate: 'baseplate',
  Container: 'misc', Homemaker: 'misc', Tap: 'misc',
};

export const CATEGORIES = [
  { id: 'recent', name: '⭐常用' },
  { id: 'brick', name: '砖' },
  { id: 'plate', name: '板' },
  { id: 'tile', name: '光板' },
  { id: 'slope', name: '斜面' },
  { id: 'round', name: '圆/拱' },
  { id: 'wedge', name: '楔形/翼' },
  { id: 'vehicle', name: '车辆' },
  { id: 'panel', name: '墙板/结构' },
  { id: 'windoor', name: '门窗' },
  { id: 'bar', name: '杆/植物' },
  { id: 'snot', name: '支架/铰链' },
  { id: 'technic', name: '科技' },
  { id: 'baseplate', name: '底板' },
  { id: 'misc', name: '容器/其他' },
];

// 常用词英->中翻译(只译开头关键词,尺寸保留)
const ZH_WORDS = [
  [/^Technic Brick/i, '科技砖'], [/^Brick Round Corner/i, '圆角砖'], [/^Brick Round/i, '圆砖'],
  [/^Brick Curved/i, '曲面砖'], [/^Brick Arch/i, '拱砖'], [/^Brick/i, '砖'],
  [/^Plate Round/i, '圆板'], [/^Plate/i, '板'], [/^Tile Round/i, '圆光板'], [/^Tile/i, '光板'],
  [/^Slope Brick Curved/i, '曲面斜砖'], [/^Slope Brick/i, '斜砖'], [/^Slope Curved/i, '曲面斜面'], [/^Slope/i, '斜面'],
  [/^Arch/i, '拱'], [/^Cylinder Half/i, '半圆柱'], [/^Cylinder/i, '圆柱'], [/^Cone/i, '圆锥'],
  [/^Dish/i, '碟'], [/^Wedge Plate/i, '楔形板'], [/^Wedge/i, '楔形'],
  [/^Panel Corner/i, '转角墙板'], [/^Panel/i, '墙板'], [/^Window/i, '窗'], [/^Door Frame/i, '门框'], [/^Door/i, '门'],
  [/^Bar Holder/i, '杆夹'], [/^Bar/i, '杆'], [/^Bracket/i, '支架'], [/^Baseplate/i, '底板'],
  [/^Plant Flower/i, '花'], [/^Plant Leaves/i, '叶'], [/^Plant/i, '植物'],
  [/^Fence/i, '栏杆'], [/^Support/i, '支撑'], [/^Turntable/i, '转盘'],
  [/^Hinge Brick/i, '铰链砖'], [/^Hinge Plate/i, '铰链板'], [/^Hinge Tile/i, '铰链光板'], [/^Hinge/i, '铰链'],
  [/^Wheel/i, '车轮'], [/^Tyre/i, '轮胎'], [/^Car Mudguard/i, '挡泥板'], [/^Car Base/i, '车底盘'], [/^Car/i, '车'],
  [/^Windscreen/i, '挡风玻璃'], [/^Vehicle Mudguard/i, '挡泥板'], [/^Vehicle Base/i, '车底盘'], [/^Vehicle/i, '车辆'],
  [/^Plane/i, '飞机'], [/^Cockpit/i, '座舱'], [/^Tail/i, '尾翼'], [/^Wing/i, '机翼'],
  [/^Propeller/i, '螺旋桨'], [/^Exhaust/i, '排气管'], [/^Crane/i, '起重机'], [/^Winch/i, '绞盘'],
  [/^Ladder/i, '梯子'], [/^Staircase/i, '楼梯'], [/^Platform/i, '平台'], [/^Roadsign/i, '路牌'],
  [/^Flag/i, '旗'], [/^Antenna/i, '天线'], [/^Glass/i, '玻璃'], [/^Container Box/i, '箱'],
  [/^Container Barrel/i, '桶'], [/^Container Cupboard/i, '柜'], [/^Container/i, '容器'],
  [/^Homemaker/i, '家居'], [/^Tap/i, '水龙头'], [/^Sphere/i, '球'], [/^Magnet/i, '磁铁'],
  [/^Rack/i, '齿条'], [/^Arm/i, '机械臂'], [/^Garage/i, '车库门'], [/^Conveyor/i, '传送带'],
  [/^Tipper/i, '翻斗'], [/^Tractor/i, '拖拉机'], [/^Trailer/i, '拖车'],
  [/^Technic Beam/i, '科技梁'], [/^Technic Axle/i, '科技轴'], [/^Technic Pin/i, '科技销'],
  [/^Technic Bush/i, '科技轴套'], [/^Technic Cross Block/i, '科技十字块'], [/^Technic Connector/i, '科技连接器'],
];
const ZH_EXTRA = [
  [/Corner/i, '转角'], [/Inverted/i, '倒'], [/with Stud(s)? on (1 )?Side(s)?/i, '侧带柱钉'],
  [/with Headlight/i, '车灯'], [/Round/i, '圆'], [/Half/i, '半'], [/Double/i, '双'],
];

function zhName(desc) {
  let name = desc;
  for (const [re, zh] of ZH_WORDS) {
    if (re.test(name)) { name = name.replace(re, zh); break; }
  }
  name = name.replace(/\s+x\s+/gi, 'x').replace(/\s{2,}/g, ' ');
  return name;
}

// 搜索用中文关键词 -> 英文
const CN_KEYWORDS = [
  ['科技', 'technic'], ['圆砖', 'brick round'], ['圆板', 'plate round'], ['圆光板', 'tile round'],
  ['砖', 'brick'], ['板', 'plate'], ['光板', 'tile'], ['瓷砖', 'tile'],
  ['斜面', 'slope'], ['斜坡', 'slope'], ['曲面', 'curved'], ['拱', 'arch'],
  ['圆柱', 'cylinder'], ['圆锥', 'cone'], ['锥', 'cone'], ['碟', 'dish'], ['圆顶', 'dome'],
  ['楔', 'wedge'], ['墙板', 'panel'], ['面板', 'panel'], ['窗', 'window'], ['门', 'door'],
  ['杆', 'bar'], ['栏杆', 'fence'], ['支架', 'bracket'], ['底板', 'baseplate'],
  ['植物', 'plant'], ['花', 'flower'], ['叶', 'leaves'], ['草', 'grass'],
  ['转角', 'corner'], ['倒', 'inverted'], ['圆', 'round'], ['半', 'half'], ['双', 'double'],
  ['柱钉', 'stud'], ['侧', 'side'], ['车灯', 'headlight'], ['转盘', 'turntable'], ['支撑', 'support'],
  ['铰链', 'hinge'], ['车轮', 'wheel'], ['轮子', 'wheel'], ['轮胎', 'tyre'], ['挡风', 'windscreen'],
  ['挡泥板', 'mudguard'], ['底盘', 'base'], ['飞机', 'plane'], ['座舱', 'cockpit'], ['机翼', 'wing'],
  ['尾翼', 'tail'], ['螺旋桨', 'propeller'], ['梯子', 'ladder'], ['楼梯', 'stair'], ['旗', 'flag'],
  ['天线', 'antenna'], ['玻璃', 'glass'], ['箱', 'box'], ['桶', 'barrel'], ['柜', 'cupboard'],
  ['容器', 'container'], ['球', 'sphere'], ['磁铁', 'magnet'], ['起重机', 'crane'], ['梁', 'beam'],
  ['轴', 'axle'], ['销', 'pin'], ['车库', 'garage'], ['路牌', 'roadsign'], ['水龙头', 'tap'],
];

export const PARTS = Object.entries(META).filter(([, m]) => !m.h).map(([id, m]) => ({
  id,
  name: zhName(m.d),
  en: m.d,
  cat: CAT_MAP[m.c] || 'misc',
})).sort((a, b) => a.en.localeCompare(b.en, 'en', { numeric: true }));

const byId = new Map(Object.entries(META).map(([id, m]) => [id, { id, name: zhName(m.d), en: m.d }]));

export function partById(id) { return byId.get(String(id).toLowerCase()); }
export function partFile(id) { return `ldraw/parts/${id}.dat`; }

// 展开柱钉列表:[{x,y,z,dx,dy,dz}](g 压缩网格 / s 显式列表)
export function partStuds(id) {
  const m = META[String(id).toLowerCase()];
  if (!m) return [];
  if (m.g) {
    const [x0, z0, nx, nz, y] = m.g;
    const out = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++)
      out.push({ x: x0 + i * 20, y, z: z0 + j * 20, dx: 0, dy: -1, dz: 0 });
    return out;
  }
  if (m.s) return m.s.map(([x, y, z, dx, dy, dz]) => ({ x, y, z, dx, dy, dz }));
  return [];
}

export function searchParts(query) {
  let q = query.trim().toLowerCase();
  if (!q) return [];
  // 中文关键词翻译(可多个词)
  for (const [cn, en] of CN_KEYWORDS) q = q.split(cn).join(` ${en} `);
  // 尺寸写法归一:2x4 -> 2 x 4
  q = q.replace(/(\d)\s*[x×]\s*(\d)/g, '$1 x $2').replace(/\s+/g, ' ').trim();
  // 尺寸串(如 "2 x 4"、"2 x 4 x 3")作为整体词条,不拆散
  const terms = [];
  q = q.replace(/\d+(?: x \d+)+(?:\/\d+)?/g, m => { terms.push(m); return ' '; });
  terms.push(...q.split(' ').filter(Boolean));
  const scored = [];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regs = terms.map(t => new RegExp(esc(t) + (/\d$/.test(t) ? '(?![\\d])' : ''), 'i'));
  for (const p of PARTS) {
    // LDraw 描述常含双空格,匹配前归一
    const hay = (p.id + ' ' + p.en + ' ' + p.name).toLowerCase().replace(/\s+/g, ' ');
    let ok = true, score = 0;
    for (let i = 0; i < regs.length; i++) {
      const idx = hay.search(regs[i]);
      if (idx < 0) { ok = false; break; }
      score += (idx === 0 ? 3 : 1);
    }
    if (ok) scored.push([score - p.en.length / 12, p]); // 简短基础件优先
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 80).map(s => s[1]);
}
