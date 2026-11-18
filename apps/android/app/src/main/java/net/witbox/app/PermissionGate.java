package net.witbox.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * On-device permission gate for the device-control agent.
 * never → denied, always → allowed, ask → dialog (Allow once 5 min / Always allow / Deny, 60 s timeout).
 * Except where noted, methods must be called on the main thread.
 */
final class PermissionGate {
    interface Callback {
        void onResult(boolean allowed);
    }

    static final String CHOICE_ONCE = "once";
    static final String CHOICE_ALWAYS = "always";
    static final String CHOICE_DENY = "deny";

    private static final String TAG = "CBGate";
    private static final long GRANT_MS = 5 * 60_000L;
    private static final long ASK_TIMEOUT_MS = 60_000L;
    /** For "always" bots the indicator stays this long after the last action. */
    private static final long ACTIVE_LINGER_MS = 60_000L;
    private static final int NOTIF_ASK = 3001;
    private static final int NOTIF_ACTIVE = 3002;

    private static final class Pending {
        String askId;
        String botId;
        String botName;
        final List<Callback> callbacks = new ArrayList<>();
        Runnable timeout;
    }

    private static final Handler main = new Handler(Looper.getMainLooper());
    /** botId → elapsedRealtime at which the "allow once" window ends. */
    private static final Map<String, Long> grants = new ConcurrentHashMap<>();
    private static final Map<String, Pending> pendingByBot = new HashMap<>();
    private static final Map<String, Pending> pendingByAsk = new HashMap<>();
    private static final Map<String, WeakReference<AskActivity>> askUis = new HashMap<>();
    /** botId → elapsedRealtime until which the "is controlling" indicator is currently posted. */
    private static final Map<String, Long> indicatorUntil = new HashMap<>();

    private PermissionGate() {}

    private static long now() {
        return SystemClock.elapsedRealtime();
    }

    private static boolean grantActive(String botId) {
        Long until = grants.get(botId);
        if (until == null) return false;
        if (until <= now()) {
            grants.remove(botId);
            return false;
        }
        return true;
    }

    /** Any thread. Re-check right before executing an action. */
    static boolean isStillAllowed(Context ctx, String botId) {
        String level = Prefs.getLevel(ctx, botId);
        if (Prefs.LEVEL_ALWAYS.equals(level)) return true;
        if (Prefs.LEVEL_ASK.equals(level)) return grantActive(botId);
        return false;
    }

    static void check(Context c, final String botId, String botName, Callback cb) {
        final Context ctx = c.getApplicationContext();
        String level = Prefs.getLevel(ctx, botId);
        if (Prefs.LEVEL_ALWAYS.equals(level)) {
            cb.onResult(true);
            return;
        }
        if (!Prefs.LEVEL_ASK.equals(level)) {
            cb.onResult(false);
            return;
        }
        if (grantActive(botId)) {
            cb.onResult(true);
            return;
        }
        Pending p = pendingByBot.get(botId);
        if (p != null) {
            p.callbacks.add(cb); // a dialog for this bot is already showing
            return;
        }
        final Pending np = new Pending();
        np.askId = UUID.randomUUID().toString();
        np.botId = botId;
        np.botName = botName;
        np.callbacks.add(cb);
        np.timeout = () -> {
            Log.i(TAG, "ask timed out for " + botId);
            resolve(ctx, np, CHOICE_DENY);
        };
        pendingByBot.put(botId, np);
        pendingByAsk.put(np.askId, np);
        main.postDelayed(np.timeout, ASK_TIMEOUT_MS);
        showAsk(ctx, np);
    }

    static boolean isPending(String askId) {
        return askId != null && pendingByAsk.containsKey(askId);
    }

    static void registerUi(String askId, AskActivity a) {
        askUis.put(askId, new WeakReference<>(a));
    }

    static void unregisterUi(String askId, AskActivity a) {
        WeakReference<AskActivity> ref = askUis.get(askId);
        if (ref != null && ref.get() == a) askUis.remove(askId);
    }

