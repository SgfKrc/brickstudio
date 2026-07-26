# BrickStudio 积木设计

一个可在安卓上使用的乐高式积木搭建设计器(类似 LEGO Digital Designer / BrickLink Studio 的简化版),基于 React + Three.js,零件与文件格式兼容开源的 [LDraw](https://www.ldraw.org/) 生态。

## 在安卓上使用

**方式一(最简单):单文件版**
把 `dist-standalone/brickstudio.html` 传到手机(微信/QQ/网盘/数据线均可),用 Chrome 或系统浏览器打开即可,无需联网、无需安装。

**方式二:PWA 版**
把 `dist/` 目录部署到任意静态服务器(或局域网内 `python -m http.server`),手机浏览器访问后,通过菜单「添加到主屏幕」即可像 App 一样使用,支持离线。

**方式三:打包 APK(可选)**
后续可用 Capacitor 把 `dist/` 包成原生 APK(需要 Android SDK 环境)。

## 功能

- 3D 视图:单指旋转、双指缩放/平移
- 四种模式:放置 / 选择(拖动移动)/ 上色 / 删除
- **约 1800 种零件**(砖/板/光板/斜面/圆拱/楔形/墙板/门窗/杆/支架/科技/底板),中英文搜索(支持"2x4"、"斜面"、"window"等)
- **卡扣连接检测**:零件必须扣在柱钉上(光板顶面不可拼接),格心错位自动 ±10 微调吸附
- **SNOT 侧向拼接**:点击侧向柱钉即侧贴;⟳ 水平旋转 + ⤸ 竖直翻转可组合出全部 24 种姿态
- **多选 / 分组**:整组移动、旋转、复制、换色、删除;分组随 .ldr 保存(自定义元行,不影响兼容)
- **Studio 式连接吸附**:拖动/预览时实时吸附到附近柱钉,沿零件表面拖动自动抬升,无效位置红色高亮并回退
- **任意角度旋转**:📐 面板选 X/Y/Z 轴,±15/30/45/90 快捷或自定义角度;非 90° 姿态自动按自由放置处理
- 连接检测可在菜单开关(关闭后完全自由放置)
- 自动保存:模型随改动存入浏览器,下次打开自动恢复
- 零件清单(BOM):按零件×颜色统计
- 桌面快捷键:Ctrl+Z/Y 撤销重做、R 旋转、F 翻转、Del 删除
- 网格吸附(10 LDU)+ 重力堆叠;移动碰撞/失去支撑自动回退
- 38 种 LDraw 标准颜色(含透明件),撤销/重做
- 导出标准 `.ldr` 文件(完整旋转矩阵),与 BrickLink Studio、LeoCAD 互通

## 开发

```bash
# 依赖:node + bun;node_modules 里需有 react/react-dom/scheduler/three
node tools/pack-parts.mjs <LDraw库根目录>   # 从完整 LDraw 库抽取零件子集到 public/ldraw/
node tools/build.mjs                        # 构建 dist/(PWA)+ dist-standalone/brickstudio.html(单文件)
python3 -m http.server 8000 --directory dist  # 本地预览
```

## 目录结构

```
src/
  App.jsx               UI(工具栏、零件面板、颜色、菜单)
  colors.js             LDraw 颜色表子集
  parts-catalog.js      内置零件目录(改这里增删零件,然后重跑 pack-parts + build)
  ldraw-io.js           .ldr 序列化/解析
  editor/BrickEditor.js 3D 场景与交互(放置/拖动/旋转/堆叠/撤销)
  editor/PartLibrary.js LDraw 零件加载、材质、缩略图
tools/pack-parts.mjs    零件子集抽取(递归解析依赖)
tools/build.mjs         构建脚本
public/ldraw/           抽取后的零件数据(构建产物)
```

## 已知限制

- 旋转限于 90° 步进(无铰链/转盘的任意角度姿态)
- 底面反柱钉格按零件外形近似(异形件的可扣位置可能偏宽松)
- 连接检测不含侧夹、杆-夹持等特殊连接方式
- 零件库为筛选子集(排除人仔、轮胎、电子件等),打开含库外零件的文件会跳过对应零件
