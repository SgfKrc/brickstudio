# 吸附功能错位问题

## 概述

卡扣连接检测（吸附/磁吸 snap）是搭建体验的核心功能，但在实际使用中存在明显的**错位**和**误吸附**问题，导致零件放置到非预期的位置，严重影响可用性。

用户可通过菜单 →「🧲 连接检测:开/关」手动关闭（关闭后完全自由放置），但默认开启且关闭后缺少吸附引导，两者都不是好的体验。

---

## 现状分析

### 吸附工作流

```
用户点击/拖动
    │
    ▼
_connectionSnap(info, m, P, excludeIds, radius=42)
    │  搜索半径 42 LDU（≈ 4.2 个柱钉间距）内的所有柱钉
    │  用零件的底面反柱钉格(cells)去匹配柱钉位置
    │  取距离最近的 8 个候选，第一个无碰撞的即为吸附目标
    │
    ├── 找到 → 吸附到该柱钉
    └── 未找到 → 网格吸附 + 重力堆叠
                    │
                    ▼
                _dropY: 在 x,z 处垂直下落直到碰撞停止
                尝试 bx, bx±10, bz±10 微调（placeFromHit）
```

### 开关机制

| 文件 | 行号 | 说明 |
|------|------|------|
| [App.jsx](src/App.jsx#L389-L394) | 389-394 | UI 开关，藏在菜单内，不够显眼 |
| [BrickEditor.js](src/editor/BrickEditor.js#L68) | 68 | `connectCheck` 默认为 `true` |
| [BrickEditor.js](src/editor/BrickEditor.js#L268) | 268 | `_isSupported()` 关闭连接检测时直接返回 `true` |
| [BrickEditor.js](src/editor/BrickEditor.js#L312) | 312 | `_connectionSnap()` 关闭时返回 `null`，回退网格吸附 |

---

## 问题详情

### 问题 1：吸附半径过大导致远距离误吸附

**位置**: [BrickEditor.js:311](src/editor/BrickEditor.js#L311)

```js
_connectionSnap(info, m, P, excludeIds = new Set(), radius = 42) {
```

`radius = 42` LDU，即约 4.2 个柱钉间距。零件可以"跳"很远吸附到非预期的柱钉上。在零件密集区域，多个候选柱钉竞争，排序取最近但最近 ≠ 用户想要的。

**建议**: 默认半径缩小到 24-28 LDU，或根据零件尺寸动态调整。

---

### 问题 2：底面反柱钉格(cells)近似计算导致对不齐

**位置**: [PartLibrary.js:147-157](src/editor/PartLibrary.js#L147-L157)

```js
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
```

`cells` 生成基于包围盒（bbox）减去柱钉凸起的 `body` 范围，以 20 LDU 为步长从 `min + 10` 开始排布。但：
- 异形件（圆拱、楔形、斜面）的包围盒与实际可扣区域差异大，cells 位置可能落在零件实体外或空洞上
- 步长 20 LDU 与真实柱钉间距一致，但起点 `min + 10` 可能与零件实际柱钉格心错位 — 真实乐高零件的柱钉总是从边缘起算的固定偏移
- README 已知限制也提到："底面反柱钉格按零件外形近似(异形件的可扣位置可能偏宽松)"

**建议**: parts-catalog 中为每个零件提供精确的底面柱钉格坐标（而非运行时从包围盒估算），至少对常用零件做校准。

---

### 问题 3：grid snap ±10 微调引入歧义

**位置**: [BrickEditor.js:592](src/editor/BrickEditor.js#L592)

```js
for (const dx of [0, -10, 10]) for (const dz of [0, -10, 10]) cand.push([bx + dx, bz + dz]);
```

当 `_connectionSnap` 未找到吸附目标时，`placeFromHit` 回退到网格吸附。除了精确网格点外，还尝试 ±10 LDU 的偏移来"微调对齐"。但：
- 这会导致零件偏离用户点击位置 10 LDU（半个柱钉间距）
- 0/±10 三个值共 9 种组合，排序取欧氏距离最近的，可能与用户意图偏差 10 LDU
- 非 90° 姿态的零件 `isGridM(m) === false` 时走不到这里，但网格姿态会有这个歧义

**建议**: 只在连接检测开启时才做 ±10 微调；关闭时严格遵守网格（偏移 0），让用户精确控制位置。

---

### 问题 4：拖动时单零件强制吸附

**位置**: [BrickEditor.js:422-423](src/editor/BrickEditor.js#L422-L423)

```js
let target = (this.selection.size === 1)
  ? this._connectionSnap(prim.info, prim.m, P, sel) : null;
```

拖动单个零件时强制走 `_connectionSnap`，不做网格回退。这意味着：
- 拖动零件时它会"跳"到最近的柱钉上，而不是平滑跟随手指
- 多选/分组拖动反而没有这个行为（直接走网格），行为不一致
- 用户无法通过拖动微调单个零件的位置 — 它总被吸走

**建议**: 吸附应该只作用于放置的最终确认时刻（松手时），拖动过程中保持网格吸附以允许自由移动。或提供修饰键（如按住 Shift）临时禁用吸附。

---

### 问题 5：吸附失败无视觉反馈

当 `_connectionSnap` 找到候选但全部被碰撞检测否决，或搜索范围内无可用柱钉时，静默回退到网格吸附。用户不知道：
- 为什么零件没有吸到预期位置
- 是因为太远、方向不对、还是空间不足

**建议**: 在 ghost/preview 阶段显示吸附目标指示器（如高亮目标柱钉），让用户看到即将吸附的位置。

---

## 影响范围

- **放置模式**: `placeFromHit()` ([BrickEditor.js:573](src/editor/BrickEditor.js#L573))
- **拖动/移动**: `_onMove()` ([BrickEditor.js:422-423](src/editor/BrickEditor.js#L422-L423))
- **预览**: `_updateGhost()` ([BrickEditor.js:548](src/editor/BrickEditor.js#L548))

---

## 建议优先级

| 优先级 | 问题 | 理由 |
|--------|------|------|
| 🔴 高 | 问题 4 — 拖动强制吸附 | 直接影响移动操作，用户无法精确摆放 |
| 🔴 高 | 问题 3 — ±10 微调歧义 | 每次放置都可能偏半个格子 |
| 🟡 中 | 问题 1 — 吸附半径过大 | 密集场景下误吸附频繁 |
| 🟡 中 | 问题 2 — cells 近似 | 异形件体验差，但属于已知限制 |
| 🟢 低 | 问题 5 — 无视觉反馈 | UX 改进，不影响功能正确性 |

---

## 相关代码位置

| 文件 | 关键函数/行 |
|------|------------|
| [BrickEditor.js](src/editor/BrickEditor.js#L68) | `connectCheck` 开关声明 |
| [BrickEditor.js](src/editor/BrickEditor.js#L268) | `_isSupported()` 连接检测 |
| [BrickEditor.js](src/editor/BrickEditor.js#L311) | `_connectionSnap()` 吸附核心 |
| [BrickEditor.js](src/editor/BrickEditor.js#L415-L452) | `_onMove()` 拖动吸附 |
| [BrickEditor.js](src/editor/BrickEditor.js#L548) | `_updateGhost()` 预览吸附 |
| [BrickEditor.js](src/editor/BrickEditor.js#L573-L620) | `placeFromHit()` 放置吸附 |
| [BrickEditor.js](src/editor/BrickEditor.js#L622-L644) | `_placeOnStud()` 侧向拼接 |
| [PartLibrary.js](src/editor/PartLibrary.js#L147-L157) | `cells` 底面格生成 |
| [App.jsx](src/App.jsx#L389-L394) | UI 开关按钮 |
