import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);

// PWA service worker(仅 https / localhost 下注册)
// 安卓 App 内(window.BrickBridge 存在)不注册:WebView 里 Service Worker 的请求
// 不经过 WebViewClient.shouldInterceptRequest,拿不到 APK 内的 assets,注册必然失败;
// 而且 App 本身就是离线的,不需要 SW 缓存。
const inAndroidShell = typeof window !== 'undefined' && !!window.BrickBridge;
if (!inAndroidShell && 'serviceWorker' in navigator
    && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
