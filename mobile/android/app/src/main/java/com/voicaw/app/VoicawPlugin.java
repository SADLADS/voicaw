package com.voicaw.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.widget.Toast;

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

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The page's bridge to the app (client/src/utils/android.js `android`): notifications and the
 * push registration, the ongoing-call notification, and the events notifications send the page
 * (`navigate` to a chat, `callAction` answer / mute / unmute / hangUp), and updating the app
 * (AppUpdater: `updateProgress` while downloading, `updateResult` if Android didn't install it),
 * and saving files to Downloads (Downloads).
 */
@CapacitorPlugin(
    name = "Voicaw",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        // Only asked for on Android 8 and 9 (Downloads.needsPermission).
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }),
    }
)
public class VoicawPlugin extends Plugin {
    private static VoicawPlugin instance;
    private static final ExecutorService updates = Executors.newSingleThreadExecutor();
    private final AtomicBoolean updating = new AtomicBoolean();

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

    /** Android's installer didn't install the update: "aborted" (cancelled) or "failed". */
    static void emitUpdateResult(String status, String message) {
        VoicawPlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = new JSObject().put("status", status);
        if (message != null) data.put("message", message);
        plugin.notifyListeners("updateResult", data);
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

    /** The page's background behind the status and navigation bars (`color`, #rrggbb), and whether it's `light`. */
    @PluginMethod
    public void setSystemBars(PluginCall call) {
        int color;
        try {
            color = Color.parseColor(call.getString("color", ""));
        } catch (IllegalArgumentException e) {
            call.reject("Not a colour");
            return;
        }
        boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        getBridge().executeOnMainThread(() -> {
            if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).setSystemBars(color, light);
            call.resolve();
        });
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

    /** Whether a newer version is out: { supported (false in Play's build), current, available, version, size }. */
    @PluginMethod
    public void checkForUpdate(PluginCall call) {
        updates.execute(() -> {
            try {
                call.resolve(AppUpdater.check(getContext()));
            } catch (Exception e) {
                call.reject("Couldn't check for updates", e);
            }
        });
    }

    /**
     * Downloads the newest version (`updateProgress` { received, total } as it comes) and hands
     * it to Android's installer; resolves once Android asks the person to confirm.
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        if (!updating.compareAndSet(false, true)) {
            call.reject("Already updating");
            return;
        }
        updates.execute(() -> {
            long[] last = { 0, -1 }; // when, percent
            try {
                AppUpdater.downloadAndInstall(getContext(), (received, total) -> {
                    long percent = total > 0 ? received * 100 / total : 0;
                    long now = System.currentTimeMillis();
                    if (percent == last[1] || (now - last[0] < 200 && percent < 100)) return;
                    last[0] = now;
                    last[1] = percent;
                    notifyListeners("updateProgress", new JSObject().put("received", received).put("total", total));
                });
                call.resolve();
            } catch (Exception e) {
                call.reject("Couldn't download the update", e);
            } finally {
                updating.set(false);
            }
        });
    }

    /** Starts saving a file to Downloads ({ name, type }); resolves { id } for the pieces. */
    @PluginMethod
    public void saveFileStart(PluginCall call) {
        if (Downloads.needsPermission() && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermission");
            return;
        }
        startSaving(call);
    }

    @PermissionCallback
    private void storagePermission(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) startSaving(call);
        else call.reject("Storage permission denied", "denied");
    }

    private void startSaving(PluginCall call) {
        try {
            String id = Downloads.start(getContext(), call.getString("name"), call.getString("type"));
            call.resolve(new JSObject().put("id", id));
        } catch (Exception e) {
            call.reject("Couldn't save the file", e);
        }
    }

    /** The next piece of a file being saved ({ id, data: base64 }). */
    @PluginMethod
    public void saveFileAppend(PluginCall call) {
        String id = call.getString("id");
        try {
            Downloads.append(id, Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            Downloads.cancel(getContext(), id);
            call.reject("Couldn't save the file", e);
        }
    }

    /** Ends a file being saved ({ id, open: open it afterwards }); resolves { opened }. */
    @PluginMethod
    public void saveFileFinish(PluginCall call) {
        String id = call.getString("id");
        try {
            Uri uri = Downloads.finish(getContext(), id);
            boolean opened = Boolean.TRUE.equals(call.getBoolean("open", false))
                && Downloads.open(getContext(), uri, Downloads.mimeOf(getContext(), uri));
            call.resolve(new JSObject().put("opened", opened));
        } catch (Exception e) {
            Downloads.cancel(getContext(), id);
            call.reject("Couldn't save the file", e);
        }
    }

    /** Throws away a file the page couldn't finish sending ({ id }). */
    @PluginMethod
    public void saveFileCancel(PluginCall call) {
        Downloads.cancel(getContext(), call.getString("id"));
        call.resolve();
    }

    /** A short message at the bottom of the screen ({ message }). */
    @PluginMethod
    public void showToast(PluginCall call) {
        String message = call.getString("message", "");
        getActivity().runOnUiThread(() -> Toast.makeText(getContext(), message, Toast.LENGTH_SHORT).show());
        call.resolve();
    }
}
