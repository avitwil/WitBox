package net.witbox.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;

/** Transparent activity hosting the modal "‹bot› wants to control this device" dialog. */
public class AskActivity extends Activity {
    static final String EXTRA_ASK_ID = "askId";
    static final String EXTRA_BOT_NAME = "botName";

    private String askId;
    private AlertDialog dialog;
    private boolean closing;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        show(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        show(intent);
    }

    private void show(Intent intent) {
        String id = intent == null ? null : intent.getStringExtra(EXTRA_ASK_ID);
        String botName = intent == null ? null : intent.getStringExtra(EXTRA_BOT_NAME);
        if (id == null || !PermissionGate.isPending(id)) {
            // Stale (already answered / timed out, or the process was restarted).
            if (dialog == null || !dialog.isShowing()) finish();
            return;
        }
        if (id.equals(askId) && dialog != null && dialog.isShowing()) return;
        if (dialog != null) {
            closing = true;
            dialog.dismiss();
            closing = false;
        }
        if (askId != null) PermissionGate.unregisterUi(askId, this);
        askId = id;
        PermissionGate.registerUi(id, this);

        final String theId = id;
        dialog = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setIcon(R.mipmap.ic_launcher)
                .setTitle(getString(R.string.ask_title, botName == null ? "Bot" : botName))
                .setMessage(R.string.ask_body)
                .setPositiveButton(R.string.allow_once, (d, w) -> choose(theId, PermissionGate.CHOICE_ONCE))
                .setNeutralButton(R.string.allow_always, (d, w) -> choose(theId, PermissionGate.CHOICE_ALWAYS))
                .setNegativeButton(R.string.deny, (d, w) -> choose(theId, PermissionGate.CHOICE_DENY))
                .setOnCancelListener(d -> choose(theId, PermissionGate.CHOICE_DENY))
                .create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnDismissListener(d -> {
            if (!closing && !isFinishing()) finish();
        });
        dialog.show();
    }

    private void choose(String id, String choice) {
        PermissionGate.answer(this, id, choice);
        closing = true;
        finish();
    }

    /** Called by the gate when the request was resolved elsewhere (notification action / timeout). */
    void dismissFromGate() {
        closing = true;
        try {
            if (dialog != null && dialog.isShowing()) dialog.dismiss();
        } catch (Throwable ignored) {
        }
        if (!isFinishing()) finish();
    }

    @Override
    protected void onDestroy() {
        closing = true;
        if (askId != null) PermissionGate.unregisterUi(askId, this);
        try {
            if (dialog != null && dialog.isShowing()) dialog.dismiss();
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }
}
