package net.witbox.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

/**
 * Foreground service that keeps the /ws/notify WebSocket alive while the UI is closed and turns
 * incoming {"type":"notification"} frames into OS notifications that deep-link into the app.
 */
public class NotifyService extends Service implements ReconnectingSocket.Listener {
    private static final String TAG = "CBNotify";
    private static final int NOTIF_STATUS = 1001;
    private static final int NOTIF_ALERT = 2001;

    private static NotifyService instance;

    private ReconnectingSocket socket;
    private boolean foreground;

    static void start(Context c) {
        // Nothing to connect to until a server address was entered (first run / after boot).
        if (!Prefs.hasServer(c)) return;
        try {
            ContextCompat.startForegroundService(c.getApplicationContext(),
                    new Intent(c.getApplicationContext(), NotifyService.class));
        } catch (Throwable t) {
            // e.g. ForegroundServiceStartNotAllowedException when started from the background
            Log.w(TAG, "cannot start service: " + t);
        }
    }

    /** Main thread: the server URL changed. */
    static void restartSocket() {
        NotifyService s = instance;
        if (s != null && s.socket != null) s.socket.restart();
    }

    static void kick() {
        NotifyService s = instance;
        if (s != null && s.socket != null) s.socket.kick();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        App.createChannels(this);
        if (!goForeground(false)) return;
        socket = new ReconnectingSocket(this, "ws/notify", TAG, this);
        socket.start();
        DeviceLink.ensureStarted(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // startForegroundService() requires startForeground() for every start request.
        if (!goForeground(socket != null && socket.isConnected())) return START_NOT_STICKY;
        if (socket == null) {
            socket = new ReconnectingSocket(this, "ws/notify", TAG, this);
            socket.start();
            DeviceLink.ensureStarted(this);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (socket != null) socket.stop();
        socket = null;
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Only relevant for time-limited FGS types; stop cleanly if the system ever asks.
        stopSelf();
    }

    private boolean goForeground(boolean connected) {
        try {
            Notification n = statusNotification(connected);
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_STATUS, n);
            }
            foreground = true;
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "startForeground failed: " + t);
            foreground = false;
            stopSelf();
            return false;
        }
    }

    private Notification statusNotification(boolean connected) {
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, App.CH_STATUS)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFFD97757)
                .setContentTitle(getString(connected ? R.string.status_connected : R.string.status_connecting))
                .setContentText(getString(R.string.status_text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(pi)
                .build();
    }

    @Override
    public void onState(boolean connected) {
        if (!foreground) return;
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIF_STATUS, statusNotification(connected));
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onMessage(JSONObject msg) {
        if (!"notification".equals(msg.optString("type"))) return;
        String id = msg.optString("id", "");
        if (id.isEmpty()) id = String.valueOf(System.currentTimeMillis());
        String botId = msg.optString("botId", "");
        String botName = msg.optString("botName", "");
        String title = msg.optString("title", "");
        String body = msg.optString("body", "");
        String url = msg.optString("url", "");
        boolean high = "high".equals(msg.optString("priority", "normal"));

        if (url.isEmpty() && !botId.isEmpty()) url = "/#/bot/" + botId;
        if (title.isEmpty()) title = botName.isEmpty() ? getString(R.string.app_name) : botName;

        Intent open = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse("witbox://notification/" + Uri.encode(id)))
                .putExtra(MainActivity.EXTRA_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 2, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, high ? App.CH_ALERTS : App.CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFFD97757)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(high ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(pi);
        if (!botName.isEmpty() && !botName.equals(title)) b.setSubText(botName);

        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(id, NOTIF_ALERT, b.build());
        } catch (Throwable t) {
            Log.w(TAG, "notify failed: " + t);
        }
    }
}
