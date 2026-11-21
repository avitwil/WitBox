package net.witbox.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Full edition: reads the notifications of other apps (incoming messages of any messenger) so bots
 * get them as text, and answers them through the notification's own reply action. Notifications are
 * kept in memory only (the last {@link #MAX}); nothing is stored or sent unless a permitted bot asks.
 */
public class NotifListener extends NotificationListenerService {
    private static final int MAX = 300;

    private static final class Item {
        String key, pkg, title, text;
        long time;
    }

    private static volatile NotifListener instance;
    private static final ArrayDeque<Item> recent = new ArrayDeque<>();
    private static final Map<String, Notification> latest = new HashMap<>();

    @Override
    public void onListenerConnected() {
        instance = this;
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active != null) for (StatusBarNotification s : active) remember(s);
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onListenerDisconnected() {
        if (instance == this) instance = null;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        remember(sbn);
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (sbn == null) return;
        synchronized (recent) {
            latest.remove(sbn.getKey());
        }
    }

    private static String str(Bundle b, String k) {
        CharSequence cs = b == null ? null : b.getCharSequence(k);
        return cs == null ? "" : cs.toString().trim();
    }

    private void remember(StatusBarNotification sbn) {
        try {
            if (sbn == null || getPackageName().equals(sbn.getPackageName())) return;
            if ("android".equals(sbn.getPackageName()) || "com.android.systemui".equals(sbn.getPackageName())) return;
            Notification n = sbn.getNotification();
            if (n == null) return;
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
            if ((n.flags & (Notification.FLAG_ONGOING_EVENT | Notification.FLAG_FOREGROUND_SERVICE)) != 0) return;
            Bundle x = n.extras;
            String title = str(x, Notification.EXTRA_TITLE);
            String text = str(x, Notification.EXTRA_BIG_TEXT);
            if (text.isEmpty()) text = str(x, Notification.EXTRA_TEXT);
            if (title.isEmpty() && text.isEmpty()) return;
            synchronized (recent) {
                latest.put(sbn.getKey(), n);
                // The same conversation is re-posted for every new message: keep each distinct text.
                for (Iterator<Item> it = recent.descendingIterator(); it.hasNext(); ) {
                    Item o = it.next();
                    if (o.key.equals(sbn.getKey())) {
                        if (o.title.equals(title) && o.text.equals(text)) return;
                        break;
                    }
                }
                Item i = new Item();
                i.key = sbn.getKey();
                i.pkg = sbn.getPackageName();
                i.title = title;
                i.text = text;
                i.time = sbn.getPostTime();
                recent.addLast(i);
                while (recent.size() > MAX) recent.removeFirst();
            }
        } catch (Throwable ignored) {
        }
    }

    private static String appLabel(Context c, String pkg, Map<String, String> cache) {
        if (cache.containsKey(pkg)) return cache.get(pkg);
        String label = pkg;
        try {
            PackageManager pm = c.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            CharSequence l = pm.getApplicationLabel(ai);
            if (l != null) label = l.toString();
        } catch (Throwable ignored) {
        }
        cache.put(pkg, label);
        return label;
    }

    private static Notification.Action replyAction(Notification n) {
        if (n == null || n.actions == null) return null;
        for (Notification.Action a : n.actions) {
            RemoteInput[] ins = a.getRemoteInputs();
            if (ins != null && ins.length > 0 && a.actionIntent != null) return a;
        }
        return null;
    }

    static JSONObject list(Context c, JSONObject a) throws Exception {
        if (instance == null) throw new Exception("the notification listener is not running yet; open the WitBox app once");
        int limit = Math.max(1, Math.min(100, a.optInt("limit", 30)));
        String app = a.optString("app", "").toLowerCase(Locale.ROOT);
        String q = a.optString("query", "").toLowerCase(Locale.ROOT);
        double hours = a.optDouble("since_hours", 0);
        long since = hours > 0 ? System.currentTimeMillis() - (long) (hours * 3600_000L) : 0;
        List<Item> items;
        Map<String, Notification> live;
        synchronized (recent) {
            items = new ArrayList<>(recent);
            items.sort((x, y) -> Long.compare(x.time, y.time));
            live = new HashMap<>(latest);
        }
        final boolean canReply = Prefs.toolOn(c, DeviceTools.NOTIF_REPLY);
        Map<String, String> labels = new HashMap<>();
        JSONArray out = new JSONArray();
        int hidden = 0;
        for (int i = items.size() - 1; i >= 0 && out.length() < limit; i--) {
            Item it = items.get(i);
            if (it.time < since) continue;
            String label = appLabel(c, it.pkg, labels);
            if (!app.isEmpty() && !label.toLowerCase(Locale.ROOT).contains(app) && !it.pkg.toLowerCase(Locale.ROOT).contains(app)) continue;
            if (!q.isEmpty() && !(it.title + "\n" + it.text).toLowerCase(Locale.ROOT).contains(q)) continue;
            JSONObject m = new JSONObject();
            m.put("app", label);
            m.put("title", it.title);
            String shown = DeviceTools.shown(c, it.text);
            if (!shown.equals(it.text) && DeviceTools.looksLikeCode(it.text)) hidden++;
            m.put("text", shown);
            m.put("time", DeviceTools.time(it.time));
            if (canReply && replyAction(live.get(it.key)) != null) m.put("reply_key", it.key);
            out.put(m);
        }
        JSONObject res = new JSONObject().put("notifications", out);
        if (hidden > 0) res.put("note", hidden + " notification(s) with verification codes are hidden by a setting on the device");
        res.put("info", "newest first; only notifications received since the app started are kept");
        return res;
    }

    static JSONObject reply(Context c, JSONObject a) throws Exception {
        String key = a.optString("key", "");
        String text = a.optString("text", "");
        if (key.isEmpty()) throw new Exception("missing 'key' (reply_key of a notification)");
        if (text.trim().isEmpty()) throw new Exception("missing 'text'");
        Notification n;
        synchronized (recent) {
            n = latest.get(key);
        }
        Notification.Action act = replyAction(n);
        if (act == null) throw new Exception("this notification is gone or cannot be answered; list notifications again");
        Intent fill = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput ri : act.getRemoteInputs()) results.putCharSequence(ri.getResultKey(), text);
        RemoteInput.addResultsToIntent(act.getRemoteInputs(), fill, results);
        try {
            act.actionIntent.send(c, 0, fill);
        } catch (PendingIntent.CanceledException e) {
            throw new Exception("this notification can no longer be answered");
        }
        return new JSONObject().put("ok", true);
    }
}
