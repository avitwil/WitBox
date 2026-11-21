package net.witbox.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.CalendarContract;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.provider.Telephony;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Direct device tools for bots (full edition): SMS, call log, dialling, contacts, notifications of
 * other apps, calendar and location, as text instead of screenshots. Every tool has its own switch
 * on this device (off by default) and needs its Android permission; the per-bot gate of
 * {@link DeviceLink} has already been passed when perform() is called.
 */
final class DeviceTools {
    static final String SMS = "sms", SMS_SEND = "sms_send", CALLS = "calls", DIAL = "dial",
            CONTACTS = "contacts", NOTIFICATIONS = "notifications", NOTIF_REPLY = "notif_reply",
            CALENDAR = "calendar", LOCATION = "location";
    static final String[] ALL = {SMS, SMS_SEND, CALLS, DIAL, CONTACTS, NOTIFICATIONS, NOTIF_REPLY, CALENDAR, LOCATION};

    private static final Map<String, String> ACTION_TOOL = new HashMap<>();

    static {
        ACTION_TOOL.put("sms_list", SMS);
        ACTION_TOOL.put("sms_send", SMS_SEND);
        ACTION_TOOL.put("call_log", CALLS);
        ACTION_TOOL.put("call", DIAL);
        ACTION_TOOL.put("contacts", CONTACTS);
        ACTION_TOOL.put("notifications", NOTIFICATIONS);
        ACTION_TOOL.put("notification_reply", NOTIF_REPLY);
        ACTION_TOOL.put("calendar", CALENDAR);
        ACTION_TOOL.put("location", LOCATION);
    }

    private DeviceTools() {}

    /** True for the actions that are answered here (they do not need the accessibility service). */
    static boolean handles(String actionType) {
        return BuildConfig.CONTROL && (ACTION_TOOL.containsKey(actionType) || "capabilities".equals(actionType));
    }

    static boolean isTool(String name) {
        for (String t : ALL) if (t.equals(name)) return true;
        return false;
    }