    /** The user answered (dialog button or notification action). */
    static void answer(Context c, String askId, String choice) {
        Pending p = askId == null ? null : pendingByAsk.get(askId);
        if (p == null) return; // already answered or timed out
        resolve(c.getApplicationContext(), p, choice);
    }

    private static void resolve(Context ctx, Pending p, String choice) {
        if (pendingByAsk.remove(p.askId) == null) return;
        pendingByBot.remove(p.botId);
        main.removeCallbacks(p.timeout);

        boolean allowed = false;
        if (CHOICE_ONCE.equals(choice)) {
            // The level may have been set to "never" while the dialog was open.
            if (!Prefs.LEVEL_NEVER.equals(Prefs.getLevel(ctx, p.botId))) {
                grants.put(p.botId, now() + GRANT_MS);
                allowed = true;
            }
        } else if (CHOICE_ALWAYS.equals(choice)) {
            Prefs.setLevel(ctx, p.botId, Prefs.LEVEL_ALWAYS);
            notifyWeb(p.botId, Prefs.LEVEL_ALWAYS);
            allowed = true;
        }

        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel("ask:" + p.botId, NOTIF_ASK);
        WeakReference<AskActivity> ref = askUis.remove(p.askId);
        AskActivity ui = ref == null ? null : ref.get();
        if (ui != null) ui.dismissFromGate();

        if (allowed) {
            indicatorUntil.remove(p.botId);
            noteActivity(ctx, p.botId, p.botName);
        }
        for (Callback cb : new ArrayList<>(p.callbacks)) {
            try {
                cb.onResult(allowed);
            } catch (Throwable t) {
                Log.e(TAG, "callback failed", t);
            }
        }
    }

