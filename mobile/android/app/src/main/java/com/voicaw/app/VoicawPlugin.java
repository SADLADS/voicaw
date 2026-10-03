package com.voicaw.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * The page's bridge to the app (client/src/utils/android.js `android`): notifications and the
 * push registration, the ongoing-call notification, and the events notifications send the page
 * (`navigate` to a chat, `callAction` answer / mute / unmute / hangUp).
 */
@CapacitorPlugin(
    name = "Voicaw",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class VoicawPlugin extends Plugin {
    private static VoicawPlugin instance;

    @Override
    public void load() {
        instance = this;
        Notifications.createChannels(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    /** A notification was tapped (also the intent that started the app). */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        String answer = intent.getStringExtra(Notifications.EXTRA_ANSWER);
        String url = intent.getStringExtra(Notifications.EXTRA_URL);
        if (answer != null) {
            Notifications.stopRinging(getContext(), answer);
            notifyListeners("callAction", new JSObject().put("action", "answer").put("callId", answer), true);
        }
        if (url != null) notifyListeners("navigate", new JSObject().put("url", url), true);
        // Handled: not again when the activity is recreated.
        intent.removeExtra(Notifications.EXTRA_ANSWER);
        intent.removeExtra(Notifications.EXTRA_URL);
    }

    /** A button on the ongoing-call notification. False if the page isn't there to act on it. */
    static boolean emitCallAction(String action, String callId) {
        VoicawPlugin plugin = instance;
        if (plugin == null) return false;
        JSObject data = new JSObject().put("action", action);
        if (callId != null) data.put("callId", callId);
        plugin.notifyListeners("callAction", data, true);
        return true;
    }

    private JSObject notificationState() {
        String permission;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionState state = getPermissionState("notifications");
            permission = state == PermissionState.GRANTED ? "granted" : state == PermissionState.DENIED ? "denied" : "prompt";
        } else {
            permission = NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
        }
        boolean fullScreen = true;
        if (Build.VERSION.SDK_INT >= 34) {
            fullScreen = getContext().getSystemService(NotificationManager.class).canUseFullScreenIntent();
        }
        return new JSObject()
            .put("permission", permission)
            .put("fullScreen", fullScreen)
            // Firebase is only set up in builds made with a google-services.json.
            .put("push", !FirebaseApp.getApps(getContext()).isEmpty());
    }

    @PluginMethod
    public void checkNotifications(PluginCall call) {
        call.resolve(notificationState());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(notificationState());
        } else {
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
        }
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        call.resolve(notificationState());
    }

    /** This phone's Firebase token and push key, for the server (server/fcm.js). */
    @PluginMethod
    public void getPushToken(PluginCall call) {
        if (FirebaseApp.getApps(getContext()).isEmpty()) {
            call.reject("This build has no Firebase set-up");
            return;
        }
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                call.reject("No push token", task.getException());
                return;
            }
            call.resolve(new JSObject().put("token", task.getResult()).put("key", PushCrypto.deviceKey(getContext())));
        });
    }

    /** The last pushes and what became of them (PushLog), newest first. */
    @PluginMethod
    public void getPushLog(PluginCall call) {
        call.resolve(new JSObject().put("entries", PushLog.entries(getContext())));
    }

    @PluginMethod
    public void setOngoing(PluginCall call) {
        CallService.show(getContext(), call.getData());
        call.resolve();
    }

    @PluginMethod
    public void clearOngoing(PluginCall call) {
        CallService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stopRinging(PluginCall call) {
        String callId = call.getString("callId");
        if (callId != null) Notifications.stopRinging(getContext(), callId);
        call.resolve();
    }

    /** Android's settings for the app: `which` is "notifications" or "fullScreen" (Android 14+). */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String packageName = getContext().getPackageName();
        Intent intent;
        if ("fullScreen".equals(call.getString("which")) && Build.VERSION.SDK_INT >= 34) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + packageName));
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName);
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName));
        }
        getActivity().startActivity(intent);
        call.resolve();
    }
}
