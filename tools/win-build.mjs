// 电脑版一键打包:前端构建 -> electron-packager 出绿色目录 -> iscc 出安装包
// 前置:npm install 装好 devDependencies(electron、@electron/packager、esbuild);
//       Inno Setup 6 的 iscc 在 PATH(用户已确认)。
// 用法: node tools/win-build.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const ELECTRON_VERSION = '33.4.11';
const ELECTRON_ZIP = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
const ELECTRON_SHA256 = 'f64c8a5a81d9b420b636fdba13e180f49d69f2198e1d86a8b01f858b17a9483c';
process.chdir(root);

// extract-zip 在 Node 24/Windows 下可能提前结束且不报错。自动切换到 Electron 内置的 Node 20。
if (process.platform === 'win32' && Number(process.versions.node.split('.')[0]) >= 24 && !process.versions.electron) {
  const { downloadArtifact } = await import('@electron/get');
  const zip = await downloadArtifact({
    version: ELECTRON_VERSION,
    artifactName: 'electron',
    platform: 'win32',
    arch: 'x64',
    checksums: { [ELECTRON_ZIP]: ELECTRON_SHA256 },
  });
  const runtime = path.join(os.tmpdir(), `brickstudio-electron-${ELECTRON_VERSION}`);
  const electronExe = path.join(runtime, 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    const quotePs = value => `'${value.replace(/'/g, "''")}'`;
    const ps = `Expand-Archive -LiteralPath ${quotePs(zip)} -DestinationPath ${quotePs(runtime)} -Force`;
    const extracted = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    if (extracted.status !== 0) process.exit(extracted.status || 1);
  }
  const child = spawnSync(electronExe, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
  });
  process.exit(child.status || 0);
}

const run = (cmd) => { console.log('> ' + cmd); execSync(cmd, { stdio: 'inherit' }); };

// ---- 1. 前端构建(与 dev.mjs 相同产物,但用 --minify) ----
fs.mkdirSync('dist/assets', { recursive: true });
run('npx esbuild src/main.jsx --outdir=dist/assets --minify --format=esm --entry-names=app --bundle');
fs.copyFileSync('index.html', 'dist/index.html');
fs.copyFileSync('src/styles.css', 'dist/assets/styles.css');
if (fs.existsSync('public')) {
  const cpDir = (src, dest, lazySkip) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dest, e.name);
      if (e.isDirectory()) cpDir(s, d, lazySkip || e.name === 'ldraw');
      else if (!lazySkip || !fs.existsSync(d)) fs.copyFileSync(s, d);
    }
  };
  cpDir('public', 'dist', false);
}
console.log('✓ 前端构建完成');

// ---- 2. electron-packager(白名单打包,排除 complete/、node_modules 等大目录) ----
const { packager } = await import('@electron/packager');
const KEEP = ['/package.json', '/dist', '/electron', '/tools', '/build'];
const appPaths = await packager({
  dir: root,
  out: 'release',
  name: 'BrickStudio',
  executableName: 'BrickStudio',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: false,
  icon: path.join(root, 'build', 'icon.ico'),
  appVersion: '0.8.0',
  download: {
    // 使用 Electron 安装包的官方 SHA-256,避免打包时额外请求 SHASUMS256.txt。
    checksums: { [ELECTRON_ZIP]: ELECTRON_SHA256 },
  },
  win32metadata: { ProductName: 'BrickStudio 积木设计', FileDescription: 'BrickStudio 积木设计' },
  ignore: (p) => {
    if (p === '') return false;
    return !KEEP.some(k => p === k || p.startsWith(k + '/'));
  },
});
console.log('✓ Electron 打包完成:', appPaths[0]);

// ---- 3. Inno Setup 出安装包 ----
const iscc = spawnSync('iscc', [path.join('build', 'installer.iss')], { stdio: 'inherit', shell: true });
if (iscc.status !== 0) {
  console.error('\n✗ iscc 运行失败。请确认 Inno Setup 6 已安装且 iscc 在 PATH;');
  console.error('  也可以手动用 Inno Setup 打开 build\\installer.iss 编译。');
  process.exit(1);
}
console.log('\n✓ 安装包已生成:release\\BrickStudio-Setup-0.8.0.exe');
console.log('  绿色免安装版:release\\BrickStudio-win32-x64\\BrickStudio.exe');
