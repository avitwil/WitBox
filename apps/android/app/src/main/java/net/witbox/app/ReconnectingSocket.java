package net.witbox.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * A WebSocket to SERVER_URL/<path>?deviceId=..&name=..&platform=android that reconnects forever with
 * exponential backoff (2 s → 60 s), answers {"type":"ping"} with {"type":"pong"} and drops connections
 * that have been silent for too long. All listener callbacks are delivered on the main thread.
 */
final class ReconnectingSocket {
    interface Listener {
        void onMessage(JSONObject msg);

        void onState(boolean connected);
    }

    private static final long BACKOFF_MIN = 2_000;
    private static final long BACKOFF_MAX = 60_000;
    /** Server pings every 25 s; three missed pings means the link is dead. */
    private static final long SILENCE_TIMEOUT = 80_000;

    private static OkHttpClient client;

    private static synchronized OkHttpClient client() {
        if (client == null) {
            client = new OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                    .writeTimeout(30, TimeUnit.SECONDS)
                    .pingInterval(45, TimeUnit.SECONDS)
                    .retryOnConnectionFailure(true)
                    .build();
        }
        return client;
    }

    private final Context ctx;
    private final String path;
    private final String tag;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean running;
    private volatile boolean connected;
    private volatile WebSocket ws;
    private int generation;
    private long backoff = BACKOFF_MIN;

    private final Runnable connectRunnable = this::connect;
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            WebSocket w = ws;
            if (running && w != null) {
                Log.w(tag, "silent for too long, reconnecting");
                w.cancel(); // triggers onFailure -> reconnect
            }
        }
    };

    ReconnectingSocket(Context ctx, String path, String tag, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.path = path;
        this.tag = tag;
        this.listener = listener;
    }

    boolean isConnected() {
        return connected;
    }

    /** Main thread. */
    void start() {
        if (running) return;
        running = true;
        backoff = BACKOFF_MIN;
        connect();
    }

    /** Main thread. */
    void stop() {
        running = false;
        generation++;
        main.removeCallbacks(connectRunnable);
        main.removeCallbacks(watchdog);
        WebSocket w = ws;
        ws = null;
        if (w != null) {
            try {
                w.close(1000, null);
            } catch (Throwable ignored) {
            }
        }
        if (connected) {
            connected = false;
            listener.onState(false);
        }
    }

    /** Drop the current connection (e.g. the server URL changed) and reconnect right away. Main thread. */
    void restart() {
        if (!running) {
            start();
            return;
        }
        backoff = BACKOFF_MIN;
        dropCurrent();
        connect();
    }

    /** Network came back: if we are waiting in backoff, try now. Main thread. */
    void kick() {
        if (!running || connected || ws != null) return; // connected or already connecting
        backoff = BACKOFF_MIN;
        connect();
    }

    private void dropCurrent() {
        generation++;
        main.removeCallbacks(connectRunnable);
        main.removeCallbacks(watchdog);
        WebSocket w = ws;
        ws = null;
        if (w != null) {
            try {
                w.cancel();
            } catch (Throwable ignored) {
            }
        }
        if (connected) {
            connected = false;
            listener.onState(false);
        }
    }

    boolean send(JSONObject msg) {
        WebSocket w = ws;
        if (w == null) return false;
        try {
            return w.send(msg.toString());
        } catch (Throwable t) {
            return false;
        }
    }

    private void connect() {
        if (!running) return;
        main.removeCallbacks(connectRunnable);
        final int gen = ++generation;

        if (!Prefs.hasServer(ctx)) {
            // No server configured yet: stay idle; restart() is called once the user saves one.
            return;
        }

        Request request;
        try {
            HttpUrl base = HttpUrl.parse(Prefs.serverUrl(ctx));
            if (base == null) throw new IllegalArgumentException("bad server url");
            HttpUrl url = base.newBuilder()
                    .addPathSegments(path)
                    .query(null)
                    .addQueryParameter("deviceId", Prefs.deviceId(ctx))
                    .addQueryParameter("name", Prefs.deviceName(ctx))
                    .addQueryParameter("platform", Prefs.PLATFORM)
                    .build();
            request = new Request.Builder()
                    .url(url)
                    .header("User-Agent", "WitBoxApp/" + BuildConfig.VERSION_NAME + " (android)")
                    .build();
        } catch (Throwable t) {
            Log.w(tag, "cannot build url: " + t);
            scheduleReconnect();
            return;
        }

        armWatchdog();
        ws = client().newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                main.post(() -> {
                    if (gen != generation) return;
                    Log.i(tag, "connected");
                    connected = true;
                    backoff = BACKOFF_MIN;
                    armWatchdog();
                    listener.onState(true);
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                final JSONObject msg;
                try {
                    msg = new JSONObject(text);
                } catch (Throwable t) {
                    return;
                }
                if ("ping".equals(msg.optString("type"))) {
                    try {
                        webSocket.send("{\"type\":\"pong\"}");
                    } catch (Throwable ignored) {
                    }
                    main.post(() -> {
                        if (gen == generation) armWatchdog();
                    });
                    return;
                }
                main.post(() -> {
                    if (gen != generation) return;
                    armWatchdog();
                    try {
                        listener.onMessage(msg);
                    } catch (Throwable t) {
                        Log.e(tag, "listener failed", t);
                    }
                });
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                try {
                    webSocket.close(1000, null);
                } catch (Throwable ignored) {
                }
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                main.post(() -> onDisconnected(gen, "closed " + code));
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                main.post(() -> onDisconnected(gen, String.valueOf(t)));
            }
        });
    }

    private void onDisconnected(int gen, String why) {
        if (gen != generation) return;
        generation++; // ignore any further callbacks of this socket
        Log.i(tag, "disconnected: " + why);
        ws = null;
        main.removeCallbacks(watchdog);
        if (connected) {
            connected = false;
            listener.onState(false);
        }
        scheduleReconnect();
    }

    private void scheduleReconnect() {
        if (!running) return;
        main.removeCallbacks(connectRunnable);
        main.postDelayed(connectRunnable, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
    }

    private void armWatchdog() {
        main.removeCallbacks(watchdog);
        main.postDelayed(watchdog, SILENCE_TIMEOUT);
    }
}
