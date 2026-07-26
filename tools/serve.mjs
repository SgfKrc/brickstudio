// 简易静态文件服务器（Node.js 内置模块，无需额外依赖）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', 'dist');
const PORT = parseInt(process.env.PORT || '8000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.dat':  'text/plain',
  '.ldr':  'text/plain',
  '.manifest': 'application/manifest+json',
};

// 哪些 MIME 值得 gzip 压缩（文本类）
const GZIP_TYPES = new Set([
  'text/html; charset=utf-8', 'text/javascript', 'text/css',
  'application/json', 'text/plain', 'application/manifest+json',
]);

function isPathSafe(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(root);
}

function serveFile(req, res, filePath) {
  // 路径安全：禁止 ../ 越界
  if (!isPathSafe(filePath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  const shouldGzip = acceptGzip && GZIP_TYPES.has(contentType) && stat.size > 256;

  if (shouldGzip) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 4 })).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(root, urlPath === '/' ? 'index.html' : urlPath);

  // 文件存在 + 是文件 → 直接返回
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(req, res, filePath);
    return;
  }

  // 路径指向目录 → 尝试 index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const idx = path.join(filePath, 'index.html');
    if (fs.existsSync(idx) && fs.statSync(idx).isFile()) {
      serveFile(req, res, idx);
      return;
    }
  }

  // 请求带扩展名 → 真实 404（LDrawLoader 依赖 404 试探候选路径）
  if (path.extname(urlPath) !== '') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // 无扩展名的页面导航 → SPA fallback 到 index.html
  filePath = path.join(root, 'index.html');
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(req, res, filePath);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

function tryListen(port) {
  server.listen(port, () => {
    console.log(`Dev server running at http://localhost:${port}/`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      server.close();
      tryListen(port + 1);
    } else {
      throw err;
    }
  });
}
tryListen(PORT);
