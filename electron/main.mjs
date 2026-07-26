// BrickStudio Electron 主进程 — 内嵌零依赖本地服务(与命令行版共用 tools/server-lib.mjs)。
// 模型库保存到 文档\BrickStudio模型;导出的文件落到系统"下载"目录并自动定位。
import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/server-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const modelsDir = path.join(app.getPath('documents'), 'BrickStudio模型');

let win = null;

async function createWindow() {
  let port;
  try {
    ({ port } = await startServer({
      distDir,
      modelsDir,
      port: 0,               // 随机可用端口,避免与其他程序冲突
      host: '127.0.0.1',
      retry: false,
    }));
  } catch (e) {
    dialog.showErrorBox('BrickStudio 启动失败', String(e && e.message || e));
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#1a1c20',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);

  // 导出的 .ldr / .csv / .xlsx / .png 落到系统下载目录,完成后在资源管理器中定位
  win.webContents.session.on('will-download', (event, item) => {
    const target = path.join(app.getPath('downloads'), item.getFilename());
    item.setSavePath(target);
    item.once('done', (e2, state) => {
      if (state === 'completed') shell.showItemInFolder(target);
    });
  });

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
