package net.witbox.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Device-control agent. Executes the actions of CLIENT_CONTRACT §4 that arrive over /ws/device
 * (see {@link DeviceLink}); the permission gate has already been passed when perform() is called.
 */
public class ControlService extends AccessibilityService {
    private static final String TAG = "CBControl";
    private static final int MAX_SIDE = 1568;
    private static final int JPEG_QUALITY = 70;

    private static volatile ControlService instance;

    static ControlService get() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        Log.i(TAG, "accessibility service connected");
        DeviceLink.ensureStarted(this);
        try {
            // Keep the notification/keep-alive service up as well (best effort).
            ContextCompat.startForegroundService(this, new Intent(this, NotifyService.class));
        } catch (Throwable t) {
            Log.w(TAG, "cannot start NotifyService: " + t);
        }
        MainActivity.emitToPage("controlStateChanged", enabledJson(true));
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (instance == this) instance = null;
        MainActivity.emitToPage("controlStateChanged", enabledJson(false));
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    private static JSONObject enabledJson(boolean enabled) {
        JSONObject o = new JSONObject();
        try {
            o.put("controlEnabled", enabled);
        } catch (Throwable ignored) {
        }
        return o;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Events are not used; the service only acts on explicit requests.
    }

    @Override
    public void onInterrupt() {
    }

    // =====================================================================================
    // Action dispatcher (worker thread, never the main thread)
    // =====================================================================================

    JSONObject perform(JSONObject a) throws Exception {
        String type = a.optString("type", "");
        switch (type) {
            case "screenshot":
                return screenshot();
            case "click": {
                String button = a.optString("button", "left");
                float[] p = toReal(num(a, "x"), num(a, "y"));
                if ("right".equals(button) || "middle".equals(button)) {
                    press(p[0], p[1], 650); // long-press is the touch equivalent of a context click
                } else if (a.optBoolean("double", false)) {
                    doubleTap(p[0], p[1]);
                } else {
                    press(p[0], p[1], 60);
                }
                return ok();
            }
            case "tap": {
                float[] p = toReal(num(a, "x"), num(a, "y"));
                long ms = a.optLong("ms", 60);
                press(p[0], p[1], clamp(ms, 1, 10_000));
                return ok();
            }
            case "move":
                return ok(); // no pointer on a touch screen
            case "drag":
            case "swipe": {
                float[] p1 = toReal(num(a, "x1"), num(a, "y1"));
                float[] p2 = toReal(num(a, "x2"), num(a, "y2"));
                long ms = a.optLong("ms", "drag".equals(type) ? 600 : 300);
                long hold = a.optLong("hold", 0);
                swipe(p1[0], p1[1], p2[0], p2[1], clamp(ms, 20, 10_000), clamp(hold, 0, 5_000));
                return ok();
            }
            case "scroll": {
                float[] p = toReal(num(a, "x"), num(a, "y"));
                scroll(p[0], p[1], a.optDouble("dx", 0), a.optDouble("dy", 0));
                return ok();
            }
            case "type":
                typeText(a.optString("text", ""));
                return ok();
            case "key":
                keys(a.optString("keys", ""));
                return ok();
            case "global":
                global(a.optString("name", ""));
                return ok();
            case "open_app":
                openApp(a.optString("package", ""));
                return ok();
            default:
                throw new Exception("unsupported action: " + type);
        }
    }

    private static JSONObject ok() throws Exception {
        return new JSONObject().put("ok", true);
    }

    private static double num(JSONObject a, String key) throws Exception {
        if (!a.has(key)) throw new Exception("missing '" + key + "'");
        double v = a.optDouble(key, Double.NaN);
        if (Double.isNaN(v) || Double.isInfinite(v)) throw new Exception("bad '" + key + "'");
        return v;
    }

