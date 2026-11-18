package net.witbox.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.json.JSONObject;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Full-window WebView shell + JS⇄native bridge (CLIENT_CONTRACT §1, §2). */
public class MainActivity extends Activity {
    static final String EXTRA_URL = "url";

    private static final String TAG = "CBMain";
    private static final int REQ_PERMS = 100;
    private static final int REQ_FILE = 200;
    private static final int REQ_SERVER = 300;
    private static final String KEY_FIRST_RUN_DONE = "first_run_prompts_done";

    private static WeakReference<MainActivity> current = new WeakReference<>(null);

    private final Handler main = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView webView;
    private View errorView;
    private TextView errorTitle;
    private TextView errorBody;
    private Button retryButton;
    private Button changeButton;
    private ProgressBar progress;
    private FrameLayout fullscreenHolder;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    private SpeechController speech;
    private boolean destroyed;
    private boolean loadError;
    private boolean pageShown;

    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraOutput;
    private PermissionRequest pendingWebPermission;
    private AlertDialog raiseDialog;

    // ---- runtime permission queue (only one system dialog can be in flight) ----
    private static final class PermReq {
        final String[] perms;
        final Runnable done;

        PermReq(String[] perms, Runnable done) {
            this.perms = perms;
            this.done = done;
        }
    }

    private final ArrayDeque<PermReq> permQueue = new ArrayDeque<>();
    private PermReq activePerm;

    // =====================================================================================
    // Lifecycle
    // =====================================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);

        buildUi();
        setupWebView();

        speech = new SpeechController(this, this::emit);

        String deep = deepLinkUrl(getIntent());
        if (!Prefs.hasServer(this)) {
            // First run: there is no built-in server, ask for the address.
            showNoServer();
            if (savedInstanceState == null) openServerScreen();
            return;
        }
        if (savedInstanceState != null && webView.restoreState(savedInstanceState) != null && deep == null) {
            Log.i(TAG, "restored WebView state");
        } else if (deep != null) {
            loadUrl(deep);
        } else {
            loadHome();
        }

