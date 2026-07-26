// InstancedMesh 实例池:每 `${partId}/${colorCode}` 一个 InstancedMesh,
// 大模型下把 每砖一组多 Mesh 的 O(n) draw call 压缩为 O(零件种类×颜色)。
// - 容量按需翻倍增长(重建 InstancedMesh 并保留矩阵/颜色)
// - remove 用 swap-with-last,handle.index 动态维护
// - 选中/无效高亮走 instanceColor 乘法着色(分量可 >1,标准材质不 clamp 浮点属性)
// - setVisible 用零缩放矩阵实现,原矩阵存 handle.mat 供恢复/包围盒
import * as THREE from 'three';

const INITIAL_CAP = 16;
const _im = new THREE.Matrix4();
const _wm = new THREE.Matrix4();
const _box = new THREE.Box3();
const ZERO_M = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);

export class InstancePool {
  constructor(parent, partLib) {
    this.partLib = partLib;
    this.group = new THREE.Group();
    parent.add(this.group);
    this.pools = new Map(); // key -> { key, geo, material, mesh, capacity, count, slots[] }
    this._raycastMeshes = [];
  }

  _getPool(key, colorCode, solidGeo) {
    let p = this.pools.get(key);
    if (!p) {
      p = {
        key,
        geo: solidGeo,
        material: this.partLib.getMaterials(colorCode).mesh,
        mesh: null, capacity: 0, count: 0, slots: [],
      };
      this._grow(p, INITIAL_CAP);
      this.pools.set(key, p);
    }
    return p;
  }

  _grow(p, newCap) {
    const mesh = new THREE.InstancedMesh(p.geo, p.material, newCap);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(newCap * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    if (p.mesh) {
      mesh.instanceMatrix.array.set(p.mesh.instanceMatrix.array.subarray(0, p.count * 16));
      mesh.instanceColor.array.set(p.mesh.instanceColor.array.subarray(0, p.count * 3));
      this.group.remove(p.mesh);
      p.mesh.dispose();
    }
    mesh.count = p.count;
    mesh.userData.poolKey = p.key;
    p.mesh = mesh;
    p.capacity = newCap;
    this.group.add(mesh);
    this._dirty(p);
  }

  _dirty(p) {
    p.mesh.instanceMatrix.needsUpdate = true;
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    // 实例矩阵变化后,包围球/盒失效(用于视锥剔除与射线粗测)
    p.mesh.boundingSphere = null;
    p.mesh.boundingBox = null;
  }

  add(brickId, partId, colorCode, solidGeo) {
    const key = `${partId}/${colorCode}`;
    const p = this._getPool(key, colorCode, solidGeo);
    if (p.count === p.capacity) this._grow(p, p.capacity * 2);
    const index = p.count++;
    p.mesh.count = p.count;
    const handle = {
      key, index, brickId,
      visible: true,
      tintR: 1, tintG: 1, tintB: 1,
      mat: new THREE.Matrix4(), // 原矩阵(隐藏时场景里是零矩阵,这里保真值)
    };
    p.slots[index] = handle;
    p.mesh.instanceMatrix.array.set(handle.mat.elements, index * 16);
    p.mesh.instanceColor.array.set([1, 1, 1], index * 3);
    this._dirty(p);
    return handle;
  }

  remove(handle) {
    const p = this.pools.get(handle.key);
    if (!p || handle.index < 0 || p.slots[handle.index] !== handle) return;
    const last = p.count - 1;
    if (handle.index !== last) {
      const moved = p.slots[last];
      p.mesh.instanceMatrix.array.copyWithin(handle.index * 16, last * 16, last * 16 + 16);
      p.mesh.instanceColor.array.copyWithin(handle.index * 3, last * 3, last * 3 + 3);
      p.slots[handle.index] = moved;
      moved.index = handle.index;
    }
    p.slots.length = last;
    p.count = last;
    p.mesh.count = last;
    handle.index = -1;
    this._dirty(p);
  }

  // m: 9 元 LDraw 旋转矩阵,x/y/z 平移
  setMatrix(handle, m, x, y, z) {
    handle.mat.set(
      m[0], m[1], m[2], x,
      m[3], m[4], m[5], y,
      m[6], m[7], m[8], z,
      0, 0, 0, 1
    );
    if (handle.index < 0) return;
    const p = this.pools.get(handle.key);
    if (handle.visible) {
      p.mesh.instanceMatrix.array.set(handle.mat.elements, handle.index * 16);
      this._dirty(p);
    }
  }

  setTint(handle, r, g, b) {
    if (handle.tintR === r && handle.tintG === g && handle.tintB === b) return;
    handle.tintR = r; handle.tintG = g; handle.tintB = b;
    if (handle.index < 0) return;
    const p = this.pools.get(handle.key);
    p.mesh.instanceColor.array.set([r, g, b], handle.index * 3);
    p.mesh.instanceColor.needsUpdate = true;
  }

  setVisible(handle, v) {
    v = !!v;
    if (handle.visible === v) return;
    handle.visible = v;
    if (handle.index < 0) return;
    const p = this.pools.get(handle.key);
    p.mesh.instanceMatrix.array.set((v ? handle.mat : ZERO_M).elements, handle.index * 16);
    this._dirty(p);
  }

  // 射线拾取:最近的未被排除实例。face.normal 是几何局部坐标,
  // 世界法向需乘 meshWorld * instanceMatrix 的旋转部分。
  raycast(raycaster, excludeIds = null) {
    this._raycastMeshes.length = 0;
    for (const p of this.pools.values()) if (p.count > 0) this._raycastMeshes.push(p.mesh);
    const hits = raycaster.intersectObjects(this._raycastMeshes, false);
    for (const hit of hits) {
      const p = this.pools.get(hit.object.userData.poolKey);
      const h = p && p.slots[hit.instanceId];
      if (!h) continue;
      if (excludeIds && excludeIds.has(h.brickId)) continue;
      let normalWorld = null;
      if (hit.face) {
        hit.object.getMatrixAt(hit.instanceId, _im);
        _wm.multiplyMatrices(hit.object.matrixWorld, _im);
        normalWorld = hit.face.normal.clone().transformDirection(_wm);
      }
      return { brickId: h.brickId, point: hit.point, face: hit.face, normalWorld, object: hit.object, distance: hit.distance };
    }
    return null;
  }

  // 全部实例的包围盒(池父空间 = LDraw 根空间;含隐藏实例,用其原矩阵)
  boundingBox(target = new THREE.Box3()) {
    target.makeEmpty();
    for (const p of this.pools.values()) {
      if (!p.count) continue;
      if (!p.geo.boundingBox) p.geo.computeBoundingBox();
      for (let i = 0; i < p.count; i++) {
        _box.copy(p.geo.boundingBox).applyMatrix4(p.slots[i].mat);
        target.union(_box);
      }
    }
    return target;
  }

  clear() {
    for (const p of this.pools.values()) {
      this.group.remove(p.mesh);
      p.mesh.dispose();
      for (const h of p.slots) if (h) h.index = -1;
    }
    this.pools.clear();
  }
}
