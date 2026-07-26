// 把 dist/ 完整复制到 android/app/src/main/assets/www(先清空目标)
// 用法: node tools/android-assets.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkStats(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

export function syncAssets() {
  const dist = path.join(ROOT, 'dist');
  const target = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');

  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    throw new Error(
      `未找到 ${dist}\n请先构建前端(在项目根目录运行 npm run build),再重新执行本脚本。`
    );
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(dist, target, { recursive: true });

  const { files, bytes } = walkStats(target);
  console.log(`[assets] 已复制 dist -> android/app/src/main/assets/www`);
  console.log(`[assets] 共 ${files} 个文件,总大小 ${fmtSize(bytes)}`);
  return { files, bytes, target };
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() ===
    import.meta.url.toLowerCase();

if (isMain) {
  try {
    syncAssets();
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
}