    /** "Stop": revoke the current window and set the bot back to "ask". */
    static void stop(Context c, String botId, String botName) {
        if (botId == null) return;
        Context ctx = c.getApplicationContext();
        grants.remove(botId);
        if (!Prefs.LEVEL_NEVER.equals(Prefs.getLevel(ctx, botId))) {
            Prefs.setLevel(ctx, botId, Prefs.LEVEL_ASK);
            notifyWeb(botId, Prefs.LEVEL_ASK);
        }
        cancelIndicator(ctx, botId);
        try {
            Toast.makeText(ctx, ctx.getString(R.string.ctl_stopped, botName == null ? botId : botName),
                    Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {
        }
    }

    /** The level was changed from the web UI (setPermission). */
    static void onLevelChanged(Context c, String botId, String level) {
        Context ctx = c.getApplicationContext();
        if (Prefs.LEVEL_ALWAYS.equals(level)) {
            Pending p = pendingByBot.get(botId);
            if (p != null) resolve(ctx, p, CHOICE_ALWAYS);
            return;
        }
        if (Prefs.LEVEL_NEVER.equals(level)) {
            grants.remove(botId);
            Pending p = pendingByBot.get(botId);
            if (p != null) resolve(ctx, p, CHOICE_DENY);
        }
        if (!grantActive(botId)) cancelIndicator(ctx, botId);
    }

    private static void notifyWeb(String botId, String level) {
        try {
            JSONObject o = new JSONObject();
            o.put("botId", botId);
            o.put("level", level);
            MainActivity.emitToPage("permissionChanged", o);
        } catch (Throwable ignored) {
        }
    }

    // ---- UI ------------------------------------------------------------------------------

    private static PendingIntent answerIntent(Context ctx, Pending p, String choice, int rc) {
        Intent i = new Intent(ctx, ControlActionReceiver.class)
                .setAction(ControlActionReceiver.ACTION_ANSWER)
                .setData(Uri.parse("witbox://ask/" + p.askId + "/" + choice))
                .putExtra(ControlActionReceiver.EXTRA_ASK_ID, p.askId)
                .putExtra(ControlActionReceiver.EXTRA_CHOICE, choice);
        return PendingIntent.getBroadcast(ctx, rc, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static NotificationCompat.Action action(Context ctx, int label, PendingIntent pi, boolean auth) {
        // Granting control from the lock screen must require unlocking first (Android 12+).
        return new NotificationCompat.Action.Builder(0, ctx.getString(label), pi)
                .setAuthenticationRequired(auth)
                .build();
    }

    private static void showAsk(Context ctx, Pending p) {
        Intent dialog = new Intent(ctx, AskActivity.class)
                .setData(Uri.parse("witbox://ask/" + p.askId))
                .putExtra(AskActivity.EXTRA_ASK_ID, p.askId)
                .putExtra(AskActivity.EXTRA_BOT_NAME, p.botName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);

        // 1) Heads-up notification with the three answers (works from any state, also as a fallback
        //    if the dialog below cannot be started).
        try {
            PendingIntent content = PendingIntent.getActivity(ctx, 10, dialog,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            String title = ctx.getString(R.string.ask_title, p.botName);
            Notification n = new NotificationCompat.Builder(ctx, App.CH_ASK)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setColor(0xFFD97757)
                    .setContentTitle(title)
                    .setContentText(ctx.getString(R.string.ask_body))
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(ctx.getString(R.string.ask_body)))
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .setAutoCancel(false)
                    .setOngoing(true)
                    .setTimeoutAfter(ASK_TIMEOUT_MS)
                    .setContentIntent(content)
                    .addAction(action(ctx, R.string.allow_once, answerIntent(ctx, p, CHOICE_ONCE, 11), true))
                    .addAction(action(ctx, R.string.allow_always, answerIntent(ctx, p, CHOICE_ALWAYS, 12), true))
                    .addAction(action(ctx, R.string.deny, answerIntent(ctx, p, CHOICE_DENY, 13), false))
                    .build();
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify("ask:" + p.botId, NOTIF_ASK, n);
        } catch (Throwable t) {
            Log.w(TAG, "ask notification failed: " + t);
        }

        // 2) Modal dialog. Started from the accessibility service, which is exempt from the
        //    background-activity-start restrictions.
        try {
            Context starter = ControlService.get();
            if (starter == null) starter = ctx;
            starter.startActivity(dialog);
        } catch (Throwable t) {
            Log.w(TAG, "ask dialog failed: " + t);
        }
    }

    /**
     * Shows / refreshes the ongoing "‹bot› is controlling this device — tap to stop" notification.
     * Called whenever a bot's request is allowed.
     */
    static void noteActivity(Context c, String botId, String botName) {
        Context ctx = c.getApplicationContext();
        long now = now();
        Long grantUntil = grants.get(botId);
        long until = (grantUntil != null && grantUntil > now) ? grantUntil : now + ACTIVE_LINGER_MS;
        Long shown = indicatorUntil.get(botId);
        if (shown != null && shown > now && until - shown < ACTIVE_LINGER_MS / 3) return; // still fresh
        indicatorUntil.put(botId, until);
        try {
            Intent stop = new Intent(ctx, ControlActionReceiver.class)
                    .setAction(ControlActionReceiver.ACTION_STOP)
                    .setData(Uri.parse("witbox://stop/" + Uri.encode(botId)))
                    .putExtra(ControlActionReceiver.EXTRA_BOT_ID, botId)
                    .putExtra(ControlActionReceiver.EXTRA_BOT_NAME, botName);
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 20, stop,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new NotificationCompat.Builder(ctx, App.CH_ACTIVE)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setColor(0xFFD97757)
                    .setColorized(true)
                    .setContentTitle(ctx.getString(R.string.ctl_title, botName))
                    .setContentText(ctx.getString(R.string.ctl_text))
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setAutoCancel(false)
                    .setShowWhen(false)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setTimeoutAfter(Math.max(1000, until - now))
                    .setContentIntent(pi)
                    .addAction(0, ctx.getString(R.string.stop), pi)
                    .build();
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify("ctl:" + botId, NOTIF_ACTIVE, n);
        } catch (Throwable t) {
            Log.w(TAG, "indicator failed: " + t);
        }
    }

    private static void cancelIndicator(Context ctx, String botId) {
        indicatorUntil.remove(botId);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel("ctl:" + botId, NOTIF_ACTIVE);
    }
}
