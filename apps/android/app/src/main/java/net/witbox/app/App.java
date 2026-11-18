package net.witbox.app;

import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;

public class App extends Application {
    static final String CH_ALERTS = "alerts";
    static final String CH_MESSAGES = "messages";
    static final String CH_STATUS = "status";
    static final String CH_ASK = "control_ask";
    static final String CH_ACTIVE = "control_active";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
    }

    static void createChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel alerts = new NotificationChannel(CH_ALERTS,
                c.getString(R.string.ch_alerts), NotificationManager.IMPORTANCE_HIGH);
        alerts.enableVibration(true);
        alerts.setShowBadge(true);
        nm.createNotificationChannel(alerts);

        NotificationChannel messages = new NotificationChannel(CH_MESSAGES,
                c.getString(R.string.ch_messages), NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(messages);

        NotificationChannel status = new NotificationChannel(CH_STATUS,
                c.getString(R.string.ch_status), NotificationManager.IMPORTANCE_LOW);
        status.setShowBadge(false);
        nm.createNotificationChannel(status);

        NotificationChannel ask = new NotificationChannel(CH_ASK,
                c.getString(R.string.ch_ask), NotificationManager.IMPORTANCE_HIGH);
        ask.enableVibration(true);
        nm.createNotificationChannel(ask);

        NotificationChannel active = new NotificationChannel(CH_ACTIVE,
                c.getString(R.string.ch_active), NotificationManager.IMPORTANCE_LOW);
        active.setShowBadge(false);
        nm.createNotificationChannel(active);
    }
}
