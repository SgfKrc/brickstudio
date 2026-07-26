// 开发模式：构建 + 复制静态文件 + 启动服务器
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
process.chdir(root);

// 1. 确保 dist 目录结构
fs.mkdirSync('dist/assets', { recursive: true });

// 2. 构建 JS
execSync('esbuild src/main.jsx --outdir=dist/assets --format=esm --entry-names=app --bundle', { stdio: 'inherit' });

// 3. 复制静态文件
fs.copyFileSync('index.html', 'dist/index.html');
fs.copyFileSync('src/styles.css', 'dist/assets/styles.css');

// 复制 public/ -> dist/
if (fs.existsSync('public')) {
  function cpDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dest, e.name);
      if (e.isDirectory()) cpDir(s, d);
      else if (!fs.existsSync(d)) fs.copyFileSync(s, d); // 跳过已存在的（LDraw 零件文件无需每次复制）
    }
  }
  cpDir('public', 'dist');
}

console.log('✓ 静态文件已就绪');

// 4. 启动服务器
await import('./serve.mjs');
