/**
 * BrickStudio 安装包分发服务器(TypeScript,零依赖,只用 Node 内置模块)
 *
 * 用途:把打包好的安装包发到手机/同事电脑 —— 同一 WiFi 下用浏览器打开局域网地址即可下载。
 *   - 安卓包:  <项目根>/*.apk            (打包安卓版.bat 的产物 BrickStudio.apk)
 *   - 电脑安装包:<项目根>/release/*.exe   (打包电脑版.bat 的产物 BrickStudio-Setup-x.y.z.exe)
 *   - 电脑绿色版:<项目根>/release/*.zip   (如果你自己压缩了免安装目录)
 *
 * 运行:
 *   双击「分发安装包.bat」,或命令行:
 *     node --experimental-strip-types tools/dist-server.ts        (Node 22.6+)
 *     node tools/dist-server.ts                                   (Node 23.6+ 原生支持)
 *   自定义端口:  set PORT=9000 && node ... (默认 8088,被占用自动 +1)
 *
 * 特性:文件自动发现(换版本号不用改代码)、断点续传(Range)、下载页自适应手机、
 *      访问日志、仅暴露白名单文件(不会泄露项目其他内容)。
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const PORT = parseInt(process.env.PORT || '8088', 10);

interface Item {
  /** URL 里用的短名(即文件名) */
  name: string;
  /** 磁盘绝对路径 */
  file: string;
  size: number;
  mtime: number;
  kind: 'android' | 'windows' | 'other';
  label: string;
}

const MIME: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
};

function humanSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

/** 扫描可分发文件:根目录的 .apk + release/ 下的 .exe/.zip */
function scan(): Item[] {
  const out: Item[] = [];
  const add = (dir: string, exts: string[]) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const ext = path.extname(n).toLowerCase();
      if (!exts.includes(ext)) continue;
      const file = path.join(dir, n);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const kind: Item['kind'] = ext === '.apk' ? 'android' : ext === '.exe' ? 'windows' : 'other';
      out.push({
        name: n,
        file,
        size: st.size,
        mtime: st.mtimeMs,
        kind,
        label: kind === 'android' ? '安卓安装包' : kind === 'windows' ? '电脑版安装包' : '压缩包',
      });
    }
  };
  add(ROOT, ['.apk']);
  add(RELEASE, ['.exe', '.zip']);
  // 安卓包排前面(手机扫码下载是主要场景),同类按修改时间新→旧
  const rank = (k: Item['kind']) => (k === 'android' ? 0 : k === 'windows' ? 1 : 2);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind) || b.mtime - a.mtime);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function indexPage(items: Item[], host: string): string {
  const rows = items.length
    ? items
        .map((it) => {
          const icon = it.kind === 'android' ? '🤖' : it.kind === 'windows' ? '🪟' : '📦';
          const date = new Date(it.mtime).toLocaleString('zh-CN', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
          });
          return `<a class="card" href="/d/${encodeURIComponent(it.name)}">
  <div class="ic">${icon}</div>
  <div class="meta">
    <div class="name">${esc(it.name)}</div>
    <div class="sub">${it.label} · ${humanSize(it.size)} · ${date}</div>
  </div>
  <div class="dl">下载</div>
</a>`;
        })
        .join('\n')
    : `<div class="empty">还没有可分发的文件。<br/>先运行「打包安卓版.bat」或「打包电脑版.bat」,刷新本页即可。</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#1a1c20"/>
<title>BrickStudio 安装包下载</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
background:#1a1c20;color:#e8eaed;padding:24px 16px 40px;line-height:1.6}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px}
.tip{color:#8a919c;font-size:13px;margin-bottom:20px}
.card{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;
background:#23262c;border:1px solid #30343b;border-radius:14px;padding:14px;margin-bottom:12px}
.card:active{background:#2c313a}
.ic{font-size:30px;flex:0 0 auto}
.meta{flex:1;min-width:0}
.name{font-weight:600;font-size:15px;word-break:break-all}
.sub{color:#8a919c;font-size:12px}
.dl{flex:0 0 auto;background:#2b5cd9;color:#fff;padding:8px 16px;border-radius:10px;font-size:14px}
.empty{background:#23262c;border:1px solid #30343b;border-radius:14px;padding:24px;
color:#8a919c;font-size:14px;text-align:center}
.foot{margin-top:22px;color:#6f7883;font-size:12px}
.foot code{background:#23262c;padding:2px 6px;border-radius:5px}
</style>
</head>
<body>
<div class="wrap">
  <h1>BrickStudio 安装包</h1>
  <div class="tip">当前地址 <code>${esc(host)}</code> · 点击即可下载</div>
  ${rows}
  <div class="foot">
    安卓:下载后在通知栏点击安装,若提示未知来源请允许浏览器安装应用。<br/>
    电脑:下载 .exe 后双击安装。<br/>
    本页只分发安装包文件,不会暴露项目其他内容。
  </div>
</div>
</body>
</html>`;
}