        NotifyService.start(this);
        DeviceLink.ensureStarted(this);
        firstRunPrompts();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String deep = deepLinkUrl(intent);
        if (deep != null) openDeepLink(deep);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        // The service may have been killed while we were in the background.
        NotifyService.start(this);
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null && !loadError) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (current.get() == this) current = new WeakReference<>(null);
        main.removeCallbacksAndMessages(null);
        if (speech != null) speech.destroy();
        try {
            if (raiseDialog != null && raiseDialog.isShowing()) raiseDialog.dismiss(); // ⇒ denied
        } catch (Throwable ignored) {
        }
        raiseDialog = null;
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) {
            try {
                webView.stopLoading();
                webView.removeJavascriptInterface("WitBoxNative");
                webView.setWebChromeClient(null);
                root.removeView(webView);
                webView.destroy();
            } catch (Throwable ignored) {
            }
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (customView != null) {
            hideCustomView();
            return;
        }
        if (webView != null && errorView.getVisibility() != View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // Keep the activity (and the page state) alive; the service keeps running anyway.
        if (!moveTaskToBack(true)) super.onBackPressed();
    }

    // =====================================================================================
    // UI
    // =====================================================================================

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private void buildUi() {
        final int bg = getColor(R.color.bg);
        root = new FrameLayout(this);
        root.setBackgroundColor(bg);

        webView = new WebView(this);
        webView.setBackgroundColor(bg);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this);
        progress.setIndeterminate(true);
        progress.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(getColor(R.color.accent)));
        root.addView(progress, new FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER));

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        fullscreenHolder = new FrameLayout(this);
        fullscreenHolder.setBackgroundColor(Color.BLACK);
        fullscreenHolder.setVisibility(View.GONE);
        root.addView(fullscreenHolder, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        // Edge-to-edge, with the content padded by the system bars, display cutout and the IME so the
        // WebView is never covered (the page gets a real viewport resize when the keyboard opens).
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        WindowInsetsControllerCompat ic = WindowCompat.getInsetsController(getWindow(), root);
        ic.setAppearanceLightStatusBars(false);
        ic.setAppearanceLightNavigationBars(false);

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);
    }

    private View buildErrorView() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        col.setBackgroundColor(getColor(R.color.bg));
        col.setPadding(dp(32), dp(32), dp(32), dp(32));
        col.setClickable(true);

        android.widget.ImageView icon = new android.widget.ImageView(this);
        icon.setImageResource(R.drawable.ic_launcher_foreground);
        col.addView(icon, new LinearLayout.LayoutParams(dp(120), dp(120)));

        TextView title = errorTitle = new TextView(this);
        title.setText(R.string.err_title);
        title.setTextColor(getColor(R.color.text));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setGravity(Gravity.CENTER);
        col.addView(title);

        errorBody = new TextView(this);
        errorBody.setTextColor(getColor(R.color.text_dim));
        errorBody.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        errorBody.setGravity(Gravity.CENTER);
        errorBody.setPadding(0, dp(10), 0, dp(24));
        col.addView(errorBody, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        Button retry = retryButton = pill(getString(R.string.retry), getColor(R.color.accent), Color.WHITE);
        retry.setOnClickListener(v -> loadHome());
        col.addView(retry, new LinearLayout.LayoutParams(dp(240), ViewGroup.LayoutParams.WRAP_CONTENT));

        Button change = changeButton = pill(getString(R.string.change_server), getColor(R.color.surface), getColor(R.color.text));
        change.setOnClickListener(v -> openServerScreen());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(240), ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(10);
        col.addView(change, lp);

        TextView credit = new TextView(this);
        credit.setText(getString(R.string.credit, BuildConfig.VERSION_NAME));
        credit.setTextColor(getColor(R.color.text_dim));
        credit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        credit.setGravity(Gravity.CENTER);
        credit.setAlpha(0.8f);
        LinearLayout.LayoutParams crLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        crLp.topMargin = dp(28);
        col.addView(credit, crLp);
        return col;
    }

    private Button pill(String text, int bgColor, int textColor) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(textColor);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        GradientDrawable d = new GradientDrawable();
        d.setColor(bgColor);
        d.setCornerRadius(dp(12));
        b.setBackground(d);
        b.setStateListAnimator(null);
        b.setMinHeight(dp(48));
        return b;
    }

    private void showError() {
        if (!Prefs.hasServer(this)) {
            showNoServer();
            return;
        }
        loadError = true;
        progress.setVisibility(View.GONE);
        errorTitle.setText(R.string.err_title);
        errorBody.setText(getString(R.string.err_body, Prefs.serverUrl(this)));
        retryButton.setVisibility(View.VISIBLE);
        changeButton.setText(R.string.change_server);
        errorView.setVisibility(View.VISIBLE);
    }

    /** No server address yet (first run, or the first-run screen was dismissed). */
    private void showNoServer() {
        loadError = true;
        progress.setVisibility(View.GONE);
        errorTitle.setText(R.string.no_server_title);
        errorBody.setText(R.string.no_server_body);
        retryButton.setVisibility(View.GONE);
        changeButton.setText(R.string.set_server);
        errorView.setVisibility(View.VISIBLE);
    }

    /** Loads the web UI of the configured server, or asks for a server when there is none. */
    private void loadHome() {
        if (!Prefs.hasServer(this)) {
            showNoServer();
            return;
        }
        loadUrl(Prefs.serverUrl(this) + "/");
    }

    private void loadUrl(String url) {
        if (webView == null) return;
        loadError = false;
        errorView.setVisibility(View.GONE);
        if (!pageShown) progress.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private void openServerScreen() {
        startActivityForResult(new Intent(this, ServerUrlActivity.class), REQ_SERVER);
    }

    // =====================================================================================
    // Deep links (notification taps): SERVER_URL + "/#/bot/<id>"
    // =====================================================================================

    private String deepLinkUrl(Intent intent) {
        if (intent == null) return null;
        // Re-launch from Recents re-delivers the old notification intent: do not replay it.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;
        String path = intent.getStringExtra(EXTRA_URL);
        if (TextUtils.isEmpty(path)) return null;
        intent.removeExtra(EXTRA_URL); // do not replay on recreation
        String base = Prefs.serverUrl(this);
        if (base.isEmpty()) return null;
        if (path.startsWith("/") && !path.startsWith("//")) return base + path;
        // Absolute URLs are only accepted for the configured server.
        if (Prefs.sameOrigin(path, base)) return path;
        return null;
    }

    private void openDeepLink(String url) {
        if (webView == null) return;
        String base = Prefs.serverUrl(this);
        String cur = webView.getUrl();
        int hash = url.indexOf('#');
        // Same single-page app already loaded: just switch the route instead of reloading.
        if (!loadError && pageShown && cur != null && hash >= 0 && Prefs.sameOrigin(cur, base)
                && stripHash(cur).equals(stripHash(url))) {
            webView.evaluateJavascript("window.location.hash=" + JSONObject.quote(url.substring(hash)) + ";", null);
        } else {
            loadUrl(url);
        }
    }

    private static String stripHash(String u) {
        int i = u.indexOf('#');
        return i >= 0 ? u.substring(0, i) : u;
    }

    // =====================================================================================
    // WebView
    // =====================================================================================

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " WitBoxApp/" + BuildConfig.VERSION_NAME + " (android)");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, false);

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new Bridge(), "WitBoxNative");
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
                onDownload(url, userAgent, contentDisposition, mimetype));
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            boolean web = scheme.equals("http") || scheme.equals("https");
            if (web && Prefs.isServerOrigin(MainActivity.this, u.toString())) return false;
            if (!request.isForMainFrame()) {
                return !web; // embedded frames may load web content, nothing else
            }
            openExternal(u);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (!pageShown && !loadError) progress.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (loadError) return;
            pageShown = true;
            progress.setVisibility(View.GONE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progress.setVisibility(View.GONE);
            if (loadError) return;
            pageShown = true;
            errorView.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                Log.w(TAG, "load error " + error.getErrorCode() + " " + error.getDescription());
                showError();
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            // "tailscale serve" answers 502 when the backend is down.
            if (request != null && request.isForMainFrame() && response != null && response.getStatusCode() >= 500) {
                showError();
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel(); // never proceed on certificate errors
            if (error != null && Prefs.sameOrigin(error.getUrl(), view.getUrl() == null
                    ? Prefs.serverUrl(MainActivity.this) : view.getUrl())) {
                showError();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.w(TAG, "WebView renderer gone, recreating");
            main.post(() -> {
                if (!destroyed) recreate();
            });
            return true;
        }
    }

    private void openExternal(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "http":
            case "https":
            case "mailto":
            case "tel":
            case "sms":
            case "geo":
            case "market":
                break;
            default:
                return; // ignore intent:, javascript:, file:, …
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, u);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            main.post(() -> handleWebPermission(request));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            main.post(() -> {
                if (pendingWebPermission == request) pendingWebPermission = null;
            });
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            final boolean multiple = params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
            final String[] accept = params == null ? null : params.getAcceptTypes();
            final boolean wantsImage = acceptsImages(accept);
            if (wantsImage && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                    && getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                requestPerms(new String[]{Manifest.permission.CAMERA}, () -> launchChooser(accept, multiple, wantsImage));
            } else {
                launchChooser(accept, multiple, wantsImage);
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            fullscreenHolder.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            fullscreenHolder.setVisibility(View.VISIBLE);
            WindowInsetsControllerCompat ic = WindowCompat.getInsetsController(getWindow(), root);
            ic.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            ic.hide(WindowInsetsCompat.Type.systemBars());
        }

        @Override
        public void onHideCustomView() {
            hideCustomView();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            // Avoids the grey "play" placeholder (and a NPE in some WebView versions).
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        }
    }

    private void hideCustomView() {
        if (customView == null) return;
        fullscreenHolder.removeView(customView);
        fullscreenHolder.setVisibility(View.GONE);
        customView = null;
        WindowCompat.getInsetsController(getWindow(), root).show(WindowInsetsCompat.Type.systemBars());
        if (customViewCallback != null) {
            try {
                customViewCallback.onCustomViewHidden();
            } catch (Throwable ignored) {
            }
            customViewCallback = null;
        }
    }

    // ---- getUserMedia ----

    private void handleWebPermission(final PermissionRequest request) {
        if (destroyed) return;
        try {
            Uri origin = request.getOrigin();
            if (origin == null || !Prefs.isServerOrigin(this, origin.toString())) {
                request.deny();
                return;
            }
            List<String> need = new ArrayList<>();
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                    need.add(Manifest.permission.RECORD_AUDIO);
                } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                    need.add(Manifest.permission.CAMERA);
                }
            }
            pendingWebPermission = request;
            requestPerms(need.toArray(new String[0]), () -> {
                if (pendingWebPermission != request) return; // cancelled by the page meanwhile
                pendingWebPermission = null;
                List<String> grant = new ArrayList<>();
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                        if (granted(Manifest.permission.RECORD_AUDIO)) grant.add(r);
                    } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                        if (granted(Manifest.permission.CAMERA)) grant.add(r);
                    } else if (PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID.equals(r)) {
                        grant.add(r);
                    }
                }
                try {
                    if (grant.isEmpty()) request.deny();
                    else request.grant(grant.toArray(new String[0]));
                } catch (Throwable t) {
                    Log.w(TAG, "web permission: " + t);
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "web permission: " + t);
        }
    }

    // ---- <input type=file> ----

    private static boolean acceptsImages(String[] accept) {
        if (accept == null || accept.length == 0) return true;
        boolean any = false;
        for (String a : accept) {
            if (a == null || a.trim().isEmpty()) continue;
            any = true;
            String t = a.trim().toLowerCase(Locale.ROOT);
            if (t.equals("*/*") || t.startsWith("image/") || t.equals(".jpg") || t.equals(".jpeg") || t.equals(".png")) {
                return true;
            }
        }
        return !any;
    }

    private void launchChooser(String[] accept, boolean multiple, boolean offerCamera) {
        if (fileCallback == null || destroyed) return;
        try {
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            List<String> mimes = new ArrayList<>();
            if (accept != null) {
                for (String a : accept) {
                    if (a == null) continue;
                    String t = a.trim();
                    if (t.isEmpty()) continue;
                    if (t.startsWith(".")) {
                        String m = android.webkit.MimeTypeMap.getSingleton()
                                .getMimeTypeFromExtension(t.substring(1).toLowerCase(Locale.ROOT));
                        if (m != null) mimes.add(m);
                        else {
                            mimes.clear();
                            mimes.add("*/*");
                            break;
                        }
                    } else if (t.contains("/")) {
                        mimes.add(t);
                    }
                }
            }
            if (mimes.size() == 1) {
                pick.setType(mimes.get(0));
            } else {
                pick.setType("*/*");
                if (mimes.size() > 1 && !mimes.contains("*/*")) {
                    pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                }
            }
            if (multiple) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

            Intent chooser = Intent.createChooser(pick, getString(R.string.file_chooser_title));

            cameraOutput = null;
            if (offerCamera && granted(Manifest.permission.CAMERA)) {
                try {
                    File dir = new File(getCacheDir(), "captures");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File[] old = dir.listFiles();
                    if (old != null) {
                        long cutoff = System.currentTimeMillis() - 24 * 3600_000L;
                        for (File f : old) if (f.lastModified() < cutoff) f.delete();
                    }
                    File photo = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
                    Uri out = FileProvider.getUriForFile(this, getPackageName() + ".files", photo);
                    Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    cam.putExtra(MediaStore.EXTRA_OUTPUT, out);
                    cam.setClipData(ClipData.newRawUri("photo", out));
                    cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    if (cam.resolveActivity(getPackageManager()) != null) {
                        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
                        cameraOutput = out;
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "camera capture unavailable: " + t);
                }
            }
            startActivityForResult(chooser, REQ_FILE);
        } catch (Throwable t) {
            Log.w(TAG, "file chooser failed: " + t);
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            ValueCallback<Uri[]> cb = fileCallback;
            fileCallback = null;
            Uri cam = cameraOutput;
            cameraOutput = null;
            if (cb == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                List<Uri> uris = new ArrayList<>();
                if (data != null) {
                    ClipData clip = data.getClipData();
                    if (clip != null) {
                        for (int i = 0; i < clip.getItemCount(); i++) {
                            Uri u = clip.getItemAt(i).getUri();
                            if (u != null) uris.add(u);
                        }
                    }
                    if (uris.isEmpty() && data.getData() != null) uris.add(data.getData());
                }
                if (uris.isEmpty() && cam != null) {
                    // The camera app wrote into our FileProvider file.
                    try {
                        File f = new File(new File(getCacheDir(), "captures"), cam.getLastPathSegment());
                        if (f.length() > 0) uris.add(cam);
                    } catch (Throwable ignored) {
                    }
                }
                if (!uris.isEmpty()) result = uris.toArray(new Uri[0]);
            }
            cb.onReceiveValue(result);
        } else if (requestCode == REQ_SERVER) {
            if (resultCode == RESULT_OK && webView != null) {
                pageShown = false;
                webView.clearHistory();
                loadHome();
                main.postDelayed(() -> {
                    if (webView != null) webView.clearHistory();
                }, 1500);
                // On first run these were skipped until a server existed.
                NotifyService.start(this);
                DeviceLink.ensureStarted(this);
                firstRunPrompts();
            }
        }
    }

    // ---- downloads ----

    private void onDownload(final String url, final String userAgent, final String contentDisposition,
                            final String mimetype) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show();
            return;
        }
        if (Build.VERSION.SDK_INT < 29) {
            requestPerms(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    () -> startDownload(url, userAgent, contentDisposition, mimetype));
        } else {
            startDownload(url, userAgent, contentDisposition, mimetype);
        }
    }

    private void startDownload(String url, String userAgent, String contentDisposition, String mimetype) {
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String cookies = CookieManager.getInstance().getCookie(url);
            if (!TextUtils.isEmpty(cookies)) r.addRequestHeader("Cookie", cookies);
            if (!TextUtils.isEmpty(userAgent)) r.addRequestHeader("User-Agent", userAgent);
            if (!TextUtils.isEmpty(mimetype)) r.setMimeType(mimetype);
            r.setTitle(name);
            r.setDescription(getString(R.string.app_name));
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= 29 || granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            } else {
                r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            }
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("no DownloadManager");
            dm.enqueue(r);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_LONG).show();
        } catch (Throwable t) {
            Log.w(TAG, "download failed: " + t);
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    // =====================================================================================
    // Runtime permissions
    // =====================================================================================

    private boolean granted(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** Requests the missing permissions (if any), then runs {@code done}; done re-checks what it needs. */
    private void requestPerms(String[] perms, Runnable done) {
        List<String> missing = new ArrayList<>();
        for (String p : perms) if (!granted(p) && !missing.contains(p)) missing.add(p);
        if (missing.isEmpty()) {
            done.run();
            return;
        }
        permQueue.add(new PermReq(missing.toArray(new String[0]), done));
        pumpPerms();
    }

    private void pumpPerms() {
        if (activePerm != null || destroyed) return;
        PermReq next = permQueue.poll();
        if (next == null) return;
        activePerm = next;
        try {
            requestPermissions(next.perms, REQ_PERMS);
        } catch (Throwable t) {
            activePerm = null;
            next.done.run();
            pumpPerms();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERMS) return;
        PermReq r = activePerm;
        activePerm = null;
        if (r != null) {
            try {
                r.done.run();
            } catch (Throwable t) {
                Log.e(TAG, "permission continuation failed", t);
            }
        }
        pumpPerms();
    }

    /** First launch: notification permission (Android 13+), then battery-optimisation exemption. */
    private void firstRunPrompts() {
        if (Prefs.sp(this).getBoolean(KEY_FIRST_RUN_DONE, false)) return;
        Prefs.sp(this).edit().putBoolean(KEY_FIRST_RUN_DONE, true).apply();
        Runnable battery = () -> main.postDelayed(this::askBatteryExemption, 600);
        if (Build.VERSION.SDK_INT >= 33) {
            requestPerms(new String[]{Manifest.permission.POST_NOTIFICATIONS}, () -> {
                NotifyService.start(this); // re-post the status notification now that it may be visible
                battery.run();
            });
        } else {
            battery.run();
        }
    }

    @SuppressLint("BatteryLife")
    private void askBatteryExemption() {
        if (destroyed) return;
        try {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            // Lets the notification socket stay connected in Doze; the user can decline.
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Throwable t) {
            Log.w(TAG, "battery exemption prompt unavailable: " + t);
        }
    }

    // =====================================================================================
    // Bridge: native → web
    // =====================================================================================

    private static String js(JSONObject o) {
        // JSON is valid JS except for these two separators in old engines.
        return (o == null ? "{}" : o.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    private void eval(final String script) {
        Runnable r = () -> {
            if (destroyed || webView == null) return;
            try {
                webView.evaluateJavascript(script, null);
            } catch (Throwable t) {
                Log.w(TAG, "evaluateJavascript failed: " + t);
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else main.post(r);
    }

    private void reply(Object id, JSONObject result) {
        String idJs;
        if (id instanceof Number) idJs = id.toString();
        else if (id == null || id == JSONObject.NULL) idJs = "null";
        else idJs = JSONObject.quote(String.valueOf(id));
        eval("window.cbNative&&window.cbNative.resolve&&window.cbNative.resolve(" + idJs + "," + js(result) + ");");
    }

    private void replyOk(Object id) {
        reply(id, put(new JSONObject(), "ok", true));
    }

    private void replyError(Object id, String message) {
        reply(id, put(new JSONObject(), "error", message));
    }

    void emit(String event, JSONObject data) {
        eval("window.cbNative&&window.cbNative.emit&&window.cbNative.emit(" + JSONObject.quote(event) + ","
                + js(data) + ");");
    }

    /** Any thread; no-op when the UI is not running. */
    static void emitToPage(String event, JSONObject data) {
        MainActivity a = current.get();
        if (a != null && !a.destroyed) a.emit(event, data);
    }

    private static JSONObject put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Throwable ignored) {
        }
        return o;
    }

    // =====================================================================================
    // Bridge: web → native
    // =====================================================================================

    private final class Bridge {
        /** Called on the WebView's JavaBridge thread. */
        @JavascriptInterface
        public void postMessage(final String json) {
            main.post(() -> handleMessage(json));
        }
    }

    private void applyLevel(String botId, String level) {
        Prefs.setLevel(this, botId, level);
        PermissionGate.onLevelChanged(this, botId, level);
    }

    /** Shortens and strips control characters from page-supplied display text. */
    private static String displayText(String s, int max) {
        String t = s == null ? "" : s.replaceAll("[\\p{Cntrl}\\p{Cf}\\s]+", " ").trim();
        return t.length() > max ? t.substring(0, max) + "…" : t;
    }

    /** Native confirmation for never→ask, never→always and ask→always. */
    private void confirmRaise(final Object id, final String botId, String botName, final String level) {
        if (destroyed || isFinishing()) {
            replyError(id, "denied");
            return;
        }
        if (raiseDialog != null && raiseDialog.isShowing()) {
            // One request at a time; a page cannot stack dialogs to wear the user down.
            replyError(id, "denied");
            return;
        }
        String shownId = displayText(botId, 60);
        String name = displayText(botName, 60);
        String who = name.isEmpty() || name.equals(shownId) ? shownId : name + " (" + shownId + ")";
        String levelText = getString(Prefs.LEVEL_ALWAYS.equals(level)
                ? R.string.level_always : R.string.level_ask);
        final boolean[] answered = {false};
        try {
            AlertDialog d = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setIcon(R.mipmap.ic_launcher)
                    .setTitle(R.string.confirm_raise_title)
                    .setMessage(getString(R.string.confirm_raise_msg, who, levelText))
                    .setPositiveButton(R.string.allow, (dlg, w) -> {
                        if (answered[0]) return;
                        answered[0] = true;
                        if (destroyed) return;
                        applyLevel(botId, level);
                        replyOk(id);
                    })
                    .setNegativeButton(R.string.cancel, (dlg, w) -> {
                        if (answered[0]) return;
                        answered[0] = true;
                        replyError(id, "denied");
                    })
                    .create();
            d.setCanceledOnTouchOutside(false);
            // Back / any other dismissal without an answer counts as Cancel.
            d.setOnDismissListener(dlg -> {
                if (raiseDialog == dlg) raiseDialog = null;
                if (!answered[0]) {
                    answered[0] = true;
                    replyError(id, "denied");
                }
            });
            raiseDialog = d;
            d.show();
        } catch (Throwable t) {
            Log.w(TAG, "confirmation dialog failed: " + t);
            raiseDialog = null;
            if (!answered[0]) {
                answered[0] = true;
                replyError(id, "denied");
            }
        }
    }

    private boolean controlEnabled() {
        if (ControlService.get() != null) return true;
        try {
            String enabled = Settings.Secure.getString(getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (enabled == null) return false;
            String me = new ComponentName(this, ControlService.class).flattenToString();
            String meShort = new ComponentName(this, ControlService.class).flattenToShortString();
            for (String s : enabled.split(":")) {
                if (s.equalsIgnoreCase(me) || s.equalsIgnoreCase(meShort)) return true;
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    private void handleMessage(String json) {
        if (destroyed || webView == null) return;
        // Only the configured server's pages may talk to the native side. This runs on the UI thread and
        // WebView.getUrl() is the URL of the top-level (main frame) document, so a call is rejected
        // whenever the top-level page is not on the configured server origin.
        if (!Prefs.isServerOrigin(this, webView.getUrl())) {
            Log.w(TAG, "bridge call from foreign origin ignored");
            return;
        }
        final Object id;
        final String cmd;
        final JSONObject args;
        try {
            JSONObject msg = new JSONObject(json);
            id = msg.opt("id");
            cmd = msg.optString("cmd", "");
            JSONObject a = msg.optJSONObject("args");
            args = a == null ? new JSONObject() : a;
        } catch (Throwable t) {
            Log.w(TAG, "bad bridge message");
            return;
        }

        try {
            switch (cmd) {
                case "getDeviceInfo": {
                    JSONObject o = new JSONObject();
                    o.put("deviceId", Prefs.deviceId(this));
                    o.put("name", Prefs.deviceName(this));
                    o.put("platform", Prefs.PLATFORM);
                    o.put("appVersion", BuildConfig.VERSION_NAME);
                    o.put("controlAvailable", BuildConfig.CONTROL);
                    o.put("controlEnabled", controlEnabled());
                    reply(id, o);
                    break;
                }
                case "getPermissions":
                    reply(id, Prefs.allLevels(this));
                    break;
                case "setPermission": {
                    final String botId = args.optString("botId", "");
                    final String level = args.optString("level", "");
                    if (botId.isEmpty() || !Prefs.isValidLevel(level)) {
                        replyError(id, "invalid botId or level");
                        break;
                    }
                    String oldLevel = Prefs.getLevel(this, botId);
                    if (Prefs.levelRank(level) <= Prefs.levelRank(oldLevel)) {
                        // Lowering (or no change) never needs confirmation.
                        applyLevel(botId, level);
                        replyOk(id);
                        break;
                    }
                    // Raising privilege: the page (or a frame inside it) cannot do this on its own;
                    // the user must confirm in a native dialog.
                    confirmRaise(id, botId, args.optString("botName", ""), level);
                    break;
                }
                case "openControlSetup": {
                    if (!BuildConfig.CONTROL) { replyError(id, "not available in this edition"); break; }
                    try {
                        startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                        if (!controlEnabled()) {
                            Toast.makeText(this, R.string.a11y_hint, Toast.LENGTH_LONG).show();
                        }
                        replyOk(id);
                    } catch (Throwable t) {
                        replyError(id, "cannot open accessibility settings");
                    }
                    break;
                }
                case "startListening": {
                    final String lang = args.optString("lang", "");
                    requestPerms(new String[]{Manifest.permission.RECORD_AUDIO}, () -> {
                        if (destroyed) return;
                        if (!granted(Manifest.permission.RECORD_AUDIO)) {
                            replyError(id, "microphone permission denied");
                            return;
                        }
                        String err = speech.startListening(lang);
                        if (err != null) replyError(id, err);
                        else replyOk(id);
                    });
                    break;
                }
                case "stopListening":
                    speech.stopListening();
                    replyOk(id);
                    break;
                case "speak":
                    replyOk(id);
                    speech.setRate((float) args.optDouble("rate", 1.0));
                    speech.speak(args.optString("text", ""), args.optString("lang", ""));
                    break;
                case "stopSpeaking":
                    speech.stopSpeaking();
                    replyOk(id);
                    break;
                case "getServerUrl":
                    reply(id, put(new JSONObject(), "url", Prefs.serverUrl(this)));
                    break;
                case "changeServer":
                    replyOk(id);
                    openServerScreen();
                    break;
                default:
                    replyError(id, "unsupported");
                    break;
            }
        } catch (Throwable t) {
            Log.e(TAG, "bridge command failed: " + cmd, t);
            replyError(id, t.getMessage() == null ? "internal error" : t.getMessage());
        }
    }
}
