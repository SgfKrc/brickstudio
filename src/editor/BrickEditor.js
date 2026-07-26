// 3D 搭建编辑器核心 v2:
//  - 全矩阵姿态(24 向 90°,SNOT 侧向拼接)
//  - 卡扣连接检测(柱钉↔底面格,含侧向柱钉吸附)
//  - 多选/分组、整组移动旋转
// 坐标约定:内部数据全部 LDraw 坐标(LDU,+Y 向下);场景根节点 rotation.x=PI。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  IDENTITY, mul3, apply3, ROT_Y90, ROT_X90, newBrickId,
} from '../ldraw-io.js';
import { InstancePool } from './InstancePool.js';

const GRID = 10;
// 边线数量阈值:零件数超过该值时整体隐藏边线(每砖一个 LineSegments,数量大时是主要开销)
const EDGE_LIMIT = 300;
// 选中/拖动无效的实例乘法着色(instanceColor;分量>1 在标准材质浮点属性下不被 clamp)
const TINT_NONE = [1, 1, 1];
// 乘法着色只能"压暗"某些通道(纯红件的蓝通道≈0,再乘也提不亮),
// 因此选中的主要视觉反馈是描边(见 _refreshSelOutline),这里只做轻微色调偏移辅助。
const TINT_SELECT = [0.72, 0.82, 1.25];
const TINT_INVALID = [1.25, 0.5, 0.5];
const TAP_MS = 600;
const TAP_PX = 10;
const UNDO_MAX = 100;
const CONNECT_PLANE_TOL = 1.6;  // 柱钉基面与底面格的法向距离容差
const CONNECT_XY_TOL = 2.6;     // 面内偏移容差

const ROT_X180 = mul3(ROT_X90, ROT_X90);
const ROT_Z90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const ROT_ZN90 = [0, 1, 0, -1, 0, 0, 0, 0, 1];
const ROT_XN90 = [1, 0, 0, 0, 0, 1, 0, -1, 0];

const round3 = v => Math.round(v * 1000) / 1000;

// 是否 90° 网格姿态(矩阵元素均为 0/±1)
export function isGridM(m) {
  return m.every(v => Math.abs(v) < 0.02 || Math.abs(Math.abs(v) - 1) < 0.02);
}

// 绕世界轴任意角度旋转矩阵(LDraw 坐标)
export function rotAxis(axis, deg) {
  const t = deg * Math.PI / 180;
  let c = Math.cos(t), s = Math.sin(t);
  if (Math.abs(c) < 1e-12) c = 0; if (Math.abs(s) < 1e-12) s = 0;
  if (Math.abs(Math.abs(c) - 1) < 1e-12) c = Math.sign(c); if (Math.abs(Math.abs(s) - 1) < 1e-12) s = Math.sign(s);
  // 与 ROT_*90 一致的方向约定
  if (axis === 'y') return [c, 0, -s, 0, 1, 0, s, 0, c];
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1]; // z
}

// 将局部 +Y(零件底面朝向)对齐到 -studDir 的姿态
function alignToStud(d) {
  if (d[1] < -0.9) return IDENTITY;        // 柱钉朝上
  if (d[1] > 0.9) return ROT_X180;         // 柱钉朝下(倒挂)
  if (d[0] > 0.9) return ROT_Z90;
  if (d[0] < -0.9) return ROT_ZN90;
  if (d[2] > 0.9) return ROT_XN90;
  if (d[2] < -0.9) return ROT_X90;
  return IDENTITY;
}

export class BrickEditor {
  constructor(container, partLib, callbacks = {}) {
    this.container = container;
    this.partLib = partLib;
    this.cb = callbacks;

    this.mode = 'place';
    this.activePart = '3001';
    this.activeColor = 4;
    this.pendingM = IDENTITY;

    this.bricks = [];
    this.selection = new Set();
    this.multiMode = false;
    this.connectCheck = true;   // 卡扣连接检测开关
    this.dragInvalid = false;
    this._groupSeq = 1;
    this.undoStack = [];
    this.redoStack = [];

    this._initScene();
    this._initInput();
    this._animate();
  }

