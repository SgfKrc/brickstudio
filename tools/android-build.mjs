// BrickStudio 安卓打包自举脚本(Windows 优先,零第三方依赖,仅用 Node 内置模块)
// 用法: node tools/android-build.mjs   (或双击项目根目录的 打包安卓版.bat)
//
// 流程: 定位 JDK17+ -> 定位 Android SDK 并写 local.properties -> 定位/下载 Gradle 8.7
//       -> 同步 dist 到 assets/www -> gradle assembleRelease -> 复制 APK 到项目根
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  renameSync, statSync, writeFileSync, createWriteStream,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { syncAssets } from './android-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const GRADLE_VERSION = '8.7';
const GRADLE_DIST_DIR = path.join(ANDROID_DIR, '.gradle-dist');
const GRADLE_HOME = path.join(GRADLE_DIST_DIR, `gradle-${GRADLE_VERSION}`);
const GRADLE_ZIP = path.join(GRADLE_DIST_DIR, `gradle-${GRADLE_VERSION}-bin.zip`);
const GRADLE_URL = `https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`;
const IS_WIN = process.platform === 'win32';

function die(msg) {
  console.error('\n[错误] ' + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- JDK 定位
function javaMajorVersion(javaExe) {
  const r = spawnSync(javaExe, ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return -1;
  const out = (r.stderr || '') + (r.stdout || '');
  const m = out.match(/version\s+"(\d+)(?:\.(\d+))?/);
  if (!m) return -1;
  let major = parseInt(m[1], 10);
  if (major === 1 && m[2]) major = parseInt(m[2], 10); // "1.8.0" 这类旧格式
  return major;
}

function findJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push({
      home: process.env.JAVA_HOME,
      exe: path.join(process.env.JAVA_HOME, 'bin', IS_WIN ? 'java.exe' : 'java'),
      from: 'JAVA_HOME',
    });
  }
  candidates.push({ home: null, exe: 'java', from: 'PATH' });

  for (const c of candidates) {
    if (c.home && !existsSync(c.exe)) continue;
    const major = javaMajorVersion(c.exe);
    if (major >= 17) {
      console.log(`[jdk] 使用 ${c.from} 中的 Java ${major}` + (c.home ? ` (${c.home})` : ''));
      return c;
    }
    if (major > 0) {
      console.log(`[jdk] ${c.from} 的 Java 版本为 ${major},低于要求的 17,继续查找...`);
    }
  }
  die(
    '未找到 JDK 17 或更高版本。\n' +
    '  请安装 JDK 17+(如 Eclipse Temurin: https://adoptium.net ),\n' +
    '  并设置 JAVA_HOME 环境变量指向 JDK 目录,或把其 bin 目录加入 PATH。'
  );
}

// ------------------------------------------------------- Android SDK 定位
function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
      : null,
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    if (existsSync(path.join(dir, 'platforms')) ||
        existsSync(path.join(dir, 'platform-tools')) ||
        existsSync(path.join(dir, 'cmdline-tools'))) {
      console.log(`[sdk] Android SDK: ${dir}`);
      return dir;
    }
  }
  die(
    '未找到 Android SDK。\n' +
    '  请设置 ANDROID_HOME 或 ANDROID_SDK_ROOT 环境变量指向 SDK 目录\n' +
    '  (通常在 %LOCALAPPDATA%\\Android\\Sdk)。'
  );
}

function writeLocalProperties(sdkDir) {
  // properties 文件中反斜杠是转义符,统一改用正斜杠最稳妥
  const value = sdkDir.replace(/\\/g, '/');
  writeFileSync(
    path.join(ANDROID_DIR, 'local.properties'),
    `# 由 tools/android-build.mjs 自动生成\nsdk.dir=${value}\n`,
    'utf8'
  );
  console.log('[sdk] 已写入 android/local.properties');
}

// ------------------------------------------------------------ mini-unzip
// 仅支持本任务所需子集:无 zip64、method 0(store)/ 8(deflate)。
// 通过 central directory 读取条目(compressedSize 取 central 值,
// 因此通用位标志 bit3 / data descriptor 不影响解析),文件名按 UTF-8 解码。
export function miniUnzip(zipPath, destDir) {
  const buf = readFileSync(zipPath);
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  const LOC_SIG = 0x04034b50;

  // 从尾部向前搜索 EOCD(注释最长 65535 字节)
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) { eocd = i; break; }
      if (eocd === -1) eocd = i; // 备选(理论上不该发生)
    }
  }
  if (eocd < 0) throw new Error(`${zipPath} 不是有效的 ZIP 文件(找不到 EOCD)`);

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('不支持 zip64 格式');
  }

  let extracted = 0;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`central directory 第 ${i} 项签名错误 @${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // 路径安全检查
    if (path.isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error(`ZIP 内含非法路径: ${name}`);
    }
    const outPath = path.join(destDir, ...name.split('/').filter(Boolean));

    if (name.endsWith('/')) {
      mkdirSync(outPath, { recursive: true });
      continue;
    }

    // local header 里的 name/extra 长度可能与 central 不同,须单独读取
    if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`local header 签名错误: ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (compSize === 0) content = Buffer.alloc(0);           // 空文件
    else if (method === 0) content = data;                   // store
    else if (method === 8) content = zlib.inflateRawSync(data); // deflate
    else throw new Error(`不支持的压缩方式 ${method}: ${name}`);

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);

    if (!IS_WIN) {
      const mode = (extAttrs >>> 16) & 0o777;
      if (mode) chmodSync(outPath, mode);
    }
    extracted++;
  }
  return extracted;
}

