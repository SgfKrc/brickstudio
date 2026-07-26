// BrickStudio 本地服务器(命令行版)— 逻辑在 server-lib.mjs,与 Electron 版共用。
// 运行: node tools/serve.mjs   (默认端口 8000,可用环境变量 PORT 指定;被占用自动 +1 重试)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, printBanner } from './server-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const modelsDir = path.resolve(__dirname, '..', 'models');

const { port } = await startServer({
  distDir,
  modelsDir,
  port: parseInt(process.env.PORT || '8000', 10),
});
printBanner(port, modelsDir);