  // ---------- 场景 ----------
  _initScene() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1e2126);
    this.scene.fog = new THREE.Fog(0x1e2126, 2500, 6000);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 5, 20000);
    this.camera.position.set(420, 420, 620);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 4000;
    this.controls.target.set(0, 30, 0);
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    const hemi = new THREE.HemisphereLight(0xbcc8dd, 0x30343a, 0.5);
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(500, 900, 400);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    const sc = dir.shadow.camera;
    sc.left = -800; sc.right = 800; sc.top = 800; sc.bottom = -800; sc.far = 3000;
    this.scene.add(amb, hemi, dir);

    const groundGeo = new THREE.PlaneGeometry(8000, 8000);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x282c33, roughness: 0.95 });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    const grid = new THREE.GridHelper(1600, 80, 0x3c424c, 0x33383f);
    grid.position.y = 0.5;
    this.scene.add(grid);

    this.root = new THREE.Group();
    this.root.rotation.x = Math.PI;
    this.scene.add(this.root);
    // 实例池(实体渲染)+ 独立边线组(每砖一个 LineSegments,矩阵与实例同步)
    this.pool = new InstancePool(this.root, this.partLib);
    this.edgeGroup = new THREE.Group();
    this.root.add(this.edgeGroup);

    this.ghost = null;
    this.raycaster = new THREE.Raycaster();

    this._resizeObs = new ResizeObserver(() => this._onResize());
    this._resizeObs.observe(this.container);
  }

  _onResize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- 几何工具 ----------
  _ndc(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    );
  }

  _toLDraw(p) { return { x: p.x, y: -p.y, z: -p.z }; }

  _pick(ev, { includeGround = true } = {}) {
    this.raycaster.setFromCamera(this._ndc(ev), this.camera);
    const hit = this.pool.raycast(this.raycaster);
    if (hit) {
      const b = this.bricks.find(x => x.id === hit.brickId);
      if (b) {
        // normalWorld 已含 instanceMatrix 旋转(见 InstancePool.raycast)
        const n = hit.normalWorld;
        return {
          brick: b,
          pointLDraw: this._toLDraw(hit.point),
          normalLDraw: n ? [n.x, -n.y, -n.z] : null,
        };
      }
    }
    if (includeGround) {
      const gh = this.raycaster.intersectObject(this.ground, false);
      if (gh.length) return { ground: true, pointLDraw: this._toLDraw(gh[0].point) };
    }
    return null;
  }

  // 变换后的本体盒(相对原点)
  _relBody(info, m) {
    const b = info.body;
    const xs = [b.minX, b.maxX], ys = [b.minY, b.maxY], zs = [b.minZ, b.maxZ];
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const x of xs) for (const y of ys) for (const z of zs) {
      const [px, py, pz] = apply3(m, x, y, z);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  _worldBody(b) {
    const r = this._relBody(b.info, b.m);
    return {
      x0: b.x + r.minX, x1: b.x + r.maxX,
      y0: b.y + r.minY, y1: b.y + r.maxY,
      z0: b.z + r.minZ, z1: b.z + r.maxZ,
    };
  }

  _worldStuds(b) {
    const out = [];
    for (const s of b.info.studs) {
      const [px, py, pz] = apply3(b.m, s.x, s.y, s.z);
      const [dx, dy, dz] = apply3(b.m, s.dx, s.dy, s.dz);
      out.push({ x: b.x + px, y: b.y + py, z: b.z + pz, dx, dy, dz });
    }
    return out;
  }

  _worldCells(rec) {
    const out = [];
    const n = apply3(rec.m, 0, 1, 0); // 底面外法向(局部 +Y)
    for (const c of rec.info.cells) {
      const [px, py, pz] = apply3(rec.m, c.x, c.y, c.z);
      out.push({ x: rec.x + px, y: rec.y + py, z: rec.z + pz });
    }
    return { cells: out, normal: n };
  }

  _overlap(a, b, eps = 1) {
    return a.x0 + eps < b.x1 && b.x0 + eps < a.x1 &&
           a.z0 + eps < b.z1 && b.z0 + eps < a.z1 &&
           a.y0 + eps < b.y1 && b.y0 + eps < a.y1;
  }

  _overlapXZ(a, b, eps = 1) {
    return a.x0 + eps < b.x1 && b.x0 + eps < a.x1 && a.z0 + eps < b.z1 && b.z0 + eps < a.z1;
  }

  _collides(rec, excludeIds = new Set()) {
    if (!isGridM(rec.m)) return false; // 任意角度姿态:AABB 判定误报多,放宽为自由放置
    const me = this._worldBody(rec);
    for (const b of this.bricks) {
      if (excludeIds.has(b.id)) continue;
      if (!isGridM(b.m)) continue;
      if (this._overlap(me, this._worldBody(b))) return true;
    }
    return false;
  }

  _dropY(info, m, x, z, excludeIds = new Set()) {
    const r = this._relBody(info, m);
    const me = { x0: x + r.minX, x1: x + r.maxX, z0: z + r.minZ, z1: z + r.maxZ };
    let top = 0;
    for (const b of this.bricks) {
      if (excludeIds.has(b.id)) continue;
      const bb = this._worldBody(b);
      if (this._overlapXZ(me, bb)) top = Math.min(top, bb.y0);
    }
    return top - r.maxY;
  }

  // 连接检测:rec 是否被支撑(地面 / 柱钉↔底面格,双向)
  _isSupported(rec, excludeIds = new Set()) {
    if (!this.connectCheck) return true;
    if (!isGridM(rec.m)) return true; // 任意角度姿态按自由放置处理
    const r = this._relBody(rec.info, rec.m);
    if (Math.abs(rec.y + r.maxY) < CONNECT_PLANE_TOL) return true; // 落地
    const { cells, normal } = this._worldCells(rec);
    const myStuds = this._worldStuds(rec);
    const myBox = this._worldBody(rec);
    for (const b of this.bricks) {
      if (excludeIds.has(b.id)) continue;
      const bb = this._worldBody(b);
      // 快速剔除:包围盒相距太远
      if (bb.x0 > myBox.x1 + 8 || bb.x1 < myBox.x0 - 8 ||
          bb.z0 > myBox.z1 + 8 || bb.z1 < myBox.z0 - 8 ||
          bb.y0 > myBox.y1 + 8 || bb.y1 < myBox.y0 - 8) continue;
      // 对方柱钉 -> 我的底面格
      for (const s of this._worldStuds(b)) {
        if (s.dx * normal[0] + s.dy * normal[1] + s.dz * normal[2] > -0.9) continue;
        for (const c of cells) {
          const vx = c.x - s.x, vy = c.y - s.y, vz = c.z - s.z;
          const along = vx * s.dx + vy * s.dy + vz * s.dz;
          if (Math.abs(along) > CONNECT_PLANE_TOL) continue;
          const px = vx - along * s.dx, py = vy - along * s.dy, pz = vz - along * s.dz;
          if (px * px + py * py + pz * pz <= CONNECT_XY_TOL * CONNECT_XY_TOL) return true;
        }
      }
      // 我的柱钉 -> 对方底面格
      const other = this._worldCells(b);
      for (const s of myStuds) {
        if (s.dx * other.normal[0] + s.dy * other.normal[1] + s.dz * other.normal[2] > -0.9) continue;
        for (const c of other.cells) {
          const vx = c.x - s.x, vy = c.y - s.y, vz = c.z - s.z;
          const along = vx * s.dx + vy * s.dy + vz * s.dz;
          if (Math.abs(along) > CONNECT_PLANE_TOL) continue;
          const px = vx - along * s.dx, py = vy - along * s.dy, pz = vz - along * s.dz;
          if (px * px + py * py + pz * pz <= CONNECT_XY_TOL * CONNECT_XY_TOL) return true;
        }
      }
    }
    return false;
  }

  // Studio 式连接吸附:在指针点 P 附近搜索柱钉,把零件底面格对齐上去。
  // 返回 {x,y,z} 或 null(附近无可用连接)。姿态 m 保持不变。
  _connectionSnap(info, m, P, excludeIds = new Set(), radius = 42) {
    if (!isGridM(m) || !this.connectCheck) return null;
    const n = apply3(m, 0, 1, 0); // 底面外法向
    // 缓存 M*cell
    const mc = info.cells.map(c => apply3(m, c.x, c.y, c.z));
    const bc = apply3(m,
      (info.body.minX + info.body.maxX) / 2,
      (info.body.minY + info.body.maxY) / 2,
      (info.body.minZ + info.body.maxZ) / 2);
    const cands = [];
    let studCount = 0;
    for (const b of this.bricks) {
      if (excludeIds.has(b.id)) continue;
      const wb = this._worldBody(b);
      if (wb.x0 > P.x + radius + 20 || wb.x1 < P.x - radius - 20 ||
          wb.z0 > P.z + radius + 20 || wb.z1 < P.z - radius - 20) continue;
      for (const s of this._worldStuds(b)) {
        if (Math.abs(s.x - P.x) > radius || Math.abs(s.z - P.z) > radius || Math.abs(s.y - P.y) > radius) continue;
        if (s.dx * n[0] + s.dy * n[1] + s.dz * n[2] > -0.9) continue; // 方向不相对
        if (++studCount > 48) break;
        // 该柱钉下最优的底面格
        let best = null;
        for (const c of mc) {
          const tx = s.x - c[0], ty = s.y - c[1], tz = s.z - c[2];
          const cx2 = tx + bc[0] - P.x, cy2 = ty + bc[1] - P.y, cz2 = tz + bc[2] - P.z;
          const d = cx2 * cx2 + cy2 * cy2 + cz2 * cz2;
          if (!best || d < best.d) best = { d, x: tx, y: ty, z: tz };
        }
        if (best) cands.push(best);
      }
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 8)) {
      const rec = { info, m, x: round3(c.x), y: round3(c.y), z: round3(c.z) };
      if (!this._collides(rec, excludeIds)) return { x: rec.x, y: rec.y, z: rec.z };
    }
    return null;
  }

  // 指针拾取表面点(排除指定零件),用于拖动跟随表面
  _pickSurface(ev, excludeIds = new Set()) {
    this.raycaster.setFromCamera(this._ndc(ev), this.camera);
    const hit = this.pool.raycast(this.raycaster, excludeIds);
    if (hit) return this._toLDraw(hit.point);
    const gh = this.raycaster.intersectObject(this.ground, false);
    if (gh.length) return this._toLDraw(gh[0].point);
    return null;
  }

  // ---------- 输入 ----------
  _initInput() {
    const el = this.renderer.domElement;
    this._ptr = null;
    el.addEventListener('pointerdown', e => this._onDown(e));
    el.addEventListener('pointermove', e => this._onMove(e));
    el.addEventListener('pointerup', e => this._onUp(e));
    el.addEventListener('pointercancel', () => { this._ptr = null; this._clearLongPress(); this._endDrag(false); });
    // 桌面右键:直接选中零件(免切模式)
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      this._quickSelect(e);
    });
  }

  // 快速选中:切到选择模式并选中指定零件
  _quickSelect(ev) {
    const hit = this._pick(ev, { includeGround: false });
    if (!hit || !hit.brick) return false;
    if (this.mode !== 'select') {
      this.mode = 'select';
      this.cb.onModeSwitch && this.cb.onModeSwitch('select');
    }
    this._selectBrick(hit.brick);
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(25);
    return true;
  }

  _clearLongPress() {
    if (this._lpTimer) { clearTimeout(this._lpTimer); this._lpTimer = null; }
  }

  _onDown(ev) {
    if (!ev.isPrimary) { this._ptr = null; this._clearLongPress(); this._endDrag(false); return; }
    this._ptr = { x: ev.clientX, y: ev.clientY, t: performance.now(), moved: false, dragging: false };
    // 放置/上色/删除模式下,长按零件 = 快速选中(触屏友好)
    this._clearLongPress();
    if (this.mode !== 'select' && ev.pointerType !== 'mouse') {
      const evCopy = { clientX: ev.clientX, clientY: ev.clientY };
      this._lpTimer = setTimeout(() => {
        if (this._ptr && !this._ptr.moved) {
          if (this._quickSelect(evCopy)) this._ptr = null; // 取消本次点按的后续放置
        }
      }, 550);
    }
    if (this.mode === 'select') {
      const hit = this._pick(ev, { includeGround: false });
      if (hit && hit.brick) {
        // 多选模式:只有按在已选零件上才开始拖动(点按新零件走 toggle)
        if (!this.selection.has(hit.brick.id)) {
          if (this.multiMode) return;
          this._selectBrick(hit.brick);
        }
        this._ptr.dragging = true;
        this._dragStarts = new Map();
        for (const id of this.selection) {
          const b = this.bricks.find(x => x.id === id);
          if (b) this._dragStarts.set(id, { x: b.x, y: b.y, z: b.z });
        }
        this._dragPrimary = hit.brick.id;
        this.controls.enabled = false;
      }
    }
  }

  _onMove(ev) {
    if (this._ptr && ev.isPrimary) {
      const dx = ev.clientX - this._ptr.x, dy = ev.clientY - this._ptr.y;
      if (Math.hypot(dx, dy) > TAP_PX) { this._ptr.moved = true; this._clearLongPress(); }
      if (this._ptr.dragging && this.selection.size && this._ptr.moved) {
        this._dragTo(ev);
        return;
      }
    }
    if (!this._ptr && this.mode === 'place' && ev.pointerType === 'mouse') {
      this._updateGhost(ev);
    }
  }

  _dragTo(ev) {
    const prim = this.bricks.find(b => b.id === this._dragPrimary);
    if (!prim) return;
    const start = this._dragStarts.get(prim.id);
    const sel = new Set(this.selection);
    // 沿表面拖动:射线打到其他零件/地面
    let P = this._pickSurface(ev, sel);
    if (!P) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), start.y);
      const pt = new THREE.Vector3();
      this.raycaster.setFromCamera(this._ndc(ev), this.camera);
      if (!this.raycaster.ray.intersectPlane(plane, pt)) return;
      P = this._toLDraw(pt);
    }
    // Studio 式吸附:优先吸到附近柱钉,否则网格+落位
    let target = (this.selection.size === 1) ? this._connectionSnap(prim.info, prim.m, P, sel) : null;
    if (!target) {
      const nx = Math.round(P.x / GRID) * GRID;
      const nz = Math.round(P.z / GRID) * GRID;
      target = { x: nx, z: nz, y: this._dropY(prim.info, prim.m, nx, nz, sel) };
    }
    if (target.x === prim.x && target.z === prim.z && target.y === prim.y) return;
    const dx = target.x - start.x, dy = target.y - start.y, dz = target.z - start.z;
    for (const id of sel) {
      const b = this.bricks.find(x => x.id === id);
      const s = this._dragStarts.get(id);
      if (!b || !s) continue;
      b.x = s.x + dx; b.y = s.y + dy; b.z = s.z + dz;
      this._applyTransform(b);
    }
    // 实时有效性着色
    const bad = [...sel].some(id => {
      const b = this.bricks.find(x => x.id === id);
      return b && this._collides(b, sel);
    });
    const supported = [...sel].some(id => {
      const b = this.bricks.find(x => x.id === id);
      return b && this._isSupported(b, sel);
    });
    const invalid = bad || !supported;
    if (invalid !== this.dragInvalid) {
      this.dragInvalid = invalid;
      this._refreshHighlight();
    }
  }

  _onUp(ev) {
    this._clearLongPress();
    const p = this._ptr;
    this._ptr = null;
    if (!p) return;
    const isTap = !p.moved && (performance.now() - p.t) < TAP_MS;
    if (p.dragging) { this._endDrag(p.moved); if (!isTap) return; }
    if (!isTap) return;

    if (this.mode === 'place') {
      const hit = this._pick(ev);
      if (hit) this.placeFromHit(hit);
    } else if (this.mode === 'select') {
      const hit = this._pick(ev, { includeGround: false });
      if (!hit) { if (!this.multiMode) this._clearSelection(); return; }
      if (this.multiMode) this._toggleSelect(hit.brick);
      else this._selectBrick(hit.brick);
    } else if (this.mode === 'paint') {
      const hit = this._pick(ev, { includeGround: false });
      if (hit && hit.brick && hit.brick.colorCode !== this.activeColor) {
        this._snapshot();
        hit.brick.colorCode = this.activeColor;
        this._applyColor(hit.brick);
        this._notify();
      }
    } else if (this.mode === 'erase') {
      const hit = this._pick(ev, { includeGround: false });
      if (hit && hit.brick) this.deleteBricks([hit.brick.id]);
    }
  }

  _endDrag(commit) {
    this.controls.enabled = true;
    if (this.dragInvalid) { this.dragInvalid = false; this._refreshHighlight(); }
    if (commit && this.selection.size && this._dragStarts) {
      const moved = [...this.selection].some(id => {
        const b = this.bricks.find(x => x.id === id), s = this._dragStarts.get(id);
        return b && s && (b.x !== s.x || b.y !== s.y || b.z !== s.z);
      });
      if (moved) {
        // 校验:碰撞或完全失去支撑则回退
        const sel = new Set(this.selection);
        const bad = [...sel].some(id => {
          const b = this.bricks.find(x => x.id === id);
          return b && this._collides(b, sel);
        });
        const supported = [...sel].some(id => {
          const b = this.bricks.find(x => x.id === id);
          return b && this._isSupported(b, sel);
        });
        if (bad || !supported) {
          for (const id of sel) {
            const b = this.bricks.find(x => x.id === id), s = this._dragStarts.get(id);
            if (b && s) { b.x = s.x; b.y = s.y; b.z = s.z; this._applyTransform(b); }
          }
          this.cb.onError && this.cb.onError(bad ? '与其他零件重叠,已还原' : '目标位置没有支撑,已还原');
        } else {
          // 记入撤销栈:临时还原 -> 快照 -> 应用
          const now = new Map();
          for (const id of sel) {
            const b = this.bricks.find(x => x.id === id);
            now.set(id, { x: b.x, y: b.y, z: b.z });
            const s = this._dragStarts.get(id);
            b.x = s.x; b.y = s.y; b.z = s.z;
          }
          this._snapshot();
          for (const id of sel) {
            const b = this.bricks.find(x => x.id === id);
            const n = now.get(id);
            b.x = n.x; b.y = n.y; b.z = n.z;
            this._applyTransform(b);
          }
          this._notify();
        }
      }
    }
    this._dragStarts = null;
  }

  async _updateGhost(ev) {
    const hit = this._pick(ev);
    if (!hit) { if (this.ghost) this.ghost.visible = false; return; }
    const key = `${this.activePart}/${this.pendingM.join(',')}`;
    if (!this.ghost || this.ghost.userData.key !== key) {
      if (this.ghost) { this.root.remove(this.ghost); this.ghost = null; }
      try {
        const { object } = await this.partLib.instantiate(this.activePart, this.activeColor);
        const mat = new THREE.MeshStandardMaterial({ color: 0x7fdc7f, transparent: true, opacity: 0.45, depthWrite: false });
        object.traverse(c => { if (c.isMesh) c.material = mat; if (c.isLineSegments) c.visible = false; });
        object.userData.key = key;
        this.ghost = object;
        this.root.add(this.ghost);
      } catch { return; }
    }
    const info = await this.partLib.loadPart(this.activePart);
    let t = this._connectionSnap(info, this.pendingM, hit.pointLDraw);
    if (!t) {
      const x = Math.round(hit.pointLDraw.x / GRID) * GRID;
      const z = Math.round(hit.pointLDraw.z / GRID) * GRID;
      t = { x, z, y: this._dropY(info, this.pendingM, x, z) };
    }
    const rec = { info, m: this.pendingM, ...t };
    const ok = this._isSupported(rec) && !this._collides(rec);
    this.ghost.traverse(c => { if (c.isMesh) c.material.color.setHex(ok ? 0x7fdc7f : 0xff5555); });
    this.ghost.visible = true;
    this._setMatrix(this.ghost, this.pendingM, t.x, t.y, t.z);
  }

  _setMatrix(obj, m, x, y, z) {
    obj.matrixAutoUpdate = false;
    obj.matrix.set(
      m[0], m[1], m[2], x,
      m[3], m[4], m[5], y,
      m[6], m[7], m[8], z,
      0, 0, 0, 1
    );
    obj.matrixWorldNeedsUpdate = true;
  }

  // ---------- 放置 ----------
  async placeFromHit(hit) {
    try {
      const info = await this.partLib.loadPart(this.activePart);
      // 侧向柱钉吸附:点击侧面且附近有朝外柱钉
      if (hit.brick && hit.normalLDraw && Math.abs(hit.normalLDraw[1]) < 0.5) {
        const n = hit.normalLDraw;
        const p = hit.pointLDraw;
        let best = null;
        for (const s of this._worldStuds(hit.brick)) {
          if (s.dx * n[0] + s.dy * n[1] + s.dz * n[2] < 0.9) continue;
          const d = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z);
          if (d < 22 && (!best || d < best.d)) best = { s, d };
        }
        if (best) { await this._placeOnStud(info, best.s); return; }
      }
      // 常规:网格吸附 + 重力落位;若格心与柱钉错位,自动在 ±10 内微调
      const bx = Math.round(hit.pointLDraw.x / GRID) * GRID;
      const bz = Math.round(hit.pointLDraw.z / GRID) * GRID;
      const cand = [];
      for (const dx of [0, -10, 10]) for (const dz of [0, -10, 10]) cand.push([bx + dx, bz + dz]);
      cand.sort((a, b) =>
        Math.hypot(a[0] - hit.pointLDraw.x, a[1] - hit.pointLDraw.z) -
        Math.hypot(b[0] - hit.pointLDraw.x, b[1] - hit.pointLDraw.z));
      let firstProblem = null;
      for (const [x, z] of cand) {
        const y = this._dropY(info, this.pendingM, x, z);
        const rec = {
          id: newBrickId(), partId: this.activePart, colorCode: this.activeColor,
          x, y, z, m: this.pendingM, group: null, info,
        };
        const supported = this._isSupported(rec);
        const collide = supported ? this._collides(rec) : true;
        if (supported && !collide) {
          this._snapshot();
          await this._addBrick(rec);
          this._notify();
          return;
        }
        if (!firstProblem) firstProblem = supported ? 'collide' : 'unsupported';
      }
      this.cb.onError && this.cb.onError(firstProblem === 'collide'
        ? '位置冲突,无法放置'
        : '无法固定:下方没有柱钉(光板顶面不能拼接)');
    } catch (e) {
      console.error('放置失败', e);
      this.cb.onError && this.cb.onError(`零件 ${this.activePart} 加载失败`);
    }
  }

  // 吸附到指定柱钉(侧向拼接核心)
  async _placeOnStud(info, stud) {
    const dir = [stud.dx, stud.dy, stud.dz];
    const A = alignToStud(dir);
    const m = mul3(A, this.pendingM);
    // 选离局部原点最近的底面格对准柱钉
    const cells = [...info.cells].sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
    for (const c of cells) {
      const [cx, cy, cz] = apply3(m, c.x, c.y, c.z);
      const rec = {
        id: newBrickId(), partId: this.activePart, colorCode: this.activeColor,
        x: stud.x - cx, y: stud.y - cy, z: stud.z - cz,
        m, group: null, info,
      };
      if (!this._collides(rec)) {
        this._snapshot();
        await this._addBrick(rec);
        this._notify();
        return;
      }
    }
    this.cb.onError && this.cb.onError('柱钉周围空间不足,无法拼接');
  }

  async _addBrick(rec) {
    if (!rec.info) rec.info = await this.partLib.loadPart(rec.partId);
    if (!rec.m) rec.m = IDENTITY;
    rec.object = undefined; // 不再持有克隆 Group
    rec.handle = this.pool.add(rec.id, rec.partId, rec.colorCode, rec.info.solidGeo);
    if (rec.info.edgeGeo) {
      const e = new THREE.LineSegments(rec.info.edgeGeo, this.partLib.getMaterials(rec.colorCode).edge);
      e.matrixAutoUpdate = false;
      rec.edgeObj = e;
      this.edgeGroup.add(e);
    } else {
      rec.edgeObj = null;
    }
    this._applyTransform(rec);
    if (this._visFilter && !this._visFilter(rec)) {
      this.pool.setVisible(rec.handle, false);
      if (rec.edgeObj) rec.edgeObj.visible = false;
    }
    this.bricks.push(rec);
    this._updateEdgeGroupVisible();
    return rec;
  }

  // 边线总开关:数量超过 EDGE_LIMIT 或高性能模式时整组隐藏
  _updateEdgeGroupVisible() {
    this.edgeGroup.visible = !this.perfMode && this.bricks.length <= EDGE_LIMIT;
  }

  _applyTransform(b) {
    this.pool.setMatrix(b.handle, b.m, b.x, b.y, b.z);
    if (b.edgeObj) this._setMatrix(b.edgeObj, b.m, b.x, b.y, b.z);
    if (b._selSeg) {                       // 选中描边跟随移动
      b._selSeg.matrix.copy(b.handle.mat);
      b._selSeg.matrixWorldNeedsUpdate = true;
    }
  }

  _applyColor(b) {
    // 换色 = 从旧颜色池移除,加入新颜色池(保持矩阵/可见性/高亮)
    const wasVisible = b.handle.visible;
    this.pool.remove(b.handle);
    b.handle = this.pool.add(b.id, b.partId, b.colorCode, b.info.solidGeo);
    this.pool.setMatrix(b.handle, b.m, b.x, b.y, b.z);
    if (!wasVisible) this.pool.setVisible(b.handle, false);
    if (b.edgeObj) b.edgeObj.material = this.partLib.getMaterials(b.colorCode).edge;
    this._refreshHighlight();
  }

  // ---------- 选择 ----------
  _selectBrick(b) {
    this.selection.clear();
    this._primaryId = b ? b.id : null;
    if (b) {
      if (b.group != null) {
        for (const x of this.bricks) if (x.group === b.group) this.selection.add(x.id);
      } else {
        this.selection.add(b.id);
      }
    }
    this._afterSelectionChange();
  }

  _toggleSelect(b) {
    const ids = b.group != null
      ? this.bricks.filter(x => x.group === b.group).map(x => x.id)
      : [b.id];
    const allIn = ids.every(id => this.selection.has(id));
    for (const id of ids) {
      if (allIn) this.selection.delete(id); else this.selection.add(id);
    }
    if (!allIn) this._primaryId = b.id;
    this._afterSelectionChange();
  }

  _clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this._afterSelectionChange();
  }

  clearSelection() { this._clearSelection(); }

  // a 的柱钉是否扣住 b 的底面格(方向性:a 支撑 b)
  _pairConnected(a, b) {
    const { cells, normal } = this._worldCells(b);
    for (const s of this._worldStuds(a)) {
      if (s.dx * normal[0] + s.dy * normal[1] + s.dz * normal[2] > -0.9) continue;
      for (const c of cells) {
        const vx = c.x - s.x, vy = c.y - s.y, vz = c.z - s.z;
        const along = vx * s.dx + vy * s.dy + vz * s.dz;
        if (Math.abs(along) > CONNECT_PLANE_TOL) continue;
        const px = vx - along * s.dx, py = vy - along * s.dy, pz = vz - along * s.dz;
        if (px * px + py * py + pz * pz <= CONNECT_XY_TOL * CONNECT_XY_TOL) return true;
      }
    }
    return false;
  }

  // 连带选择:把"扣在当前选中零件上方"的零件(递归)全部并入选择
  selectConnectedAbove() {
    if (!this.selection.size) return 0;
    const inSet = new Set(this.selection);
    let frontier = this.bricks.filter(b => inSet.has(b.id));
    let added = 0;
    while (frontier.length) {
      const next = [];
      for (const cand of this.bricks) {
        if (inSet.has(cand.id)) continue;
        // 快速包围盒预筛
        const cb = this._worldBody(cand);
        for (const base of frontier) {
          const bb = this._worldBody(base);
          if (cb.x0 > bb.x1 + 8 || cb.x1 < bb.x0 - 8 ||
              cb.z0 > bb.z1 + 8 || cb.z1 < bb.z0 - 8 ||
              cb.y0 > bb.y1 + 8 || cb.y1 < bb.y0 - 8) continue;
          if (this._pairConnected(base, cand)) {
            inSet.add(cand.id);
            next.push(cand);
            added++;
            break;
          }
        }
      }
      frontier = next;
    }
    this.selection = inSet;
    this._afterSelectionChange();
    return added;
  }

  setMultiMode(v) {
    this.multiMode = !!v;
    this._afterSelectionChange();
  }

  _afterSelectionChange() {
    this._refreshHighlight();
    if (this.cb.onSelect) {
      const sel = this.bricks.filter(b => this.selection.has(b.id));
      this.cb.onSelect(sel.length ? {
        count: sel.length,
        partId: sel.length === 1 ? sel[0].partId : null,
        colorCode: sel[0].colorCode,
        grouped: sel.length > 1 && sel.every(b => b.group != null && b.group === sel[0].group),
      } : null);
    }
  }

  _refreshHighlight() {
    const selTint = this.dragInvalid ? TINT_INVALID : TINT_SELECT;
    for (const b of this.bricks) {
      const t = this.selection.has(b.id) ? selTint : TINT_NONE;
      this.pool.setTint(b.handle, t[0], t[1], t[2]);
    }
    this._refreshSelOutline();
  }

  // 选中轮廓叠加:instanceColor 是乘法着色,在饱和色(如纯红)上蓝色调根本提不亮,
  // 所以选中反馈以"永远可见的高亮描边"为主(depthTest=false,任何底色都清晰)。
  _refreshSelOutline() {
    if (!this.selGroup) {
      this.selGroup = new THREE.Group();
      this.selGroup.renderOrder = 999;
      this.root.add(this.selGroup);
      this._selMatSel = new THREE.LineBasicMaterial({
        color: 0x4da3ff, depthTest: false, transparent: true, opacity: 0.95,
      });
      this._selMatBad = new THREE.LineBasicMaterial({
        color: 0xff4d4d, depthTest: false, transparent: true, opacity: 0.95,
      });
    }
    // 清空旧描边(选中数通常很少,直接重建最简单可靠;共享的 edgeGeo 不能 dispose)
    for (const c of this.selGroup.children) {
      if (c.userData.ownGeo) c.geometry.dispose();
    }
    this.selGroup.clear();
    for (const b of this.bricks) b._selSeg = null;
    if (!this.selection.size) return;
    const mat = this.dragInvalid ? this._selMatBad : this._selMatSel;
    for (const b of this.bricks) {
      if (!this.selection.has(b.id)) continue;
      if (!b.handle || !b.handle.visible) continue;
      const geo = b.info?.edgeGeo || b.info?.solidGeo;
      if (!geo) continue;
      const seg = b.info.edgeGeo
        ? new THREE.LineSegments(geo, mat)
        : new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
      if (!b.info.edgeGeo) seg.userData.ownGeo = true;
      seg.matrixAutoUpdate = false;
      seg.matrix.copy(b.handle.mat);
      seg.matrixWorldNeedsUpdate = true;
      seg.renderOrder = 999;
      seg.frustumCulled = false;
      b._selSeg = seg;              // 供拖动时同步矩阵
      this.selGroup.add(seg);
    }
  }

  _selectedBricks() { return this.bricks.filter(b => this.selection.has(b.id)); }

  // ---------- 编辑操作 ----------
  deleteBricks(ids) {
    this._snapshot();
    const set = new Set(ids);
    for (const b of this.bricks) {
      if (set.has(b.id)) {
        this.pool.remove(b.handle);
        if (b.edgeObj) this.edgeGroup.remove(b.edgeObj);
      }
    }
    this.bricks = this.bricks.filter(b => !set.has(b.id));
    this._updateEdgeGroupVisible();
    for (const id of set) this.selection.delete(id);
    this._afterSelectionChange();
    this._notify();
  }

  deleteSelected() { if (this.selection.size) this.deleteBricks([...this.selection]); }

  _transformSelected(R, pivotMode = 'centroid') {
    const sel = this._selectedBricks();
    if (!sel.length) return;
    this._snapshot();
    let cx, cy, cz;
    if (pivotMode === 'primary') {
      // 铰链式:绕基准件(最后点选的零件)原点旋转,不重力落位
      const prim = sel.find(b => b.id === this._primaryId) || sel[0];
      cx = prim.x; cy = prim.y; cz = prim.z;
    } else {
      // 组中心(吸附到 10 网格)
      cx = 0; cz = 0;
      for (const b of sel) { cx += b.x; cz += b.z; }
      cx = Math.round(cx / sel.length / GRID) * GRID;
      cz = Math.round(cz / sel.length / GRID) * GRID;
      cy = Math.max(...sel.map(b => b.y + this._relBody(b.info, b.m).maxY)); // 组底面
    }
    for (const b of sel) {
      const [ox, oy, oz] = [b.x - cx, b.y - cy, b.z - cz];
      const [nx, ny, nz] = apply3(R, ox, oy, oz);
      b.x = round3(cx + nx); b.y = round3(cy + ny); b.z = round3(cz + nz);
      b.m = mul3(R, b.m).map(round3);
    }
    if (pivotMode === 'primary') {
      for (const b of sel) this._applyTransform(b);
      this._notify();
      return;
    }
    // 整组重新落位:让组内最低点落到支撑面
    const selSet = new Set(this.selection);
    let groupBottom = -1e9, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const b of sel) {
      const wb = this._worldBody(b);
      groupBottom = Math.max(groupBottom, wb.y1);
      minX = Math.min(minX, wb.x0); maxX = Math.max(maxX, wb.x1);
      minZ = Math.min(minZ, wb.z0); maxZ = Math.max(maxZ, wb.z1);
    }
    let top = 0;
    const me = { x0: minX, x1: maxX, z0: minZ, z1: maxZ };
    for (const b of this.bricks) {
      if (selSet.has(b.id)) continue;
      const bb = this._worldBody(b);
      if (this._overlapXZ(me, bb)) top = Math.min(top, bb.y0);
    }
    const dy = top - groupBottom;
    for (const b of sel) { b.y += dy; this._applyTransform(b); }
    this._notify();
  }

  rotateSelected() { this._transformSelected(ROT_Y90); }
  flipSelected() { this._transformSelected(ROT_X90); }

  // 任意角度旋转(轴 'x'|'y'|'z',角度制;local=true 绕基准件自身轴;pivotMode 'centroid'|'primary')
  rotateSelectedBy(axis, deg, local = false, pivotMode = 'centroid') {
    if (!deg) return;
    let R = rotAxis(axis, deg);
    if (local) {
      const sel = this._selectedBricks();
      const first = sel.find(b => b.id === this._primaryId) || sel[0];
      if (first) {
        const m0 = first.m;
        const mT = [m0[0], m0[3], m0[6], m0[1], m0[4], m0[7], m0[2], m0[5], m0[8]]; // 正交矩阵转置=逆
        R = mul3(mul3(m0, R), mT).map(round3);
      }
    }
    this._transformSelected(R, pivotMode);
  }
  rotatePendingBy(axis, deg, local = false) {
    if (!deg) return;
    const R = rotAxis(axis, deg);
    this.pendingM = (local ? mul3(this.pendingM, R) : mul3(R, this.pendingM)).map(round3);
    if (this.ghost) { this.root.remove(this.ghost); this.ghost = null; }
  }

  setConnectCheck(v) { this.connectCheck = !!v; }

  // 导出当前视图 PNG
  exportImage() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // 高性能模式:关阴影 + 隐藏边线(大模型流畅度显著提升)
  setPerfMode(v) {
    this.perfMode = !!v;
    this.renderer.shadowMap.enabled = !this.perfMode;
    this.scene.traverse(o => {
      if (o.isDirectionalLight) o.castShadow = !this.perfMode;
    });
    this._updateEdgeGroupVisible();
    for (const { mesh } of this.partLib.materials.values()) mesh.needsUpdate = true;
    // three 需要重编译阴影材质
    this.renderer.shadowMap.needsUpdate = true;
  }

  // 步骤预览:fn(brick)=>bool 决定可见;null 恢复全部
  setVisibleFilter(fn) {
    this._visFilter = fn;
    for (const b of this.bricks) {
      const vis = fn ? !!fn(b) : true;
      this.pool.setVisible(b.handle, vis);
      if (b.edgeObj) b.edgeObj.visible = vis;
    }
    this._refreshSelOutline(); // 隐藏的零件不应留下描边
  }

  // 兼容/调试:零件的世界坐标(场景坐标系,含 LDraw 翻转)
  getBrickWorldPos(id) {
    const b = this.bricks.find(x => x.id === id);
    if (!b) return null;
    this.root.updateWorldMatrix(true, false);
    const v = new THREE.Vector3(b.x, b.y, b.z).applyMatrix4(this.root.matrixWorld);
    return { x: v.x, y: v.y, z: v.z };
  }

  // 兼容/调试:零件实体是否可见(步骤预览过滤后的状态)
  isBrickVisible(id) {
    const b = this.bricks.find(x => x.id === id);
    return b ? !!(b.handle && b.handle.visible) : false;
  }

  // 兼容/调试:零件边线当前是否实际可见(含 perfMode / EDGE_LIMIT 总开关)
  isBrickEdgeVisible(id) {
    const b = this.bricks.find(x => x.id === id);
    return !!(b && b.edgeObj && b.edgeObj.visible && this.edgeGroup.visible);
  }

  // 全部零件的世界包围盒(含隐藏零件,与旧 Box3.setFromObject(brickGroup) 语义一致)
  _worldBox() {
    const local = this.pool.boundingBox();
    if (local.isEmpty()) return null;
    this.root.updateWorldMatrix(true, false);
    return local.applyMatrix4(this.root.matrixWorld);
  }

  // 快捷视角
  setView(kind) {
    const box = (this.bricks.length && this._worldBox())
      || new THREE.Box3(new THREE.Vector3(-100, 0, -100), new THREE.Vector3(100, 100, 100));
    const c = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 200);
    const d = size * 1.4;
    const pos = {
      top:   [c.x, c.y + d, c.z + 0.01],
      front: [c.x, c.y + d * 0.1, c.z + d],
      side:  [c.x + d, c.y + d * 0.1, c.z],
      iso:   [c.x + d * 0.62, c.y + d * 0.55, c.z + d * 0.62],
    }[kind] || [c.x + d * 0.62, c.y + d * 0.55, c.z + d * 0.62];
    this.controls.target.copy(c);
    this.camera.position.set(...pos);
  }

  async duplicateSelected() {
    const sel = this._selectedBricks();
    if (!sel.length) return;
    this._snapshot();
    const gid = sel.length > 1 ? `g${this._groupSeq++}` : null;
    const created = [];
    for (const b of sel) {
      const rec = {
        id: newBrickId(), partId: b.partId, colorCode: b.colorCode,
        x: b.x + 20, y: b.y, z: b.z + 20, m: [...b.m],
        group: b.group != null ? gid : null, info: b.info,
      };
      await this._addBrick(rec);
      created.push(rec.id);
    }
    this.selection = new Set(created);
    this._afterSelectionChange();
    this._notify();
  }

  recolorSelected(code) {
    const sel = this._selectedBricks();
    if (!sel.length) return;
    this._snapshot();
    for (const b of sel) {
      b.colorCode = code;
      this._applyColor(b);
    }
    this._notify();
  }

  groupSelected() {
    const sel = this._selectedBricks();
    if (sel.length < 2) return;
    this._snapshot();
    const gid = `g${this._groupSeq++}`;
    for (const b of sel) b.group = gid;
    this._afterSelectionChange();
    this._notify();
  }

  ungroupSelected() {
    const sel = this._selectedBricks();
    this._snapshot();
    for (const b of sel) b.group = null;
    this._afterSelectionChange();
    this._notify();
  }

  rotatePending() { this.pendingM = mul3(ROT_Y90, this.pendingM); }
  flipPending() { this.pendingM = mul3(ROT_X90, this.pendingM); }

  setMode(m) {
    this.mode = m;
    if (m !== 'select') this._clearSelection();
    if (this.ghost) this.ghost.visible = false;
  }
  setActivePart(id) {
    this.activePart = String(id).toLowerCase();
    this.pendingM = IDENTITY;
    if (this.ghost) { this.root.remove(this.ghost); this.ghost = null; }
  }
  setActiveColor(code) {
    this.activeColor = code;
    if (this.mode === 'select' && this.selection.size) this.recolorSelected(code);
    if (this.ghost) { this.root.remove(this.ghost); this.ghost = null; }
  }

  // ---------- 撤销/重做 ----------
  _serialize() {
    return this.bricks.map(b => ({
      id: b.id, partId: b.partId, colorCode: b.colorCode,
      x: b.x, y: b.y, z: b.z, m: [...b.m], group: b.group, step: b.step,
    }));
  }

  _snapshot() {
    this.undoStack.push(this._serialize());
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack = [];
    this._notifyHistory();
  }

  _clearSceneObjects() {
    this.pool.clear();
    this.edgeGroup.clear();
  }

  async _restore(list) {
    this._clearSceneObjects();
    this.bricks = [];
    this.selection.clear();
    this._afterSelectionChange();
    for (const rec of list) {
      try { await this._addBrick({ ...rec, m: [...(rec.m || IDENTITY)], info: null }); }
      catch (e) { console.warn('还原零件失败', rec.partId, e); }
    }
    this._notify();
  }

  async undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._serialize());
    await this._restore(this.undoStack.pop());
    this._notifyHistory();
  }

  async redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._serialize());
    await this._restore(this.redoStack.pop());
    this._notifyHistory();
  }

  _notifyHistory() {
    this.cb.onHistory && this.cb.onHistory({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  _notify() {
    this.cb.onChange && this.cb.onChange({ count: this.bricks.length });
  }

  // ---------- 文件 ----------
  getBricks() { return this.bricks; }

  async loadBricks(list) {
    this._snapshot();
    this._clearSceneObjects();
    this.bricks = [];
    this.selection.clear();
    this._afterSelectionChange();
    const gen = (this._loadGen = (this._loadGen || 0) + 1);
    const failed = [];
    for (const rec of list) {
      if (this._loadGen !== gen) return failed; // 加载途中被新建/再次打开打断,停止追加
      try { await this._addBrick({ ...rec, m: [...(rec.m || IDENTITY)], info: null }); }
      catch { failed.push(rec.partId); }
    }
    this._notify();
    this.fitCamera();
    return [...new Set(failed)];
  }

  async clearAll() {
    this._loadGen = (this._loadGen || 0) + 1; // 打断进行中的 loadBricks
    if (!this.bricks.length) return;
    this._snapshot();
    this._clearSceneObjects();
    this.bricks = [];
    this.selection.clear();
    this._afterSelectionChange();
    this._notify();
  }

  fitCamera() {
    if (!this.bricks.length) return;
    const worldBox = this._worldBox();
    if (!worldBox) return;
    const center = worldBox.getCenter(new THREE.Vector3());
    const size = worldBox.getSize(new THREE.Vector3()).length() || 200;
    this.controls.target.copy(center);
    const d = Math.max(size * 1.2, 200);
    this.camera.position.set(center.x + d * 0.7, center.y + d * 0.6, center.z + d * 0.7);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}
