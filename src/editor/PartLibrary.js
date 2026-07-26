// 零件几何库 v2:LDrawLoader 加载 + 材质缓存 + 缩略图队列 +
// 连接元数据(柱钉列表、本体碰撞盒、底面反柱钉格)。
import * as THREE from 'three';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/examples/jsm/materials/LDrawConditionalLineMaterial.js';
import { colorByCode } from '../colors.js';
import { partFile, partStuds } from '../parts-catalog.js';

const EDGE_DARKEN = 0.45;

// 单文件离线版:__LDRAW_GZ_B64(压缩)或 __LDRAW_FILES(明文)内嵌零件库
let _offlineInstalled = false;
function installOfflineFS() {
  if (_offlineInstalled || typeof window === 'undefined' || !window.__LDRAW_FILES) return;
  _offlineInstalled = true;
  const files = {};
  for (const [k, v] of Object.entries(window.__LDRAW_FILES)) {
    files[k.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '')] = v;
  }
  const origLoad = THREE.FileLoader.prototype.load;
  THREE.FileLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    // FileLoader 在 load() 内部才拼接 this.path 前缀,这里要一并算上
    const full = String(this.path || '') + String(url);
    const key = full.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
    if (key in files) {
      setTimeout(() => onLoad && onLoad(files[key]), 0);
      return;
    }
    if (key.includes('ldraw/')) {
      setTimeout(() => onError && onError(new Error(`not embedded: ${key}`)), 0);
      return;
    }
    return origLoad.call(this, url, onLoad, onProgress, onError);
  };
}

