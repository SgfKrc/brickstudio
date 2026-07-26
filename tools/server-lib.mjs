// BrickStudio 服务核心库 — 零依赖,可被命令行版(tools/serve.mjs)与 Electron 版复用。
// 职责:静态托管 dist(零件按需加载)+ 模型库 API(存标准 .ldr)。
// 关键:不存在的"带扩展名"文件必须返回 404(LDrawLoader 靠 404 轮询候选路径)。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ldr': 'text/plain; charset=utf-8',
  '.dat': 'text/plain; charset=utf-8',
  '.mpd': 'text/plain; charset=utf-8',
  '.manifest': 'application/manifest+json',
};

function safeName(raw) {
  let name;
  try { name = decodeURIComponent(raw); } catch { return null; }
  name = name.replace(/\.(ldr|mpd)$/i, '');
  if (!/^[\w一-鿿()\-. ]{1,64}$/.test(name) || name.includes('..')) return null;
  return name + '.ldr';
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large (>32MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createBrickServer({ distDir, modelsDir }) {
  const DIST = path.resolve(distDir);
  const MODELS = path.resolve(modelsDir);
  fs.mkdirSync(MODELS, { recursive: true });

  function serveStatic(req, res, url) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(url.split('?')[0]);
    } catch {
      return send(res, 400, 'bad request');
    }
    if (urlPath === '/') urlPath = '/index.html';
    let filePath = path.normalize(path.join(DIST, urlPath));
    if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
      return send(res, 403, 'forbidden');
    }
    const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    if (!exists) {
      if (!path.extname(urlPath)) {
        filePath = path.join(DIST, 'index.html');
        if (!fs.existsSync(filePath)) return send(res, 404, 'not found');
      } else {
        return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': mime,
      'Cache-Control': urlPath.startsWith('/ldraw/') ? 'max-age=86400' : 'no-cache',
    };
    const gzOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|json|javascript|svg/.test(mime);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) send(res, 500, 'read error'); else res.destroy(); });
    if (gzOk) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
      res.writeHead(200, headers);
      stream.pipe(res);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    try {
      if (url === '/api/ping') return sendJSON(res, 200, { ok: true, version: 'v8' });

      if (url === '/api/models' && req.method === 'GET') {
        const list = fs.readdirSync(MODELS)
          .filter(f => f.endsWith('.ldr') && !f.startsWith('.'))
          .map(f => {
            const st = fs.statSync(path.join(MODELS, f));
            return { name: f.replace(/\.ldr$/, ''), mtime: st.mtimeMs, size: st.size };
          })
          .sort((a, b) => b.mtime - a.mtime);
        return sendJSON(res, 200, list);
      }

      const mm = url.match(/^\/api\/models\/([^/?]+)$/);
      if (mm) {
        const file = safeName(mm[1]);
        if (!file) return sendJSON(res, 400, { error: '名称不合法' });
        const fp = path.join(MODELS, file);
        if (req.method === 'GET') {
          if (!fs.existsSync(fp)) return sendJSON(res, 404, { error: '不存在' });
          return send(res, 200, fs.readFileSync(fp), { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          fs.writeFileSync(fp, body);
          return sendJSON(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
          return sendJSON(res, 200, { ok: true });
        }
        return send(res, 405, 'method not allowed');
      }

      if (url === '/api/autosave') {
        const fp = path.join(MODELS, '.autosave.ldr');
        if (req.method === 'GET') {
          if (!fs.existsSync(fp)) return send(res, 404, '');
          return send(res, 200, fs.readFileSync(fp), { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (req.method === 'PUT') {
          fs.writeFileSync(fp, await readBody(req));
          return sendJSON(res, 200, { ok: true });
        }
        return send(res, 405, 'method not allowed');
      }

      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
      send(res, 405, 'method not allowed');
    } catch (e) {
      if (!res.headersSent) sendJSON(res, 500, { error: String(e && e.message || e) });
      else res.destroy();
    }
  });

  return server;
}

// 启动并返回 {server, port};port=0 表示随机可用端口;retry 对 EADDRINUSE 递增重试
export function startServer({ distDir, modelsDir, port = 8000, host, retry = true }) {
  const server = createBrickServer({ distDir, modelsDir });
  return new Promise((resolve, reject) => {
    const tryListen = (p) => {
      server.once('error', (err) => {
        if (retry && p !== 0 && err.code === 'EADDRINUSE') {
          console.log(`端口 ${p} 被占用,改试 ${p + 1}...`);
          tryListen(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, host, () => resolve({ server, port: server.address().port }));
    };
    tryListen(port);
  });
}

export function printBanner(port, modelsDir) {
  console.log(`\nBrickStudio 已启动`);
  console.log(`  本机访问: http://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  局域网(手机同 WiFi 可开): http://${a.address}:${port}`);
      }
    }
  }
  console.log(`  模型保存目录: ${path.resolve(modelsDir)}\n`);
}
