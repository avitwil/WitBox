package net.witbox.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Notification actions of the permission dialog (Allow once / Always / Deny) and the Stop action. */
public class ControlActionReceiver extends BroadcastReceiver {
    static final String ACTION_ANSWER = "net.witbox.app.ASK_ANSWER";
    static final String ACTION_STOP = "net.witbox.app.CONTROL_STOP";
    static final String EXTRA_ASK_ID = "askId";
    static final String EXTRA_CHOICE = "choice";
    static final String EXTRA_BOT_ID = "botId";
    static final String EXTRA_BOT_NAME = "botName";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        // Receivers run on the main thread, which is what PermissionGate expects.
        if (ACTION_ANSWER.equals(intent.getAction())) {
            PermissionGate.answer(context, intent.getStringExtra(EXTRA_ASK_ID),
                    intent.getStringExtra(EXTRA_CHOICE));
        } else if (ACTION_STOP.equals(intent.getAction())) {
            PermissionGate.stop(context, intent.getStringExtra(EXTRA_BOT_ID),
                    intent.getStringExtra(EXTRA_BOT_NAME));
        }
    }
}