    private static long clamp(long v, long lo, long hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    // =====================================================================================
    // Screen geometry: screenshots are downscaled so the longest side is ≤ 1568 px; incoming
    // coordinates are in screenshot pixels and are mapped back to real pixels here.
    // =====================================================================================

    private Point realSize() {
        Point p = new Point();
        try {
            DisplayManager dm = getSystemService(DisplayManager.class);
            Display d = dm == null ? null : dm.getDisplay(Display.DEFAULT_DISPLAY);
            if (d != null) d.getRealSize(p);
        } catch (Throwable ignored) {
        }
        if (p.x <= 0 || p.y <= 0) {
            p.x = getResources().getDisplayMetrics().widthPixels;
            p.y = getResources().getDisplayMetrics().heightPixels;
        }
        return p;
    }

    /** real pixels per screenshot pixel (≥ 1). */
    private static float scaleFor(int w, int h) {
        int longest = Math.max(w, h);
        return longest > MAX_SIDE ? longest / (float) MAX_SIDE : 1f;
    }

    private float[] toReal(double x, double y) {
        Point s = realSize();
        float k = scaleFor(s.x, s.y);
        float rx = (float) Math.max(0, Math.min(s.x - 1, x * k));
        float ry = (float) Math.max(0, Math.min(s.y - 1, y * k));
        return new float[]{rx, ry};
    }

    private JSONObject screenshot() throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            throw new Exception("screenshot requires Android 11 or newer");
        }
        Bitmap full = ScreenshotApi30.capture(this);
        Bitmap scaled = null;
        try {
            float k = scaleFor(full.getWidth(), full.getHeight());
            int w = Math.max(1, Math.round(full.getWidth() / k));
            int h = Math.max(1, Math.round(full.getHeight() / k));
            scaled = (k == 1f) ? full : Bitmap.createScaledBitmap(full, w, h, true);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(256 * 1024);
            if (!scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, bos)) {
                throw new Exception("JPEG encoding failed");
            }
            JSONObject res = new JSONObject();
            res.put("image", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            res.put("width", scaled.getWidth());
            res.put("height", scaled.getHeight());
            return res;
        } finally {
            if (scaled != null && scaled != full) scaled.recycle();
            full.recycle();
        }
    }

    // =====================================================================================
    // Gestures
    // =====================================================================================

    private void dispatch(GestureDescription g, long durationMs) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicBoolean completed = new AtomicBoolean(false);
        boolean accepted = dispatchGesture(g, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                completed.set(true);
                latch.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                latch.countDown();
            }
        }, null);
        if (!accepted) throw new Exception("gesture could not be dispatched");
        if (!latch.await(durationMs + 5_000, TimeUnit.MILLISECONDS)) throw new Exception("gesture timed out");
        if (!completed.get()) throw new Exception("gesture was cancelled");
    }

    /** Give the UI a moment to react before the next action / screenshot. */
    private static void settle() throws InterruptedException {
        Thread.sleep(80);
    }

    private void press(float x, float y, long ms) throws Exception {
        Path p = new Path();
        p.moveTo(x, y);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(1, ms)))
                .build();
        dispatch(g, ms);
        settle();
    }

    private void doubleTap(float x, float y) throws Exception {
        Path p1 = new Path();
        p1.moveTo(x, y);
        Path p2 = new Path();
        p2.moveTo(x, y);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p1, 0, 50))
                .addStroke(new GestureDescription.StrokeDescription(p2, 150, 50))
                .build();
        dispatch(g, 200);
        settle();
    }

    private void swipe(float x1, float y1, float x2, float y2, long ms, long holdMs) throws Exception {
        if (holdMs > 0) {
            // Long-press first, then move without lifting (drag & drop).
            Path hold = new Path();
            hold.moveTo(x1, y1);
            Path move = new Path();
            move.moveTo(x1, y1);
            move.lineTo(x2, y2);
            GestureDescription.StrokeDescription s1 =
                    new GestureDescription.StrokeDescription(hold, 0, holdMs, true);
            GestureDescription.StrokeDescription s2 = s1.continueStroke(move, 0, ms, false);
            dispatch(new GestureDescription.Builder().addStroke(s1).build(), holdMs);
            dispatch(new GestureDescription.Builder().addStroke(s2).build(), ms);
            settle();
            return;
        }
        Path p = new Path();
        p.moveTo(x1, y1);
        p.lineTo(x2, y2);
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, ms))
                .build();
        dispatch(g, ms);
        settle();
    }

    /** Wheel-style scroll: dy &lt; 0 scrolls up (content moves down), so the finger moves down. */
    private void scroll(float x, float y, double dx, double dy) throws Exception {
        if (dx == 0 && dy == 0) return;
        Point s = realSize();
        dx = Math.max(-10, Math.min(10, dx));
        dy = Math.max(-10, Math.min(10, dy));
        float stepY = s.y * 0.09f;
        float stepX = s.x * 0.09f;
        float halfX = (float) (dx * stepX / 2), halfY = (float) (dy * stepY / 2);
        float minX = s.x * 0.04f, maxX = s.x * 0.96f, minY = s.y * 0.06f, maxY = s.y * 0.94f;
        float sx = Math.max(minX, Math.min(maxX, x + halfX));
        float ex = Math.max(minX, Math.min(maxX, x - halfX));
        float sy = Math.max(minY, Math.min(maxY, y + halfY));
        float ey = Math.max(minY, Math.min(maxY, y - halfY));
        long ms = clamp((long) (250 + 60 * Math.max(Math.abs(dx), Math.abs(dy))), 250, 900);
        swipe(sx, sy, ex, ey, ms, 0);
    }

    // =====================================================================================
    // Text input
    // =====================================================================================

    private AccessibilityNodeInfo focusedInput() {
        AccessibilityNodeInfo n = null;
        try {
            n = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        } catch (Throwable ignored) {
        }
        if (n == null) {
            try {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root != null) n = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            } catch (Throwable ignored) {
            }
        }
        if (n != null) {
            try {
                n.refresh();
            } catch (Throwable ignored) {
            }
        }
        return n;
    }

    private AccessibilityNodeInfo requireInput() throws Exception {
        AccessibilityNodeInfo n = focusedInput();
        if (n == null) throw new Exception("no focused input field (tap a text field first)");
        return n;
    }

    /** Current text of an editable node ("" for hints / unreadable password fields). */
    private static String textOf(AccessibilityNodeInfo n) {
        if (n.isShowingHintText() || n.isPassword()) return "";
        CharSequence cs = n.getText();
        return cs == null ? "" : cs.toString();
    }

    private static boolean setText(AccessibilityNodeInfo n, String text, int cursor) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false;
        setSelection(n, cursor, cursor);
        return true;
    }

    private static boolean setSelection(AccessibilityNodeInfo n, int start, int end) {
        try {
            Bundle sel = new Bundle();
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start);
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end);
            return n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
        } catch (Throwable t) {
            return false;
        }
    }

    /** Selection range clamped to the text, {start, end} with start ≤ end; defaults to the end. */
    private static int[] selection(AccessibilityNodeInfo n, int len) {
        int a = n.getTextSelectionStart(), b = n.getTextSelectionEnd();
        if (a < 0 || b < 0 || a > len || b > len) return new int[]{len, len};
        return new int[]{Math.min(a, b), Math.max(a, b)};
    }

    private boolean paste(AccessibilityNodeInfo n, String text) {
        try {
            ClipboardManager cm = getSystemService(ClipboardManager.class);
            if (cm == null) return false;
            cm.setPrimaryClip(ClipData.newPlainText("WitBox", text));
            return n.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        } catch (Throwable t) {
            return false;
        }
    }

    private void typeText(String text) throws Exception {
        if (text.isEmpty()) return;
        AccessibilityNodeInfo n = requireInput();
        if (n.isPassword()) {
            // The current content of password fields is not readable, so insert at the cursor.
            if (paste(n, text)) return;
            if (setText(n, text, text.length())) return;
            throw new Exception("could not enter text");
        }
        String cur = textOf(n);
        int[] sel = selection(n, cur.length());
        String next = cur.substring(0, sel[0]) + text + cur.substring(sel[1]);
        if (setText(n, next, sel[0] + text.length())) return;
        if (paste(n, text)) return;
        throw new Exception("could not enter text");
    }

    private void editDelete(boolean forward) throws Exception {
        AccessibilityNodeInfo n = requireInput();
        String cur = textOf(n);
        int[] sel = selection(n, cur.length());
        int a = sel[0], b = sel[1];
        if (a == b) {
            if (forward) {
                if (b >= cur.length()) return;
                b = cur.offsetByCodePoints(b, 1);
            } else {
                if (a <= 0) return;
                a = cur.offsetByCodePoints(a, -1);
            }
        }
        String next = cur.substring(0, a) + cur.substring(b);
        if (!setText(n, next, a)) throw new Exception("could not edit text");
    }

    private void imeEnter() throws Exception {
        AccessibilityNodeInfo n = requireInput();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (n.performAction(android.R.id.accessibilityActionImeEnter)) return;
        }
        if (n.isMultiLine()) {
            typeText("\n");
            return;
        }
        throw new Exception("Return is not supported for this field on this Android version");
    }

    private void moveCursor(String key) throws Exception {
        AccessibilityNodeInfo n = focusedInput();
        if (n != null && !n.isPassword()) {
            String cur = textOf(n);
            int[] sel = selection(n, cur.length());
            int pos;
            switch (key) {
                case "left":
                    pos = sel[0] == sel[1] ? Math.max(0, sel[0] - 1) : sel[0];
                    break;
                case "right":
                    pos = sel[0] == sel[1] ? Math.min(cur.length(), sel[1] + 1) : sel[1];
                    break;
                case "home":
                    pos = 0;
                    break;
                default:
                    pos = cur.length();
                    break;
            }
            if (setSelection(n, pos, pos)) return;
        }
        if (Build.VERSION.SDK_INT >= 33) {
            if ("left".equals(key) && performGlobalAction(GLOBAL_ACTION_DPAD_LEFT)) return;
            if ("right".equals(key) && performGlobalAction(GLOBAL_ACTION_DPAD_RIGHT)) return;
        }
        throw new Exception("key not supported here: " + key);
    }

    // =====================================================================================
    // Keys (xdotool-style names, e.g. "ctrl+c", "Return"; several chords may be space-separated)
    // =====================================================================================

    private void keys(String spec) throws Exception {
        if (spec.isEmpty()) throw new Exception("missing 'keys'");
        if (spec.trim().isEmpty()) { // a literal space
            typeText(" ");
            return;
        }
        for (String chord : spec.trim().split("\\s+")) {
            if (!chord.isEmpty()) chord(chord);
        }
    }

    private void chord(String chord) throws Exception {
        Set<String> mods = new HashSet<>();
        String key;
        if (chord.equals("+")) {
            key = "+";
        } else {
            String[] parts = chord.endsWith("++")
                    ? (chord.substring(0, chord.length() - 1) + "plus").split("\\+")
                    : chord.split("\\+");
            key = parts[parts.length - 1];
            for (int i = 0; i < parts.length - 1; i++) mods.add(parts[i].toLowerCase(Locale.ROOT));
        }
        String k = key.toLowerCase(Locale.ROOT);
        boolean ctrl = mods.contains("ctrl") || mods.contains("control");
        boolean alt = mods.contains("alt");
        boolean sup = mods.contains("super") || mods.contains("meta") || mods.contains("cmd");
        boolean shift = mods.contains("shift");

        if (ctrl) {
            AccessibilityNodeInfo n = requireInput();
            boolean done;
            switch (k) {
                case "a": {
                    String cur = textOf(n);
                    done = setSelection(n, 0, cur.length());
                    break;
                }
                case "c":
                    done = n.performAction(AccessibilityNodeInfo.ACTION_COPY);
                    break;
                case "x":
                    done = n.performAction(AccessibilityNodeInfo.ACTION_CUT);
                    break;
                case "v":
                    done = n.performAction(AccessibilityNodeInfo.ACTION_PASTE);
                    break;
                default:
                    throw new Exception("unsupported key combination: " + chord);
            }
            if (!done) throw new Exception("key combination failed: " + chord);
            return;
        }
        if (alt && k.equals("tab")) {
            global("recents");
            return;
        }
        if (sup || k.equals("super") || k.equals("super_l") || k.equals("super_r")) {
            global("home");
            return;
        }
        if (alt) throw new Exception("unsupported key combination: " + chord);

        switch (k) {
            case "return":
            case "enter":
            case "kp_enter":
                imeEnter();
                return;
            case "tab": {
                AccessibilityNodeInfo n = requireInput();
                AccessibilityNodeInfo next = n.focusSearch(shift ? View.FOCUS_BACKWARD : View.FOCUS_FORWARD);
                if (next == null || !next.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) {
                    throw new Exception("no next field to focus");
                }
                return;
            }
            case "escape":
            case "esc":
                global("back");
                return;
            case "backspace":
                editDelete(false);
                return;
            case "delete":
                editDelete(true);
                return;
            case "left":
            case "right":
            case "home":
            case "end":
                moveCursor(k);
                return;
            case "up":
            case "down": {
                if (Build.VERSION.SDK_INT >= 33 && performGlobalAction(
                        k.equals("up") ? GLOBAL_ACTION_DPAD_UP : GLOBAL_ACTION_DPAD_DOWN)) {
                    return;
                }
                throw new Exception("key not supported here: " + key);
            }
            case "page_up":
            case "prior":
            case "page_down":
            case "next": {
                Point s = realSize();
                boolean up = k.equals("page_up") || k.equals("prior");
                scroll(s.x / 2f, s.y / 2f, 0, up ? -6 : 6);
                return;
            }
            case "space":
                typeText(" ");
                return;
            case "plus":
                typeText("+");
                return;
            case "minus":
                typeText("-");
                return;
            default:
                break;
        }
        if (key.codePointCount(0, key.length()) == 1) {
            typeText(shift ? key.toUpperCase(Locale.ROOT) : key);
            return;
        }
        throw new Exception("unsupported key: " + key);
    }

    // =====================================================================================
    // Global actions / apps
    // =====================================================================================

    private void global(String name) throws Exception {
        int action;
        switch (name.toLowerCase(Locale.ROOT)) {
            case "back":
                action = GLOBAL_ACTION_BACK;
                break;
            case "home":
                action = GLOBAL_ACTION_HOME;
                break;
            case "recents":
                action = GLOBAL_ACTION_RECENTS;
                break;
            case "notifications":
                action = GLOBAL_ACTION_NOTIFICATIONS;
                break;
            case "quick_settings":
                action = GLOBAL_ACTION_QUICK_SETTINGS;
                break;
            case "power_dialog":
                action = GLOBAL_ACTION_POWER_DIALOG;
                break;
            case "lock_screen":
                if (Build.VERSION.SDK_INT < 28) throw new Exception("lock_screen requires Android 9");
                action = GLOBAL_ACTION_LOCK_SCREEN;
                break;
            default:
                throw new Exception("unknown global action: " + name);
        }
        if (!performGlobalAction(action)) throw new Exception("global action failed: " + name);
        Thread.sleep(150);
    }

    private void openApp(String pkg) throws Exception {
        if (pkg.isEmpty()) throw new Exception("missing 'package'");
        Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) throw new Exception("app not found or not launchable: " + pkg);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        startActivity(i);
        Thread.sleep(300);
    }
}
