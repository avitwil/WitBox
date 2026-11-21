package net.witbox.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.text.TextUtils;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import okhttp3.HttpUrl;

/** Persistent settings: server URL, device id and per-bot control permission levels. */
final class Prefs {
    static final String PLATFORM = "android";

    static final String LEVEL_NEVER = "never";
    static final String LEVEL_ASK = "ask";
    static final String LEVEL_ALWAYS = "always";

    private static final String FILE = "witbox";
    private static final String FILE_PERMS = "bot_permissions";
    private static final String KEY_URL = "server_url";
    private static final String KEY_DEVICE_ID = "device_id";

    private Prefs() {}

    static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    private static SharedPreferences perms(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE_PERMS, Context.MODE_PRIVATE);
    }

    /**
     * Server base URL without a trailing slash, or "" when none was entered yet. There is no
     * built-in server: WitBox runs on the user's own machine, so the app asks on first run.
     */
    static String serverUrl(Context c) {
        String u = sp(c).getString(KEY_URL, null);
        return TextUtils.isEmpty(u) ? "" : u;
    }

    static boolean hasServer(Context c) {
        return !serverUrl(c).isEmpty();
    }

    static void setServerUrl(Context c, String url) {
        sp(c).edit().putString(KEY_URL, url).apply();
    }

    /** Returns a cleaned-up http(s) URL without trailing slash, or null when invalid. */
    static String normalizeUrl(String in) {
        if (in == null) return null;
        String s = in.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) {
            // Bare tailnet IPs default to http, names to https.
            s = (s.matches("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?(/.*)?$") ? "http://" : "https://") + s;
        }
        HttpUrl u = HttpUrl.parse(s);
        if (u == null) return null;
        String out = u.newBuilder().query(null).fragment(null).build().toString();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    static synchronized String deviceId(Context c) {
        SharedPreferences p = sp(c);
        String id = p.getString(KEY_DEVICE_ID, null);
        if (TextUtils.isEmpty(id)) {
            id = UUID.randomUUID().toString();
            p.edit().putString(KEY_DEVICE_ID, id).commit();
        }
        return id;
    }

    static String deviceName(Context c) {
        String name = null;
        try {
            name = Settings.Global.getString(c.getContentResolver(), "device_name");
        } catch (Throwable ignored) {
        }
        if (TextUtils.isEmpty(name)) {
            String man = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
            String model = Build.MODEL == null ? "Android" : Build.MODEL;
            name = model.toLowerCase(Locale.ROOT).startsWith(man.toLowerCase(Locale.ROOT))
                    ? model : (man + " " + model).trim();
        }
        return name;
    }

    /** scheme://host:port of a URL, lower-cased, or null. */
    static String origin(String url) {
        if (url == null) return null;
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            String host = u.getHost();
            if (scheme == null || host == null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            int port = u.getPort();
            if (port == -1) {
                if ("https".equals(scheme) || "wss".equals(scheme)) port = 443;
                else if ("http".equals(scheme) || "ws".equals(scheme)) port = 80;
            }
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + ":" + port;
        } catch (Throwable t) {
            return null;
        }
    }

    static boolean sameOrigin(String a, String b) {
        String oa = origin(a);
        return oa != null && oa.equals(origin(b));
    }

    static boolean isServerOrigin(Context c, String url) {
        return sameOrigin(url, serverUrl(c));
    }

    // ---- per-bot permission levels -------------------------------------------------------

    static String getLevel(Context c, String botId) {
        if (botId == null) return LEVEL_NEVER;
        String v = perms(c).getString(botId, LEVEL_NEVER);
        return isValidLevel(v) ? v : LEVEL_NEVER;
    }

    static boolean isValidLevel(String v) {
        return LEVEL_NEVER.equals(v) || LEVEL_ASK.equals(v) || LEVEL_ALWAYS.equals(v);
    }

    /** never = 0 &lt; ask = 1 &lt; always = 2. */
    static int levelRank(String level) {
        if (LEVEL_ALWAYS.equals(level)) return 2;
        if (LEVEL_ASK.equals(level)) return 1;
        return 0;
    }

    static void setLevel(Context c, String botId, String level) {
        if (botId == null || !isValidLevel(level)) return;
        SharedPreferences.Editor e = perms(c).edit();
        if (LEVEL_NEVER.equals(level)) e.remove(botId);
        else e.putString(botId, level);
        e.commit();
    }

    // ---- device tools (full edition): one switch per tool, all off by default ---------------

    private static final String FILE_TOOLS = "device_tools";
    private static final String KEY_HIDE_CODES = "hide_codes";

    private static SharedPreferences tools(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE_TOOLS, Context.MODE_PRIVATE);
    }

    static boolean toolOn(Context c, String tool) {
        return tools(c).getBoolean("on_" + tool, false);
    }

    static void setTool(Context c, String tool, boolean on) {
        tools(c).edit().putBoolean("on_" + tool, on).commit();
    }

    /** Verification codes in SMS / notifications are withheld from bots unless switched off. */
    static boolean hideCodes(Context c) {
        return tools(c).getBoolean(KEY_HIDE_CODES, true);
    }

    static void setHideCodes(Context c, boolean hide) {
        tools(c).edit().putBoolean(KEY_HIDE_CODES, hide).commit();
    }

    static JSONObject allLevels(Context c) {
        JSONObject o = new JSONObject();
        for (Map.Entry<String, ?> e : perms(c).getAll().entrySet()) {
            Object v = e.getValue();
            if (v instanceof String && isValidLevel((String) v)) {
                try {
                    o.put(e.getKey(), v);
                } catch (JSONException ignored) {
                }
            }
        }
        return o;
    }
}
