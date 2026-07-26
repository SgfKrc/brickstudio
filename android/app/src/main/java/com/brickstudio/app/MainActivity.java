package com.brickstudio.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.Map;

/**
 * BrickStudio 安卓壳:全屏 WebView 加载打包进 assets/www 的离线前端。
 *
 * 资源服务不依赖 androidx.webkit 的 WebViewAssetLoader —— 直接用 AssetManager 自己实现,
 * 少一层版本差异与行为差异,并且能:
 *   1) 对缺失文件返回明确 404(LDrawLoader 靠 404 轮询候选零件路径,这个必须准确)
 *   2) 任何未命中的请求都不放它走网络(本应用无 INTERNET 权限,漏到网络会报 ERR_CACHE_MISS)
 *   3) 主页面加载失败时,直接在屏幕上打印可读的中文诊断,而不是 Chromium 错误码
 */
public class MainActivity extends Activity {

    private static final String TAG = "BrickStudio";
    /** 壳版本标记:会以字符串常量形式进入 classes.dex,
     *  tools/apk-check.mjs 靠搜索它来判断 APK 里是不是最新的 Java 代码。改代码时请一并改这里。 */
    private static final String SHELL_BUILD = "BRICKSTUDIO_SHELL_V2_ASSETMANAGER";
    private static final String HOST = "appassets.androidx.dev";
    private static final String PREFIX = "/assets/";           // URL 前缀 -> APK 内 assets/ 根
    private static final String INDEX = "www/index.html";      // 首页在 assets 内的路径
    private static final String START_URL = "https://" + HOST + PREFIX + INDEX;
    private static final int REQUEST_FILE_CHOOSER = 1001;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 任何初始化异常都转成可读页面,避免闪退后拿不到任何信息
        try {
            setup();
        } catch (Throwable t) {
            Log.e(TAG, "启动失败", t);
            showFatal(t);
        }
    }

    private void setup() {
        Log.i(TAG, "shell build = " + SHELL_BUILD);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);   // localStorage 持久化依赖它
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest request) {
                return serve(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    int code = error == null ? 0 : error.getErrorCode();
                    String desc = error == null ? "未知" : String.valueOf(error.getDescription());
                    Log.e(TAG, "主框架失败 " + code + " " + desc + " @ " + request.getUrl());
                    showDiagnostic("页面加载失败",
                            "URL: " + request.getUrl() + "\n错误: " + code + " " + desc
                                    + "\n\n" + assetReport());
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse errorResponse) {
                if (request != null && request.isForMainFrame()) {
                    int sc = errorResponse == null ? 0 : errorResponse.getStatusCode();
                    Log.e(TAG, "主框架 HTTP " + sc + " @ " + request.getUrl());
                    showDiagnostic("首页未能从 APK 内读取(HTTP " + sc + ")",
                            "URL: " + request.getUrl() + "\n\n" + assetReport());
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                // adb logcat -s BrickStudio 可看到前端日志
                Log.i(TAG, "console: " + cm.message() + " @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(
                            Intent.createChooser(intent, "选择文件"), REQUEST_FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    pendingFileCallback = null;
                    filePathCallback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "未找到文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        webView.addJavascriptInterface(new Bridge(), "BrickBridge");

        // 启动自检:资源没打进 APK 时直接说明原因
        if (!assetExists(INDEX)) {
            Log.e(TAG, "assets/" + INDEX + " 不存在");
            showDiagnostic("前端资源未打包进 APK",
                    assetReport()
                            + "\n\n修复步骤(电脑上,项目根目录):\n"
                            + "  1) npm run build\n"
                            + "  2) node tools\\android-assets.mjs   ← 要看到\"共 NNNN 个文件\"\n"
                            + "  3) 打包安卓版.bat\n"
                            + "  4) node tools\\apk-check.mjs        ← 确认 APK 内有资源\n"
                            + "安装前请先卸载旧版(签名/版本不同会覆盖失败)。");
            return;
        }
        webView.loadUrl(START_URL);
    }

    // ---------------- APK 内资源服务 ----------------

    /** URL -> APK assets。命中返回 200 响应;本域内未命中返回 404;非本域返回 404(绝不放行到网络) */
    private WebResourceResponse serve(Uri uri) {
        if (uri == null) return notFound("no uri");
        String host = uri.getHost();
        String path = uri.getPath();
        if (host == null || !host.equals(HOST) || path == null || !path.startsWith(PREFIX)) {
            Log.w(TAG, "拦截并 404(非本地资源): " + uri);
            return notFound("out of scope");
        }
        String assetPath = path.substring(PREFIX.length());
        while (assetPath.startsWith("/")) assetPath = assetPath.substring(1);
        if (assetPath.isEmpty() || assetPath.contains("..")) return notFound("bad path");

        InputStream is;
        try {
            is = getAssets().open(assetPath, AssetManager.ACCESS_STREAMING);
        } catch (IOException e) {
            // 正常情况:LDrawLoader 会对候选路径逐个试探,未命中必须是干净的 404
            return notFound("asset missing: " + assetPath);
        }
        String mime = mimeOf(assetPath);
        String enc = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json")
                ? "utf-8" : null;
        WebResourceResponse res = new WebResourceResponse(mime, enc, is);
        res.setStatusCodeAndReasonPhrase(200, "OK");
        Map<String, String> h = new HashMap<String, String>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", assetPath.startsWith("www/ldraw/") ? "max-age=86400" : "no-cache");
        res.setResponseHeaders(h);
        return res;
    }

    private static WebResourceResponse notFound(String why) {
        WebResourceResponse res = new WebResourceResponse(
                "text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        // 注意:reason phrase 必须是非空 ASCII,否则 WebResourceResponse 会抛异常
        res.setStatusCodeAndReasonPhrase(404, "Not Found");
        Map<String, String> h = new HashMap<String, String>();
        h.put("Access-Control-Allow-Origin", "*");
        res.setResponseHeaders(h);
        return res;
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".dat") || p.endsWith(".ldr") || p.endsWith(".mpd") || p.endsWith(".txt")) {
            return "text/plain";
        }
        return "application/octet-stream";
    }

    // ---------------- 诊断 ----------------

    private boolean assetExists(String path) {
        InputStream is = null;
        try {
            is = getAssets().open(path);
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            if (is != null) try { is.close(); } catch (IOException ignored) { }
        }
    }

    private int countAssets(String dir, int limit) {
        int n = 0;
        try {
            String[] names = getAssets().list(dir);
            if (names == null) return 0;
            for (String name : names) {
                if (n >= limit) break;
                String child = dir.isEmpty() ? name : dir + "/" + name;
                String[] sub = getAssets().list(child);
                if (sub != null && sub.length > 0) {
                    n += countAssets(child, limit - n);
                } else {
                    n++;
                }
            }
        } catch (IOException e) {
            Log.w(TAG, "list 失败: " + dir, e);
        }
        return n;
    }

    /** 生成 assets 现状报告,用于判断到底是打包问题还是别的问题 */
    private String assetReport() {
        StringBuilder sb = new StringBuilder();
        try {
            String[] root = getAssets().list("");
            sb.append("assets/ 根目录: ")
              .append(root == null || root.length == 0 ? "(空)" : join(root));
            String[] www = getAssets().list("www");
            sb.append("\nassets/www/: ")
              .append(www == null || www.length == 0 ? "(空或不存在)" : join(www));
            sb.append("\nindex.html: ").append(assetExists(INDEX) ? "存在" : "缺失");
            sb.append("\napp.js: ").append(assetExists("www/assets/app.js") ? "存在" : "缺失");
            sb.append("\nLDConfig.ldr: ").append(assetExists("www/ldraw/LDConfig.ldr") ? "存在" : "缺失");
            sb.append("\nwww 下文件数(最多统计 500): ").append(countAssets("www", 500));
        } catch (IOException e) {
            sb.append("读取 assets 失败: ").append(e.getMessage());
        }
        return sb.toString();
    }

    private static String join(String[] arr) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < arr.length && i < 30; i++) {
            if (i > 0) sb.append(", ");
            sb.append(arr[i]);
        }
        if (arr.length > 30) sb.append(" …(共 ").append(arr.length).append(" 项)");
        return sb.toString();
    }

    private void showDiagnostic(String title, String detail) {
        if (webView == null) return;
        String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{font-family:sans-serif;background:#1a1c20;color:#e8eaed;padding:20px;"
                + "line-height:1.7}h2{color:#ff6b6b;font-size:17px;margin-bottom:10px}"
                + "pre{background:#23262c;padding:12px;border-radius:8px;white-space:pre-wrap;"
                + "font-size:12px;color:#9aa3ad;word-break:break-all}</style></head><body>"
                + "<h2>" + escape(title) + "</h2><pre>" + escape(detail) + "</pre>"
                + "<p style='color:#8a919c;font-size:13px'>把本页截图发回即可定位问题。</p>"
                + "</body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /** WebView 都建不起来时的兜底:用最朴素的控件把异常显示出来,避免闪退无信息 */
    private void showFatal(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        TextView tv = new TextView(this);
        tv.setText("BrickStudio 启动失败\n\n" + sw.toString());
        tv.setTextSize(12f);
        tv.setPadding(32, 48, 32, 32);
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        setContentView(sv);
    }

    // ---------------- 文件选择 / 生命周期 ----------------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (pendingFileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    result = new Uri[] { data.getData() };
                }
                // 取消或失败时必须回传 null,否则 <input type=file> 会永久卡住
                pendingFileCallback.onReceiveValue(result);
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 暴露给页面 JS 的桥:window.BrickBridge.saveFile(name, base64, mime) */
    public class Bridge {

        @JavascriptInterface
        public void saveFile(String name, String base64, String mime) {
            try {
                String safeName = (name == null || name.isEmpty()) ? "untitled" : name;
                safeName = safeName.replaceAll("[/\\\\]", "_");
                String mimeType = (mime == null || mime.isEmpty())
                        ? "application/octet-stream" : mime;

                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);

                Uri uri = getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    throw new IllegalStateException("MediaStore insert 返回 null");
                }
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os == null) {
                        throw new IllegalStateException("无法打开输出流");
                    }
                    os.write(bytes);
                    os.flush();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);

                final String msg = "已保存到 下载/" + safeName;
                runOnUiThread(() ->
                        Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                final String msg = "保存失败: " + e.getMessage();
                runOnUiThread(() ->
                        Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
            }
        }
    }
}