/** 发送文件,支持 Range 断点续传(手机流量下载大文件时很有用) */
function sendFile(req: IncomingMessage, res: ServerResponse, item: Item): void {
  const ext = path.extname(item.file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;
  const baseHeaders: Record<string, string> = {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(item.name)}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : NaN;
      let end = m[2] ? parseInt(m[2], 10) : NaN;
      if (Number.isNaN(start)) {
        // "bytes=-N" 表示最后 N 字节
        const n = Number.isNaN(end) ? 0 : end;
        start = Math.max(0, item.size - n);
        end = item.size - 1;
      } else if (Number.isNaN(end)) {
        end = item.size - 1;
      }
      if (start > end || start >= item.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${item.size}` });
        res.end();
        return;
      }
      end = Math.min(end, item.size - 1);
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${item.size}`,
        'Content-Length': String(end - start + 1),
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(item.file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': String(item.size) });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(item.file).pipe(res);
}

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }

  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  const host = req.headers.host || `localhost:${PORT}`;
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${method} ${urlPath} ← ${req.socket.remoteAddress}`);

  if (urlPath === '/' || urlPath === '/index.html') {
    const body = indexPage(scan(), host);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(method === 'HEAD' ? undefined : body);
    return;
  }

  // 机器可读的清单,方便脚本化取包
  if (urlPath === '/list.json') {
    const body = JSON.stringify(
      scan().map(({ name, size, mtime, kind, label }) => ({ name, size, mtime, kind, label })),
      null, 2,
    );
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(method === 'HEAD' ? undefined : body);
    return;
  }

  if (urlPath.startsWith('/d/')) {
    const want = urlPath.slice(3);
    // 只按"文件名"在白名单里查找 —— 天然免疫路径穿越
    const item = scan().find((i) => i.name === want);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('文件不存在(可能已重新打包,请返回首页刷新)');
      return;
    }
    sendFile(req, res, item);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('listening', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  const items = scan();
  console.log('\n  BrickStudio 安装包分发服务已启动');
  console.log(`    本机:      http://localhost:${port}`);
  for (const ip of lanAddresses()) {
    console.log(`    手机/局域网: http://${ip}:${port}   ← 手机浏览器打开这个`);
  }
  console.log(`\n  可分发文件(${items.length}):`);
  if (!items.length) {
    console.log('    (无)先运行 打包安卓版.bat / 打包电脑版.bat,网页刷新即可看到');
  }
  for (const it of items) {
    console.log(`    · ${it.name}  ${humanSize(it.size)}  [${it.label}]`);
  }
  console.log('\n  按 Ctrl+C 停止\n');
});

function listen(port: number): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 被占用,改试 ${port + 1}...`);
      listen(port + 1);
    } else {
      throw err;
    }
  });
  server.listen(port);
}

listen(PORT);
