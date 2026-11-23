package ru.netla.pcremote;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
  private static final String TAG = "PcRemoteWeb";
  private static final String ASSET_HOST = "appassets.local";
  private static final String START_URL = "https://" + ASSET_HOST + "/index.html";
  private static final int BACKGROUND = 0xFF070B14;
  private static final int DISCOVERY_PORT = 8766;
  private static final String UPDATE_INFO_URL =
      "https://github.com/NetlApps/pc-remote/releases/latest/download/version.json";
  private static final String UPDATE_APK_URL =
      "https://github.com/NetlApps/pc-remote/releases/latest/download/PcRemote.apk";
  private static final String UPDATE_ACTION = "ru.netla.pcremote.INSTALL_RESULT";

  private WebView webView;
  private final ExecutorService executor = Executors.newFixedThreadPool(4);

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    webView = new WebView(this);
    webView.setBackgroundColor(BACKGROUND);
    setContentView(webView);
    setupSystemBars();

    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setAllowFileAccess(true);
    settings.setAllowContentAccess(true);
    settings.setAllowFileAccessFromFileURLs(true);
    settings.setAllowUniversalAccessFromFileURLs(true);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    settings.setSupportZoom(false);
    settings.setTextZoom(100);
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      settings.setForceDark(WebSettings.FORCE_DARK_OFF);
    }
    webView.addJavascriptInterface(new PcBridge(), "PcBridge");

    webView.setWebViewClient(
        new WebViewClient() {
          @Override
          public WebResourceResponse shouldInterceptRequest(
              WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri != null && ASSET_HOST.equals(uri.getHost())) {
              String path = uri.getPath();
              if (path == null || path.isEmpty() || "/".equals(path)) {
                path = "/index.html";
              }
              if (path.contains("..")) {
                return textResponse(404, "Not Found", "Недопустимый путь");
              }
              String assetPath = "www" + path;
              try {
                InputStream stream = getAssets().open(assetPath);
                return new WebResourceResponse(mimeType(assetPath), "UTF-8", stream);
              } catch (IOException error) {
                Log.e(TAG, "Не удалось открыть asset: " + assetPath, error);
                return textResponse(404, "Not Found", "Не найден файл: " + assetPath);
              }
            }
            return super.shouldInterceptRequest(view, request);
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleExternalUrl(request.getUrl());
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleExternalUrl(url == null ? null : Uri.parse(url));
          }
        });

    webView.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage message) {
            Log.d(TAG, message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
            return true;
          }
        });

    probeAssets();
    webView.loadUrl(START_URL);
  }

  private void probeAssets() {
    try {
      String[] files = getAssets().list("www");
      Log.i(TAG, "assets/www: " + Arrays.toString(files));
      try (InputStream stream = getAssets().open("www/index.html")) {
        Log.i(TAG, "assets/www/index.html: " + stream.available() + " bytes");
      }
    } catch (Exception error) {
      Log.e(TAG, "Не удалось прочитать assets", error);
    }
  }

  private boolean handleExternalUrl(Uri uri) {
    if (uri == null) return false;
    String scheme = uri.getScheme();
    if (ASSET_HOST.equals(uri.getHost())) return false;
    if ("file".equals(scheme)) return false;
    if ("http".equals(scheme) || "https".equals(scheme)) {
      try {
        startActivity(new Intent(Intent.ACTION_VIEW, uri));
      } catch (Exception ignored) {
        // Нет приложения, которое может открыть ссылку.
      }
      return true;
    }
    return false;
  }

  private static String mimeType(String path) {
    String lower = path.toLowerCase(Locale.US);
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".js")) return "application/javascript";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    return "application/octet-stream";
  }

  private static WebResourceResponse textResponse(int code, String reason, String message) {
    byte[] body = message.getBytes(StandardCharsets.UTF_8);
    return new WebResourceResponse(
        "text/plain",
        "UTF-8",
        code,
        reason,
        null,
        new ByteArrayInputStream(body));
  }

  private void setupSystemBars() {
    try {
      Window window = getWindow();
      window.setStatusBarColor(BACKGROUND);
      window.setNavigationBarColor(BACKGROUND);
      window.setNavigationBarDividerColor(BACKGROUND);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        WindowInsetsController controller = window.getInsetsController();
        if (controller != null) {
          int mask =
              WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                  | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
          controller.setSystemBarsAppearance(0, mask);
        }
      } else {
        View decor = window.getDecorView();
        decor.setSystemUiVisibility(0);
      }
    } catch (Exception ignored) {
      // Оформление системных панелей не критично.
    }
  }

  private void evaluate(String script) {
    if (webView == null) return;
    webView.evaluateJavascript(script, null);
  }

  @Override
  protected void onResume() {
    super.onResume();
    evaluate("window.__onAppResume && window.__onAppResume();");
  }

  @Override
  protected void onPause() {
    evaluate("window.__onAppPause && window.__onAppPause();");
    super.onPause();
  }

  @Override
  public void onBackPressed() {
    if (webView == null) {
      super.onBackPressed();
      return;
    }
    webView.evaluateJavascript(
        "(function(){try{return window.__androidBack ? !!window.__androidBack() : false;}catch(e){return false;}})()",
        value -> {
          if (!"true".equals(value)) {
            finish();
          }
        });
  }

  @Override
  protected void onDestroy() {
    executor.shutdownNow();
    if (webView != null) {
      webView.removeJavascriptInterface("PcBridge");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  private void sendCallback(String function, String callbackId, boolean ok, String payload) {
    String script =
        "window."
            + function
            + "("
            + JSONObject.quote(callbackId)
            + ","
            + (ok ? "true" : "false")
            + ","
            + JSONObject.quote(payload == null ? "" : payload)
            + ");";
    runOnUiThread(
        () -> {
          if (webView != null) webView.evaluateJavascript(script, null);
        });
  }

  private void showToastOnUi(String message) {
    if (message == null) return;
    runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
  }

  private String readText(InputStream stream) {
    if (stream == null) return "";
    try (InputStream input = stream;
        ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[4096];
      int read;
      while ((read = input.read(buffer)) != -1) {
        output.write(buffer, 0, read);
      }
      return output.toString("UTF-8");
    } catch (Exception error) {
      return "";
    }
  }

  private String extractError(String text) {
    if (text == null || text.isEmpty()) return null;
    try {
      JSONObject object = new JSONObject(text);
      if (object.has("error") && !object.isNull("error")) {
        return object.optString("error", null);
      }
      if (object.has("message")) return object.optString("message", null);
    } catch (Exception ignored) {
      // Ответ не JSON.
    }
    return null;
  }

  private byte[] parseMac(String mac) {
    if (mac == null) return null;
    String cleaned = mac.replaceAll("[^0-9A-Fa-f]", "");
    if (cleaned.length() != 12) return null;
    byte[] result = new byte[6];
    try {
      for (int i = 0; i < 6; i++) {
        result[i] = (byte) Integer.parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
      }
    } catch (NumberFormatException error) {
      return null;
    }
    return result;
  }

  private PackageInfo currentPackageInfo() {
    try {
      return getPackageManager().getPackageInfo(getPackageName(), 0);
    } catch (PackageManager.NameNotFoundException error) {
      return null;
    }
  }

  private int currentVersionCode() {
    PackageInfo info = currentPackageInfo();
    if (info == null) return 0;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return (int) info.getLongVersionCode();
    }
    return info.versionCode;
  }

  private String currentVersionName() {
    PackageInfo info = currentPackageInfo();
    return info == null ? "1.0.0" : info.versionName;
  }

  private String fetchText(String urlText, int timeoutMs) throws IOException {
    HttpURLConnection connection = null;
    try {
      URL url = new URL(urlText);
      connection = (HttpURLConnection) url.openConnection();
      connection.setConnectTimeout(Math.min(10000, timeoutMs));
      connection.setReadTimeout(timeoutMs);
      connection.setRequestProperty("Accept", "application/json");
      connection.setRequestProperty("User-Agent", "PcRemote-Android");
      connection.setUseCaches(false);
      int code = connection.getResponseCode();
      if (code < 200 || code >= 300) {
        throw new IOException("GitHub ответил " + code);
      }
      InputStream stream = connection.getInputStream();
      String text = readText(stream);
      if (text.length() > 131072) {
        throw new IOException("Слишком большой ответ GitHub");
      }
      return text;
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private void downloadFile(String urlText, File target, int timeoutMs) throws IOException {
    HttpURLConnection connection = null;
    File temp = new File(target.getAbsolutePath() + ".part");
    if (temp.exists()) temp.delete();
    try {
      URL url = new URL(urlText);
      connection = (HttpURLConnection) url.openConnection();
      connection.setConnectTimeout(12000);
      connection.setReadTimeout(timeoutMs);
      connection.setRequestProperty("User-Agent", "PcRemote-Android");
      connection.setUseCaches(false);
      int code = connection.getResponseCode();
      if (code < 200 || code >= 300) {
        throw new IOException("GitHub ответил " + code);
      }
      long expected = connection.getContentLengthLong();
      long total = 0;
      try (InputStream input = new BufferedInputStream(connection.getInputStream());
          OutputStream output = new FileOutputStream(temp)) {
        byte[] buffer = new byte[32768];
        int read;
        while ((read = input.read(buffer)) != -1) {
          output.write(buffer, 0, read);
          total += read;
        }
      }
      if (total < 20000) {
        throw new IOException("Файл обновления слишком маленький");
      }
      if (expected > 0 && total != expected) {
        throw new IOException("Загрузка оборвалась");
      }
      if (target.exists() && !target.delete()) {
        throw new IOException("Не удалось заменить старый файл обновления");
      }
      if (!temp.renameTo(target)) {
        throw new IOException("Не удалось сохранить обновление");
      }
      Log.i(TAG, "APK обновления скачан: " + total + " байт");
    } finally {
      if (connection != null) connection.disconnect();
      if (temp.exists()) temp.delete();
    }
  }

  private String installApk(File apk) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        && !getPackageManager().canRequestPackageInstalls()) {
      runOnUiThread(
          () -> {
            try {
              Intent intent =
                  new Intent(
                      Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                      Uri.parse("package:" + getPackageName()));
              startActivity(intent);
            } catch (Exception error) {
              Log.e(TAG, "Не удалось открыть разрешение установки", error);
            }
          });
      return "Разрешите установку из этого источника и нажмите «Установить» ещё раз";
    }

    PackageInfo archive = getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
    if (archive == null) {
      return "Скачанный APK повреждён";
    }
    if (!getPackageName().equals(archive.packageName)) {
      return "APK относится к другому приложению";
    }
    int archiveCode =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? (int) archive.getLongVersionCode()
            : archive.versionCode;
    if (archiveCode <= currentVersionCode()) {
      return "Это обновление уже установлено";
    }

    PackageInstaller installer = getPackageManager().getPackageInstaller();
    PackageInstaller.Session session = null;
    try {
      PackageInstaller.SessionParams params =
          new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
      params.setAppPackageName(getPackageName());
      int sessionId = installer.createSession(params);
      session = installer.openSession(sessionId);
      try (InputStream input = new FileInputStream(apk);
          OutputStream output = session.openWrite("base.apk", 0, apk.length())) {
        byte[] buffer = new byte[32768];
        int read;
        while ((read = input.read(buffer)) != -1) {
          output.write(buffer, 0, read);
        }
        output.flush();
        session.fsync(output);
      }
      Intent result =
          new Intent(this, UpdateReceiver.class).setAction(UPDATE_ACTION);
      int flags = PendingIntent.FLAG_UPDATE_CURRENT;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        flags |= PendingIntent.FLAG_MUTABLE;
      }
      PendingIntent pending = PendingIntent.getBroadcast(this, 42, result, flags);
      session.commit(pending.getIntentSender());
      return null;
    } catch (Exception error) {
      Log.e(TAG, "Не удалось запустить установщик", error);
      return "Не удалось запустить установщик: " + error.getMessage();
    } finally {
      if (session != null) {
        try {
          session.close();
        } catch (Exception ignored) {
          // Сессия уже закрыта.
        }
      }
    }
  }

  private boolean isCellular(String name) {
    String lower = name.toLowerCase(Locale.US);
    return lower.startsWith("rmnet")
        || lower.startsWith("ccmni")
        || lower.startsWith("pdp")
        || lower.startsWith("clat");
  }

  private class PcBridge {
    @JavascriptInterface
    public String getVersion() {
      return currentVersionName();
    }

    @JavascriptInterface
    public int getVersionCode() {
      return currentVersionCode();
    }

    @JavascriptInterface
    public void checkUpdate(String callbackId) {
      executor.execute(
          () -> {
            boolean ok = false;
            String payload;
            try {
              String text = fetchText(UPDATE_INFO_URL, 15000);
              JSONObject info = new JSONObject(text);
              int remoteCode = info.optInt("versionCode", 0);
              String remoteName = info.optString("versionName", "");
              JSONObject result = new JSONObject();
              result.put("ok", true);
              result.put("available", remoteCode > currentVersionCode());
              result.put("versionCode", remoteCode);
              result.put("versionName", remoteName);
              result.put("notes", info.optString("notes", ""));
              result.put("size", info.optLong("size", 0));
              result.put("currentVersionName", currentVersionName());
              result.put("currentVersionCode", currentVersionCode());
              result.put("apkUrl", UPDATE_APK_URL);
              payload = result.toString();
              ok = true;
            } catch (Exception error) {
              Log.e(TAG, "Проверка обновлений не удалась", error);
              payload = "Не удалось проверить обновления: " + error.getMessage();
            }
            sendCallback("__nativeUpdate", callbackId, ok, payload);
          });
    }

    @JavascriptInterface
    public void downloadUpdate(String versionName, String callbackId) {
      executor.execute(
          () -> {
            boolean ok = false;
            String message;
            File target =
                new File(new File(getCacheDir(), "updates"), "PcRemote-update.apk");
            try {
              File parent = target.getParentFile();
              if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IOException("Не удалось создать папку обновления");
              }
              Log.i(TAG, "Скачивание обновления " + versionName);
              downloadFile(UPDATE_APK_URL, target, 60000);
              String error = installApk(target);
              if (error == null) {
                ok = true;
                message = "Установщик открыт. Подтвердите обновление";
              } else {
                message = error;
              }
            } catch (Exception error) {
              Log.e(TAG, "Скачивание обновления не удалось", error);
              message = "Не удалось скачать обновление: " + error.getMessage();
            }
            sendCallback("__nativeDownload", callbackId, ok, message);
          });
    }

    @JavascriptInterface
    public String getNetworkInfo() {
      JSONObject result = new JSONObject();
      String bestIp = "";
      String bestBroadcast = "";
      try {
        List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
        for (NetworkInterface nif : interfaces) {
          if (!nif.isUp() || nif.isLoopback()) continue;
          if (isCellular(nif.getName())) continue;
          boolean wifi = nif.getName().toLowerCase(Locale.US).startsWith("wlan");
          for (InterfaceAddress address : nif.getInterfaceAddresses()) {
            InetAddress ip = address.getAddress();
            if (!(ip instanceof Inet4Address) || ip.isLoopbackAddress()) continue;
            String text = ip.getHostAddress();
            if (text == null || text.isEmpty()) continue;
            InetAddress broadcast = address.getBroadcast();
            if (bestIp.isEmpty() || wifi) {
              bestIp = text;
              bestBroadcast = broadcast == null ? "" : broadcast.getHostAddress();
            }
          }
        }
      } catch (Exception error) {
        Log.d(TAG, "getNetworkInfo: " + error.getMessage());
      }
      try {
        result.put("ip", bestIp);
        result.put("broadcast", bestBroadcast);
      } catch (Exception ignored) {
        // JSONObject.put не бросает исключений для строк.
      }
      return result.toString();
    }

    @JavascriptInterface
    public void wake(String mac, String pcIp, String broadcastIp) {
      executor.execute(
          () -> {
            DatagramSocket socket = null;
            try {
              byte[] macBytes = parseMac(mac);
              if (macBytes == null) {
                showToastOnUi("Неверный MAC-адрес");
                return;
              }
              byte[] packet = new byte[6 + 16 * 6];
              for (int i = 0; i < 6; i++) packet[i] = (byte) 0xFF;
              for (int repeat = 0; repeat < 16; repeat++) {
                System.arraycopy(macBytes, 0, packet, 6 + repeat * 6, 6);
              }

              Set<String> targets = new HashSet<>();
              if (broadcastIp != null && !broadcastIp.trim().isEmpty()) {
                targets.add(broadcastIp.trim());
              }
              targets.add("255.255.255.255");
              if (pcIp != null && !pcIp.trim().isEmpty()) targets.add(pcIp.trim());
              for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                if (isCellular(nif.getName())) continue;
                for (InterfaceAddress address : nif.getInterfaceAddresses()) {
                  InetAddress broadcast = address.getBroadcast();
                  if (broadcast != null) targets.add(broadcast.getHostAddress());
                }
              }

              socket = new DatagramSocket();
              socket.setBroadcast(true);
              for (int round = 0; round < 3; round++) {
                for (String target : targets) {
                  InetAddress address;
                  try {
                    address = InetAddress.getByName(target);
                  } catch (Exception ignored) {
                    continue;
                  }
                  for (int port : new int[] {9, 7}) {
                    try {
                      socket.send(new DatagramPacket(packet, packet.length, address, port));
                    } catch (Exception ignored) {
                      // Некоторые интерфейсы не умеют broadcast — пропускаем.
                    }
                  }
                }
                try {
                  Thread.sleep(130);
                } catch (InterruptedException ignored) {
                  Thread.currentThread().interrupt();
                }
              }
              Log.d(TAG, "WoL отправлен: " + mac + " -> " + targets);
            } catch (Exception error) {
              Log.e(TAG, "WoL failed", error);
              showToastOnUi("Не удалось отправить WoL: " + error.getMessage());
            } finally {
              if (socket != null) socket.close();
            }
          });
    }

    @JavascriptInterface
    public void httpRequest(
        String url,
        String method,
        String token,
        String body,
        String callbackId,
        int timeoutMs) {
      executor.execute(
          () -> {
            boolean ok = false;
            String payload;
            HttpURLConnection connection = null;
            try {
              URL target = new URL(url);
              int timeout = Math.max(2500, Math.min(timeoutMs, 60000));
              connection = (HttpURLConnection) target.openConnection();
              connection.setConnectTimeout(Math.min(5000, timeout));
              connection.setReadTimeout(timeout);
              connection.setRequestMethod("POST".equalsIgnoreCase(method) ? "POST" : "GET");
              connection.setRequestProperty("Accept", "application/json");
              connection.setRequestProperty("X-Auth-Token", token == null ? "" : token);
              connection.setUseCaches(false);
              if ("POST".equalsIgnoreCase(method)) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream out = connection.getOutputStream()) {
                  out.write((body == null ? "" : body).getBytes(StandardCharsets.UTF_8));
                }
              }
              int code = connection.getResponseCode();
              InputStream stream =
                  code >= 400 ? connection.getErrorStream() : connection.getInputStream();
              String text = readText(stream);
              if (code >= 200 && code < 300) {
                ok = true;
                payload = text == null || text.isEmpty() ? "{}" : text;
              } else {
                String message = extractError(text);
                if (code == 401) {
                  message = "Неверный токен доступа";
                } else if (code == 403) {
                  message = "Доступ разрешён только из домашней сети";
                } else if (code == 429) {
                  message = "Слишком много попыток. Подождите минуту";
                } else if (message == null) {
                  message = "Ошибка сервера (" + code + ")";
                }
                payload = message;
              }
            } catch (SocketTimeoutException error) {
              payload = "ПК не отвечает. Проверьте IP, Wi-Fi и агент";
            } catch (ConnectException error) {
              payload = "Не удалось подключиться. Агент запущен? IP верный?";
            } catch (Exception error) {
              String detail = error.getMessage();
              payload = "Ошибка сети: " + (detail == null ? error.getClass().getSimpleName() : detail);
            } finally {
              if (connection != null) connection.disconnect();
            }
            sendCallback("__nativeHttp", callbackId, ok, payload);
          });
    }

    @JavascriptInterface
    public void discover(String callbackId) {
      executor.execute(
          () -> {
            DatagramSocket socket = null;
            LinkedHashMap<String, JSONObject> found = new LinkedHashMap<>();
            try {
              socket = new DatagramSocket();
              socket.setBroadcast(true);
              socket.setSoTimeout(250);
              byte[] request = "PCREMOTE_DISCOVER_V1".getBytes(StandardCharsets.US_ASCII);

              Set<String> targets = new HashSet<>();
              targets.add("255.255.255.255");
              for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                if (isCellular(nif.getName())) continue;
                for (InterfaceAddress address : nif.getInterfaceAddresses()) {
                  InetAddress broadcast = address.getBroadcast();
                  if (broadcast != null) targets.add(broadcast.getHostAddress());
                }
              }

              for (int round = 0; round < 2; round++) {
                for (String target : targets) {
                  try {
                    socket.send(
                        new DatagramPacket(
                            request, request.length, InetAddress.getByName(target), DISCOVERY_PORT));
                  } catch (Exception ignored) {
                    // Пропускаем недоступный интерфейс.
                  }
                }
              }

              long deadline = System.currentTimeMillis() + 2600;
              byte[] buffer = new byte[4096];
              while (System.currentTimeMillis() < deadline) {
                try {
                  DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                  socket.receive(packet);
                  String text =
                      new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                  JSONObject reply = new JSONObject(text);
                  if (!"pcremote".equals(reply.optString("app"))) continue;
                  reply.put("ip", packet.getAddress().getHostAddress());
                  found.put(reply.optString("ip"), reply);
                } catch (SocketTimeoutException ignored) {
                  // Продолжаем ждать до дедлайна.
                } catch (Exception error) {
                  Log.d(TAG, "discover packet: " + error.getMessage());
                }
              }

              JSONArray array = new JSONArray();
              for (JSONObject item : found.values()) array.put(item);
              sendCallback("__nativeDiscover", callbackId, true, array.toString());
            } catch (Exception error) {
              Log.e(TAG, "discover failed", error);
              sendCallback(
                  "__nativeDiscover",
                  callbackId,
                  false,
                  "Не удалось выполнить поиск: " + error.getMessage());
            } finally {
              if (socket != null) socket.close();
            }
          });
    }

    @JavascriptInterface
    public void vibrate(int milliseconds) {
      try {
        Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vibrator != null && vibrator.hasVibrator()) {
          vibrator.vibrate(Math.max(1, Math.min(60, milliseconds)));
        }
      } catch (Exception ignored) {
        // Вибрация не критична.
      }
    }

    @JavascriptInterface
    public void toast(String message) {
      showToastOnUi(message);
    }
  }
}
