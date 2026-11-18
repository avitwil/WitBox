package net.witbox.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

/** Native "server URL" screen. RESULT_OK when the URL was saved. */
public class ServerUrlActivity extends Activity {
    private EditText input;

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final int bg = getColor(R.color.bg), accent = getColor(R.color.accent);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(bg);
        scroll.setFillViewport(true);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(24), dp(32), dp(24), dp(24));
        scroll.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams boxLp = new LinearLayout.LayoutParams(
                Math.min(dp(520), getResources().getDisplayMetrics().widthPixels - dp(48)),
                ViewGroup.LayoutParams.WRAP_CONTENT);
        col.addView(box, boxLp);

        TextView title = new TextView(this);
        title.setText(R.string.server_title);
        title.setTextColor(getColor(R.color.text));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        box.addView(title);

        TextView help = new TextView(this);
        help.setText(R.string.server_help);
        help.setTextColor(getColor(R.color.text_dim));
        help.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        help.setPadding(0, dp(8), 0, dp(20));
        box.addView(help);

        TextView label = new TextView(this);
        label.setText(R.string.server_label);
        label.setTextColor(getColor(R.color.text_dim));
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        box.addView(label);

        input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);
        input.setTextColor(getColor(R.color.text));
        input.setHintTextColor(getColor(R.color.text_dim));
        input.setHint(R.string.server_hint);
        input.setTextDirection(View.TEXT_DIRECTION_LTR);
        input.setTextAlignment(View.TEXT_ALIGNMENT_VIEW_START);
        input.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
        input.setText(Prefs.serverUrl(this));
        input.setSelection(input.getText().length());
        GradientDrawable inBg = new GradientDrawable();
        inBg.setColor(getColor(R.color.surface));
        inBg.setCornerRadius(dp(10));
        inBg.setStroke(dp(1), 0x33FFFFFF);
        input.setBackground(inBg);
        input.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams inLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inLp.topMargin = dp(6);
        box.addView(input, inLp);
        input.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                save();
                return true;
            }
            return false;
        });

        Button save = button(getString(R.string.save), accent, Color.WHITE);
        save.setOnClickListener(v -> save());
        LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bLp.topMargin = dp(20);
        box.addView(save, bLp);

        // There is no default server to go back to: this just empties the field.
        Button reset = button(getString(R.string.clear), getColor(R.color.surface), getColor(R.color.text));
        reset.setOnClickListener(v -> {
            input.setText("");
            input.setError(null);
            input.requestFocus();
        });
        LinearLayout.LayoutParams rLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rLp.topMargin = dp(10);
        box.addView(reset, rLp);

        Button cancel = button(getString(R.string.cancel), Color.TRANSPARENT, getColor(R.color.text_dim));
        cancel.setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });
        LinearLayout.LayoutParams cLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cLp.topMargin = dp(4);
        box.addView(cancel, cLp);

        TextView credit = new TextView(this);
        credit.setText(getString(R.string.credit, BuildConfig.VERSION_NAME));
        credit.setTextColor(getColor(R.color.text_dim));
        credit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        credit.setGravity(Gravity.CENTER);
        credit.setAlpha(0.8f);
        LinearLayout.LayoutParams crLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        crLp.topMargin = dp(28);
        box.addView(credit, crLp);

        setContentView(scroll);

        // Edge-to-edge with explicit insets so nothing hides under the bars or the keyboard.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(scroll, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
    }

    private Button button(String text, int bgColor, int textColor) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(textColor);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        GradientDrawable d = new GradientDrawable();
        d.setColor(bgColor);
        d.setCornerRadius(dp(10));
        b.setBackground(d);
        b.setStateListAnimator(null);
        b.setMinHeight(dp(48));
        return b;
    }

    private void save() {
        String url = Prefs.normalizeUrl(input.getText().toString());
        if (url == null) {
            input.setError(getString(R.string.invalid_url));
            return;
        }
        boolean changed = !url.equals(Prefs.serverUrl(this));
        Prefs.setServerUrl(this, url);
        if (changed) {
            // Sockets must follow the new server (on first run they were not started yet).
            NotifyService.restartSocket();
            DeviceLink.restart();
        }
        NotifyService.start(this);
        DeviceLink.ensureStarted(this);
        setResult(RESULT_OK);
        finish();
    }
}
