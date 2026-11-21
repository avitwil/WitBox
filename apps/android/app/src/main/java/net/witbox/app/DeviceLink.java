package net.witbox.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Process-wide owner of the /ws/device socket (the device-control agent). Requests are checked against
 * the on-device permission gate and then executed, one at a time, by the accessibility service.
 */
final class DeviceLink implements ReconnectingSocket.Listener {
    private static final String TAG = "CBDevice";
    private static DeviceLink instance;
    private static boolean networkCallbackRegistered;

    private final Context ctx;
    private final ReconnectingSocket socket;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "cb-control");
        t.setDaemon(true);
        return t;
    });

    private DeviceLink(Context c) {
        ctx = c.getApplicationContext();
        socket = new ReconnectingSocket(ctx, "ws/device", TAG, this);
    }

    /** Main thread. Safe to call repeatedly. */
    static void ensureStarted(Context c) {
        if (instance == null) {
            instance = new DeviceLink(c);
            instance.socket.start();
        }
        registerNetworkCallback(c);
    }

    /** Main thread: the server URL changed. */
    static void restart() {
        if (instance != null) instance.socket.restart();
    }

    static void kick() {
        if (instance != null) instance.socket.kick();
    }

    private static void registerNetworkCallback(Context c) {
        if (networkCallbackRegistered) return;
        try {
            ConnectivityManager cm = c.getApplicationContext().getSystemService(ConnectivityManager.class);
            if (cm == null) return;
            final Handler main = new Handler(Looper.getMainLooper());
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    // The default network changed (Wi-Fi/mobile/VPN up): retry immediately.
                    main.postDelayed(() -> {
                        DeviceLink.kick();
                        NotifyService.kick();
                    }, 1000);
                }
            });
            networkCallbackRegistered = true;
        } catch (Throwable t) {
            Log.w(TAG, "network callback: " + t);
        }
    }

    @Override
    public void onState(boolean connected) {
    }

    @Override
    public void onMessage(JSONObject msg) {
        if (!"request".equals(msg.optString("type"))) return;
        final Object rid = msg.opt("id");
        final String botId = msg.optString("botId", "");
        String bn = msg.optString("botName", "");
        final String botName = bn.isEmpty() ? (botId.isEmpty() ? "Bot" : botId) : bn;
        final JSONObject action = msg.optJSONObject("action");

        if (action == null || botId.isEmpty()) {
            respondError(rid, "bad_request");
            return;
        }
        if (Prefs.LEVEL_NEVER.equals(Prefs.getLevel(ctx, botId))) {
            respondError(rid, "denied");
            return;
        }
        // Direct tools (SMS, calls, notifications…) do not need the accessibility service.
        if (!DeviceTools.handles(action.optString("type", "")) && ControlService.get() == null) {
            respondError(rid, "not_enabled");
            return;
        }
        PermissionGate.check(ctx, botId, botName, allowed -> {
            if (!allowed) {
                respondError(rid, "denied");
                return;
            }
            PermissionGate.noteActivity(ctx, botId, botName);
            worker.execute(() -> execute(rid, botId, action));
        });
    }

    /** Worker thread. */
    private void execute(Object rid, String botId, JSONObject action) {
        final boolean direct = DeviceTools.handles(action.optString("type", ""));
        ControlService svc = ControlService.get();
        if (svc == null && !direct) {
            respondError(rid, "not_enabled");
            return;
        }
        // The user may have pressed Stop (or changed the level) while this request was queued.
        if (!PermissionGate.isStillAllowed(ctx, botId)) {
            respondError(rid, "denied");
            return;
        }
        try {
            JSONObject result = direct ? DeviceTools.perform(ctx, action) : svc.perform(action);
            JSONObject resp = new JSONObject();
            resp.put("type", "response");
            resp.put("id", rid == null ? JSONObject.NULL : rid);
            resp.put("ok", true);
            resp.put("result", result);
            socket.send(resp);
        } catch (Throwable t) {
            Log.w(TAG, "action failed: " + t);
            String m = t.getMessage();
            respondError(rid, m == null || m.isEmpty() ? t.getClass().getSimpleName() : m);
        }
    }

    private void respondError(Object rid, String error) {
        try {
            JSONObject resp = new JSONObject();
            resp.put("type", "response");
            resp.put("id", rid == null ? JSONObject.NULL : rid);
            resp.put("ok", false);
            resp.put("error", error);
            socket.send(resp);
        } catch (Throwable ignored) {
        }
    }
}
