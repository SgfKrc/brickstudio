// 构建脚本:
//  1) esbuild -> dist/(可托管的 PWA 版)
//  2) 生成 brickstudio-standalone.html(单文件离线版,内嵌全部零件数据,可直接在安卓浏览器打开)
// 用法: node tools/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
process.chdir(root);

// ---- 1. bundle ----
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/assets', { recursive: true });
execSync(`npx esbuild src/main.jsx --outdir=dist/assets --minify --format=esm --entry-names=app --bundle`, { stdio: 'inherit' });
fs.copyFileSync('src/styles.css', 'dist/assets/styles.css');
fs.copyFileSync('index.html', 'dist/index.html');

// public/ -> dist/
function cpDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
cpDir('public', 'dist');
console.log('✓ dist/ 构建完成');

// ---- 2. 单文件版 ----
const appJs = fs.readFileSync('dist/assets/app.js', 'utf8');
const css = fs.readFileSync('src/styles.css', 'utf8');

// 收集零件数据
const files = {};
const ldrawRoot = 'public/ldraw';
if (fs.existsSync(ldrawRoot)) {
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const s = path.join(dir, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(s, r);
      else files[r] = fs.readFileSync(s, 'utf8');
    }
  };
  walk(ldrawRoot, 'ldraw');
}
console.log(`内嵌零件文件: ${Object.keys(files).length} 个`);
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(files)), { level: 9 }).toString('base64');
console.log(`压缩后内嵌数据: ${(gz.length / 1024 / 1024).toFixed(2)} MB (base64)`);

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta name="theme-color" content="#1a1c20" />
<title>BrickStudio — 积木设计</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__LDRAW_GZ_B64 = "${gz}";<\/script>
<script type="module">${appJs.replace(/<\/script>/g, '<\\/script>')}<\/script>
</body>
</html>`;

fs.mkdirSync('dist-standalone', { recursive: true });
fs.writeFileSync('dist-standalone/brickstudio.html', html, { flag: 'w' });
console.log(`✓ 单文件版: dist-standalone/brickstudio.html (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