// ------------------------------------------------------------ Gradle 定位
function commandOnPath(cmd) {
  const which = IS_WIN ? 'where' : 'which';
  const r = spawnSync(which, [cmd], { encoding: 'utf8', shell: IS_WIN });
  return r.status === 0 && r.stdout && r.stdout.trim().length > 0;
}

async function downloadWithProgress(url, destFile) {
  console.log(`[gradle] 正在下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`下载失败: HTTP ${res.status}`);
  }
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const tmpFile = destFile + '.part';
  mkdirSync(path.dirname(destFile), { recursive: true });
  const out = createWriteStream(tmpFile);
  let received = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    received += chunk.length;
    await new Promise((resolve, reject) => {
      out.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(
          `\r[gradle] 下载中 ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB (${pct}%)   `
        );
      }
    } else {
      process.stdout.write(`\r[gradle] 下载中 ${(received / 1048576).toFixed(1)} MB   `);
    }
  }
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });
  process.stdout.write('\n');
  renameSync(tmpFile, destFile);
}

async function findGradle() {
  // 1) PATH 里已有 gradle
  if (commandOnPath('gradle')) {
    console.log('[gradle] 使用 PATH 中的 gradle');
    return 'gradle';
  }

  // 2) 之前解压好的本地发行版
  const localBin = path.join(GRADLE_HOME, 'bin', IS_WIN ? 'gradle.bat' : 'gradle');
  if (existsSync(localBin)) {
    console.log(`[gradle] 使用本地发行版 ${GRADLE_HOME}`);
    return localBin;
  }

  // 3) 本地已有 zip(手动下载放置)则直接解压;否则联网下载
  if (!existsSync(GRADLE_ZIP)) {
    try {
      await downloadWithProgress(GRADLE_URL, GRADLE_ZIP);
    } catch (err) {
      die(
        `Gradle 下载失败(${err.message})。\n` +
        `  可手动用浏览器下载:\n    ${GRADLE_URL}\n` +
        `  并把 zip 文件放到:\n    ${GRADLE_ZIP}\n` +
        '  然后重新运行本脚本。'
      );
    }
  } else {
    console.log(`[gradle] 发现本地 zip: ${GRADLE_ZIP}`);
  }

  console.log('[gradle] 正在解压...');
  const n = miniUnzip(GRADLE_ZIP, GRADLE_DIST_DIR);
  console.log(`[gradle] 解压完成,共 ${n} 个文件`);
  if (!existsSync(localBin)) {
    die(`解压后未找到 ${localBin},zip 可能不完整,请删除后重试。`);
  }
  return localBin;
}

// --------------------------------------------------------------- 主流程
async function main() {
  console.log('=== BrickStudio 安卓打包 ===');

  const jdk = findJdk();
  const sdkDir = findAndroidSdk();
  writeLocalProperties(sdkDir);
  const gradleCmd = await findGradle();

  console.log('[assets] 同步前端产物...');
  syncAssets();

  console.log('[build] 开始构建 (assembleRelease),首次构建需联网下载依赖,请耐心等待...');
  const env = { ...process.env };
  if (jdk.home) env.JAVA_HOME = jdk.home;

  // 用 shell 方式执行,便于兼容 gradle.bat;路径加引号防空格
  const cmdline = `"${gradleCmd}" assembleRelease --no-daemon`;
  const r = spawnSync(cmdline, {
    cwd: ANDROID_DIR,
    stdio: 'inherit',
    env,
    shell: true,
  });

  if (r.status !== 0) {
    console.error('\n[错误] Gradle 构建失败。常见原因:');
    console.error('  1. SDK licenses 未接受 —— 运行:');
    console.error('     "%ANDROID_HOME%\\cmdline-tools\\latest\\bin\\sdkmanager.bat" --licenses');
    console.error('     然后一路输入 y 接受。');
    console.error('  2. JDK 版本不对 —— 需要 JDK 17+,检查 JAVA_HOME。');
    console.error('  3. 首次构建需联网下载 AGP 与依赖 —— 检查网络/代理后重试。');
    console.error('  4. 内存不足 —— 关闭其他程序后重试。');
    process.exit(r.status || 1);
  }

  const apk = path.join(
    ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'
  );
  if (!existsSync(apk)) {
    die(`构建显示成功但未找到 APK: ${apk}`);
  }
  const dest = path.join(ROOT, 'BrickStudio.apk');
  copyFileSync(apk, dest);
  const sizeMb = (statSync(dest).size / 1048576).toFixed(1);
  console.log('\n=== 构建成功 ===');
  console.log(`APK: ${apk}`);
  console.log(`已复制到: ${dest} (${sizeMb} MB)`);
  console.log('把 BrickStudio.apk 传到手机上安装即可(需允许安装未知来源应用)。');
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() ===
    import.meta.url.toLowerCase();

if (isMain) {
  main().catch((err) => {
    console.error('[错误] ' + (err.stack || err));
    process.exit(1);
  });
}