    /** Runtime permissions a tool needs (empty for the notification tools, which use a listener). */
    static String[] permsFor(String tool) {
        switch (tool) {
            case SMS:
                return new String[]{Manifest.permission.READ_SMS};
            case SMS_SEND:
                return new String[]{Manifest.permission.SEND_SMS};
            case CALLS:
                return new String[]{Manifest.permission.READ_CALL_LOG};
            case DIAL:
                return new String[]{Manifest.permission.CALL_PHONE};
            case CONTACTS:
                return new String[]{Manifest.permission.READ_CONTACTS};
            case CALENDAR:
                return new String[]{Manifest.permission.READ_CALENDAR};
            case LOCATION:
                return new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION};
            default:
                return new String[0];
        }
    }

    static boolean usesListener(String tool) {
        return NOTIFICATIONS.equals(tool) || NOTIF_REPLY.equals(tool);
    }

    static boolean listenerEnabled(Context c) {
        try {
            String flat = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
            if (flat == null) return false;
            String pkg = c.getPackageName();
            for (String s : flat.split(":")) {
                ComponentName cn = ComponentName.unflattenFromString(s);
                if (cn != null && pkg.equals(cn.getPackageName())) return true;
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    private static boolean has(Context c, String perm) {
        return c.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** Whether Android currently lets the app do what the tool needs. */
    static boolean granted(Context c, String tool) {
        if (usesListener(tool)) return listenerEnabled(c);
        if (LOCATION.equals(tool)) {
            // Requests arrive while the app is in the background, which needs "allow all the time".
            boolean fg = has(c, Manifest.permission.ACCESS_FINE_LOCATION) || has(c, Manifest.permission.ACCESS_COARSE_LOCATION);
            return fg && (Build.VERSION.SDK_INT < 29 || has(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        }
        for (String p : permsFor(tool)) if (!has(c, p)) return false;
        return true;
    }

    /** {tool: {on, granted}} for the settings page. */
    static JSONObject state(Context c) {
        JSONObject o = new JSONObject();
        try {
            for (String t : ALL) {
                o.put(t, new JSONObject().put("on", Prefs.toolOn(c, t)).put("granted", granted(c, t)));
            }
        } catch (Throwable ignored) {
        }
        return o;
    }

    private static void require(Context c, String tool) throws Exception {
        if (!Prefs.toolOn(c, tool)) throw new Exception("tool_off: '" + tool + "' is switched off on this device (WitBox app → Devices → Device tools)");
        if (!granted(c, tool)) throw new Exception("permission_missing: Android permission for '" + tool + "' is not granted on this device");
    }

    // =====================================================================================

    static JSONObject perform(Context c, JSONObject a) throws Exception {
        String type = a.optString("type", "");
        if ("capabilities".equals(type)) {
            JSONObject o = new JSONObject();
            JSONArray on = new JSONArray(), off = new JSONArray();
            for (String t : ALL) (Prefs.toolOn(c, t) && granted(c, t) ? on : off).put(t);
            o.put("tools_on", on).put("tools_off", off);
            o.put("screen_control", ControlService.get() != null);
            o.put("hide_codes", Prefs.hideCodes(c));
            return o;
        }
        String tool = ACTION_TOOL.get(type);
        if (tool == null) throw new Exception("unsupported action: " + type);
        require(c, tool);
        switch (type) {
            case "sms_list":
                return smsList(c, a);
            case "sms_send":
                return smsSend(c, a);
            case "call_log":
                return callLog(c, a);
            case "call":
                return call(c, a);
            case "contacts":
                return contacts(c, a);
            case "notifications":
                return NotifListener.list(c, a);
            case "notification_reply":
                return NotifListener.reply(c, a);
            case "calendar":
                return calendar(c, a);
            default:
                return location(c);
        }
    }

    // ---- helpers ------------------------------------------------------------------------

    private static int limit(JSONObject a, int def, int max) {
        return Math.max(1, Math.min(max, a.optInt("limit", def)));
    }

    static String time(long ms) {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(new Date(ms));
    }

    private static final Pattern CODE_DIGITS = Pattern.compile("(?<![\\d.,/:-])\\d{3}[ -]?\\d{1,5}(?![\\d.,/:-]*\\d)");
    private static final Pattern CODE_WORDS = Pattern.compile(
            "קוד|אימות|סיסמ|חד[- ]?פעמי|code|otp|verif|password|passcode|\\bpin\\b|2fa|one[- ]time|token|رمز|كود",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    /** A message that looks like a one-time / verification code. */
    static boolean looksLikeCode(String text) {
        if (text == null || text.isEmpty()) return false;
        return CODE_WORDS.matcher(text).find() && CODE_DIGITS.matcher(text).find();
    }

    /** Text as shown to the bot: verification codes are withheld unless the user switched that off. */
    static String shown(Context c, String text) {
        if (text == null) return "";
        if (Prefs.hideCodes(c) && looksLikeCode(text)) return c.getString(R.string.code_hidden);
        return text.length() > 2000 ? text.substring(0, 2000) + "…" : text;
    }

    private static String contactName(Context c, String number, Map<String, String> cache) {
        if (number == null || number.isEmpty() || !Prefs.toolOn(c, CONTACTS) || !granted(c, CONTACTS)) return null;
        if (cache.containsKey(number)) return cache.get(number);
        String name = null;
        try (Cursor cur = c.getContentResolver().query(
                Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number)),
                new String[]{ContactsContract.PhoneLookup.DISPLAY_NAME}, null, null, null)) {
            if (cur != null && cur.moveToFirst()) name = cur.getString(0);
            if (name != null && name.replaceAll("[^0-9]", "").equals(number.replaceAll("[^0-9]", ""))) name = null;
        } catch (Throwable ignored) {
        }
        cache.put(number, name);
        return name;
    }

    // ---- SMS ----------------------------------------------------------------------------

    private static JSONObject smsList(Context c, JSONObject a) throws Exception {
        int limit = limit(a, 20, 100);
        String box = a.optString("box", "inbox");
        List<String> where = new ArrayList<>();
        List<String> args = new ArrayList<>();
        if ("inbox".equals(box)) where.add("type=" + Telephony.Sms.MESSAGE_TYPE_INBOX);
        else if ("sent".equals(box)) where.add("type=" + Telephony.Sms.MESSAGE_TYPE_SENT);
        String from = a.optString("from", "");
        if (!from.isEmpty()) {
            where.add("address LIKE ?");
            args.add("%" + from + "%");
        }
        String q = a.optString("query", "");
        if (!q.isEmpty()) {
            where.add("body LIKE ?");
            args.add("%" + q + "%");
        }
        double hours = a.optDouble("since_hours", 0);
        if (hours > 0) where.add("date>=" + (System.currentTimeMillis() - (long) (hours * 3600_000L)));
        if (a.optBoolean("unread", false)) where.add("read=0");
        JSONArray out = new JSONArray();
        Map<String, String> names = new HashMap<>();
        int hidden = 0;
        try (Cursor cur = c.getContentResolver().query(Telephony.Sms.CONTENT_URI,
                new String[]{"_id", "address", "body", "date", "type", "read"},
                where.isEmpty() ? null : String.join(" AND ", where),
                args.toArray(new String[0]), "date DESC")) {
            while (cur != null && cur.moveToNext() && out.length() < limit) {
                String addr = cur.getString(1);
                String body = cur.getString(2);
                boolean sent = cur.getInt(4) != Telephony.Sms.MESSAGE_TYPE_INBOX;
                JSONObject m = new JSONObject();
                m.put(sent ? "to" : "from", addr == null ? "" : addr);
                String name = contactName(c, addr, names);
                if (name != null) m.put("name", name);
                m.put("time", time(cur.getLong(3)));
                if (!sent && cur.getInt(5) == 0) m.put("unread", true);
                String text = shown(c, body);
                if (body != null && !text.equals(body) && looksLikeCode(body)) hidden++;
                m.put("text", text);
                out.put(m);
            }
        }
        JSONObject res = new JSONObject().put("messages", out);
        if (hidden > 0) res.put("note", hidden + " message(s) with verification codes are hidden by a setting on the device");
        return res;
    }

    private static JSONObject smsSend(Context c, JSONObject a) throws Exception {
        String to = a.optString("to", "").trim();
        String text = a.optString("text", "");
        if (!to.matches("[+]?[0-9 ()*#-]{3,20}")) throw new Exception("bad 'to' (a phone number is required)");
        if (text.trim().isEmpty()) throw new Exception("missing 'text'");
        if (text.length() > 1600) throw new Exception("text too long");
        SmsManager sm = Build.VERSION.SDK_INT >= 31 ? c.getSystemService(SmsManager.class) : SmsManager.getDefault();
        if (sm == null) throw new Exception("this device cannot send SMS");
        ArrayList<String> parts = sm.divideMessage(text);
        sm.sendMultipartTextMessage(to, null, parts, null, null);
        return new JSONObject().put("ok", true).put("to", to).put("parts", parts.size());
    }

    // ---- calls --------------------------------------------------------------------------

    private static JSONObject callLog(Context c, JSONObject a) throws Exception {
        int limit = limit(a, 20, 100);
        String kind = a.optString("kind", "all");
        List<String> where = new ArrayList<>();
        if ("missed".equals(kind)) where.add("type IN (" + CallLog.Calls.MISSED_TYPE + "," + CallLog.Calls.REJECTED_TYPE + ")");
        else if ("incoming".equals(kind)) where.add("type=" + CallLog.Calls.INCOMING_TYPE);
        else if ("outgoing".equals(kind)) where.add("type=" + CallLog.Calls.OUTGOING_TYPE);
        double hours = a.optDouble("since_hours", 0);
        if (hours > 0) where.add("date>=" + (System.currentTimeMillis() - (long) (hours * 3600_000L)));
        JSONArray out = new JSONArray();
        Map<String, String> names = new HashMap<>();
        try (Cursor cur = c.getContentResolver().query(CallLog.Calls.CONTENT_URI,
                new String[]{CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION},
                where.isEmpty() ? null : String.join(" AND ", where), null, "date DESC")) {
            while (cur != null && cur.moveToNext() && out.length() < limit) {
                JSONObject m = new JSONObject();
                String num = cur.getString(0);
                m.put("number", num == null || num.isEmpty() ? "private" : num);
                String name = cur.getString(1);
                if (name == null || name.isEmpty() || name.equals(num)) name = contactName(c, num, names);
                if (name != null && !name.isEmpty()) m.put("name", name);
                int t = cur.getInt(2);
                m.put("kind", t == CallLog.Calls.INCOMING_TYPE ? "incoming" : t == CallLog.Calls.OUTGOING_TYPE ? "outgoing"
                        : t == CallLog.Calls.MISSED_TYPE ? "missed" : t == CallLog.Calls.REJECTED_TYPE ? "rejected" : "other");
                m.put("time", time(cur.getLong(3)));
                m.put("seconds", cur.getLong(4));
                out.put(m);
            }
        }
        return new JSONObject().put("calls", out);
    }

    private static JSONObject call(Context c, JSONObject a) throws Exception {
        String number = a.optString("number", "").trim();
        if (!number.matches("[+]?[0-9 ()*#-]{3,20}")) throw new Exception("bad 'number'");
        TelecomManager tm = c.getSystemService(TelecomManager.class);
        if (tm == null) throw new Exception("this device cannot place calls");
        tm.placeCall(Uri.fromParts("tel", number, null), null);
        return new JSONObject().put("ok", true).put("calling", number);
    }

    // ---- contacts -----------------------------------------------------------------------

    private static JSONObject contacts(Context c, JSONObject a) throws Exception {
        int limit = limit(a, 20, 200);
        String q = a.optString("query", "");
        String where = null;
        String[] args = null;
        if (!q.isEmpty()) {
            where = ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ? OR "
                    + ContactsContract.CommonDataKinds.Phone.NUMBER + " LIKE ? OR "
                    + ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER + " LIKE ?";
            args = new String[]{"%" + q + "%", "%" + q + "%", "%" + q + "%"};
        }
        JSONArray out = new JSONArray();
        String last = "";
        try (Cursor cur = c.getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER},
                where, args, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " COLLATE LOCALIZED ASC")) {
            while (cur != null && cur.moveToNext() && out.length() < limit) {
                String name = cur.getString(0), num = cur.getString(1);
                String key = name + "|" + (num == null ? "" : num.replaceAll("[^0-9+]", ""));
                if (key.equals(last)) continue;
                last = key;
                out.put(new JSONObject().put("name", name == null ? "" : name).put("number", num == null ? "" : num));
            }
        }
        return new JSONObject().put("contacts", out);
    }

    // ---- calendar -----------------------------------------------------------------------

    private static JSONObject calendar(Context c, JSONObject a) throws Exception {
        int limit = limit(a, 30, 100);
        double days = Math.max(0.1, Math.min(90, a.optDouble("days", 7)));
        long from = System.currentTimeMillis() - (long) (Math.max(0, Math.min(90, a.optDouble("back_days", 0))) * 86_400_000L);
        long to = System.currentTimeMillis() + (long) (days * 86_400_000L);
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, from);
        ContentUris.appendId(b, to);
        JSONArray out = new JSONArray();
        try (Cursor cur = c.getContentResolver().query(b.build(),
                new String[]{CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
                        CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION,
                        CalendarContract.Instances.CALENDAR_DISPLAY_NAME},
                null, null, CalendarContract.Instances.BEGIN + " ASC")) {
            while (cur != null && cur.moveToNext() && out.length() < limit) {
                JSONObject m = new JSONObject();
                m.put("title", cur.getString(0) == null ? "" : cur.getString(0));
                boolean allDay = cur.getInt(3) != 0;
                m.put("start", allDay ? time(cur.getLong(1)).substring(0, 10) : time(cur.getLong(1)));
                if (!allDay) m.put("end", time(cur.getLong(2)));
                else m.put("all_day", true);
                String loc = cur.getString(4);
                if (loc != null && !loc.isEmpty()) m.put("location", loc);
                String cal = cur.getString(5);
                if (cal != null && !cal.isEmpty()) m.put("calendar", cal);
                out.put(m);
            }
        }
        return new JSONObject().put("events", out);
    }

    // ---- location -----------------------------------------------------------------------

    @SuppressWarnings("MissingPermission")
    private static JSONObject location(Context c) throws Exception {
        LocationManager lm = c.getSystemService(LocationManager.class);
        if (lm == null) throw new Exception("no location service");
        Location best = null;
        for (String p : lm.getProviders(true)) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (Throwable ignored) {
            }
        }
        if ((best == null || System.currentTimeMillis() - best.getTime() > 120_000L) && Build.VERSION.SDK_INT >= 30) {
            // Ask every enabled provider at once and take the first fix.
            final Location[] got = {null};
            final CountDownLatch latch = new CountDownLatch(1);
            final android.os.CancellationSignal cancel = new android.os.CancellationSignal();
            int asked = 0;
            for (String provider : lm.getProviders(true)) {
                if (LocationManager.PASSIVE_PROVIDER.equals(provider)) continue;
                try {
                    lm.getCurrentLocation(provider, cancel, c.getMainExecutor(), l -> {
                        if (l != null) {
                            synchronized (got) {
                                if (got[0] == null) got[0] = l;
                            }
                            latch.countDown();
                        }
                    });
                    asked++;
                } catch (Throwable ignored) {
                }
            }
            if (asked > 0) {
                latch.await(20, TimeUnit.SECONDS);
                try {
                    cancel.cancel();
                } catch (Throwable ignored) {
                }
                synchronized (got) {
                    if (got[0] != null) best = got[0];
                }
            }
        }
        if (best == null) throw new Exception("location is unavailable (is location switched on?)");
        JSONObject o = new JSONObject();
        o.put("lat", Math.round(best.getLatitude() * 1e6) / 1e6);
        o.put("lon", Math.round(best.getLongitude() * 1e6) / 1e6);
        if (best.hasAccuracy()) o.put("accuracy_m", Math.round(best.getAccuracy()));
        o.put("time", time(best.getTime()));
        o.put("map", "https://maps.google.com/?q=" + o.get("lat") + "," + o.get("lon"));
        return o;
    }
}