async function gunzipB64(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

export class PartLibrary {
  constructor(basePath = './') {
    this.basePath = basePath;
    this.loader = new LDrawLoader();
    this.loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
    this.loader.setPartsLibraryPath(basePath + 'ldraw/');
    this.loader.smoothNormals = true;
    this.cache = new Map();
    this.materials = new Map();
    this.thumbs = new Map();
    this._thumbRenderer = null;
    this._thumbQueue = Promise.resolve();
  }

  async init() {
    if (typeof window !== 'undefined' && window.__LDRAW_GZ_B64 && !window.__LDRAW_FILES) {
      try {
        window.__LDRAW_FILES = JSON.parse(await gunzipB64(window.__LDRAW_GZ_B64));
        window.__LDRAW_GZ_B64 = null;
      } catch (e) {
        console.error('内嵌零件库解压失败', e);
      }
    }
    installOfflineFS();
    try {
      await this.loader.preloadMaterials(this.basePath + 'ldraw/LDConfig.ldr');
    } catch (e) {
      console.warn('LDConfig.ldr 加载失败,使用内置颜色表', e);
    }
  }

  getMaterials(colorCode) {
    if (this.materials.has(colorCode)) return this.materials.get(colorCode);
    const c = colorByCode(colorCode);
    const color = new THREE.Color(c.hex);
    const transparent = (c.alpha !== undefined && c.alpha < 1);
    let roughness = transparent ? 0.15 : 0.45, metalness = 0.0;
    if (c.fin === 'chrome') { roughness = 0.08; metalness = 0.95; }
    else if (c.fin === 'metal') { roughness = 0.28; metalness = 0.85; }
    else if (c.fin === 'pearl') { roughness = 0.3; metalness = 0.35; }
    const mesh = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      transparent,
      opacity: transparent ? c.alpha : 1.0,
      depthWrite: !transparent,
    });
    const edgeColor = color.clone().multiplyScalar(EDGE_DARKEN);
    if (colorCode === 0) edgeColor.setHex(0x4a4a4a);
    const edge = new THREE.LineBasicMaterial({ color: edgeColor });
    const pair = { mesh, edge };
    this.materials.set(colorCode, pair);
    return pair;
  }

  loadPart(partId) {
    partId = String(partId).toLowerCase();
    if (this.cache.has(partId)) return this.cache.get(partId);
    const p = (async () => {
      const group = await this.loader.loadAsync(this.basePath + partFile(partId));
      const toRemove = [];
      group.traverse(child => {
        if (child.isLineSegments) {
          const m = child.material;
          if (m && (m.isLDrawConditionalLineMaterial || m.name === 'Conditional Material')) toRemove.push(child);
        }
      });
      toRemove.forEach(c => c.parent && c.parent.remove(c));

      // 网格包围盒(零件局部坐标 = LDraw 坐标)
      group.updateMatrixWorld(true);
      const bbox = new THREE.Box3();
      const v = new THREE.Vector3();
      group.traverse(c => {
        if (c.isMesh && c.geometry?.attributes?.position) {
          const pos = c.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld);
            bbox.expandByPoint(v);
          }
        }
      });
      if (bbox.isEmpty()) bbox.set(new THREE.Vector3(-10, -4, -10), new THREE.Vector3(10, 8, 10));

      // 柱钉(pack 时精确提取);本体盒 = 包围盒去掉柱钉凸起
      const studs = partStuds(partId);
      const body = {
        minX: bbox.min.x, maxX: bbox.max.x,
        minY: bbox.min.y, maxY: bbox.max.y,
        minZ: bbox.min.z, maxZ: bbox.max.z,
      };
      // 六个方向只要有柱钉就内缩 4(柱钉不算本体碰撞)
      const shrink = { px: 0, nx: 0, py: 0, ny: 0, pz: 0, nz: 0 };
      for (const s of studs) {
        if (s.dx > 0.9) shrink.px = 4; else if (s.dx < -0.9) shrink.nx = 4;
        if (s.dy > 0.9) shrink.py = 4; else if (s.dy < -0.9) shrink.ny = 4;
        if (s.dz > 0.9) shrink.pz = 4; else if (s.dz < -0.9) shrink.nz = 4;
      }
      body.minX = bbox.min.x + shrink.nx; body.maxX = bbox.max.x - shrink.px;
      body.minY = bbox.min.y + shrink.ny; body.maxY = bbox.max.y - shrink.py;
      body.minZ = bbox.min.z + shrink.nz; body.maxZ = bbox.max.z - shrink.pz;

      // 底面反柱钉格(局部坐标,y = body.maxY,朝 +Y/下)
      const cells = [];
      const cellsAlong = (a0, a1) => {
        const w = a1 - a0;
        if (w < 14) return [(a0 + a1) / 2];
        const out = [];
        for (let c = a0 + 10; c <= a1 - 10 + 0.01; c += 20) out.push(c);
        return out;
      };
      for (const cx of cellsAlong(body.minX, body.maxX))
        for (const cz of cellsAlong(body.minZ, body.maxZ))
          cells.push({ x: cx, y: body.maxY, z: cz });

      return { group, bbox, body, studs, cells };
    })();
    this.cache.set(partId, p);
    p.catch(() => this.cache.delete(partId));
    return p;
  }

  async instantiate(partId, colorCode) {
    const info = await this.loadPart(partId);
    const inst = info.group.clone(true);
    const { mesh, edge } = this.getMaterials(colorCode);
    inst.traverse(child => {
      if (child.isMesh) {
        child.material = mesh;
        child.castShadow = true;
        child.receiveShadow = true;
      } else if (child.isLineSegments) {
        child.material = edge;
      }
    });
    return { object: inst, ...info };
  }

  // 缩略图(队列化,避免并发渲染)
  thumbnail(partId, colorCode = 14) {
    const key = `${partId}/${colorCode}`;
    if (this.thumbs.has(key)) return this.thumbs.get(key);
    const p = this._thumbQueue.then(() => this._renderThumb(partId, colorCode));
    this._thumbQueue = p.catch(() => {});
    this.thumbs.set(key, p);
    p.catch(() => this.thumbs.delete(key));
    return p;
  }

  async _renderThumb(partId, colorCode) {
    const { object } = await this.instantiate(partId, colorCode);
    if (!this._thumbRenderer) {
      this._thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this._thumbRenderer.setSize(96, 96);
      this._thumbScene = new THREE.Scene();
      const amb = new THREE.AmbientLight(0xffffff, 0.9);
      const dir = new THREE.DirectionalLight(0xffffff, 1.6);
      dir.position.set(1, 2, 1.2);
      this._thumbScene.add(amb, dir);
      this._thumbCam = new THREE.PerspectiveCamera(30, 1, 1, 100000);
    }
    const holder = new THREE.Group();
    holder.rotation.x = Math.PI;
    holder.add(object);
    this._thumbScene.add(holder);
    const wb = new THREE.Box3().setFromObject(holder);
    const center = wb.getCenter(new THREE.Vector3());
    const size = wb.getSize(new THREE.Vector3()).length();
    const dist = size * 1.35;
    this._thumbCam.position.set(center.x + dist * 0.62, center.y + dist * 0.5, center.z + dist * 0.62);
    this._thumbCam.lookAt(center);
    this._thumbRenderer.render(this._thumbScene, this._thumbCam);
    const url = this._thumbRenderer.domElement.toDataURL('image/png');
    this._thumbScene.remove(holder);
    return url;
  }
}
