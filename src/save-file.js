// 统一"保存文件到本地"入口:
//  - 安卓 App 内(WebView):走 window.BrickBridge.saveFile 桥接,写入系统"下载"目录
//  - 浏览器 / Electron:<a download> 触发下载(Electron 主进程会落到下载文件夹并定位)
function toBase64(u8) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function saveBinaryFile(data, filename, mime = 'application/octet-stream') {
  const u8 = typeof data === 'string' ? new TextEncoder().encode(data)
    : (data instanceof Uint8Array ? data : new Uint8Array(data));
  if (typeof window !== 'undefined' && window.BrickBridge?.saveFile) {
    window.BrickBridge.saveFile(filename, toBase64(u8), mime);
    return 'bridge';
  }
  const blob = new Blob([u8], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  return 'download';
}

export function saveTextFile(text, filename, mime = 'text/plain;charset=utf-8') {
  return saveBinaryFile(new TextEncoder().encode(text), filename, mime);
}
