// 开发模式:构建 + 复制静态文件 + 启动服务器
// 修正:public/ 下的小文件(sw.js/manifest 等)每次都覆盖,否则改了不生效;
//       只有 ldraw/ 零件库(几千个文件)才跳过已存在的,加快启动。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
process.chdir(root);

fs.mkdirSync('dist/assets', { recursive: true });

execSync('esbuild src/main.jsx --outdir=dist/assets --format=esm --entry-names=app --bundle', { stdio: 'inherit' });

fs.copyFileSync('index.html', 'dist/index.html');
fs.copyFileSync('src/styles.css', 'dist/assets/styles.css');

if (fs.existsSync('public')) {
  function cpDir(src, dest, lazySkip) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dest, e.name);
      if (e.isDirectory()) cpDir(s, d, lazySkip || e.name === 'ldraw');
      else if (!lazySkip || !fs.existsSync(d)) fs.copyFileSync(s, d);
    }
  }
  cpDir('public', 'dist', false);
}

console.log('✓ 静态文件已就绪');
await import('./serve.mjs');
