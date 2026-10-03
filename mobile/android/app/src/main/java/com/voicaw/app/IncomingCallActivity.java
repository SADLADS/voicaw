package com.voicaw.app;

import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.drawable.RoundedBitmapDrawable;
import androidx.core.graphics.drawable.RoundedBitmapDrawableFactory;

/**
 * The ringing screen: what a call's full-screen notification opens, also over the lock screen.
 * Only the caller's name and two buttons; nothing of the app shows until the phone is unlocked
 * (Answer asks for that, then opens the app, which answers).
 */
public class IncomingCallActivity extends AppCompatActivity {
    static final String EXTRA_TITLE = "voicaw.title";
    static final String EXTRA_BODY = "voicaw.body";
    static final String EXTRA_ANSWER_LABEL = "voicaw.answerLabel";
    static final String EXTRA_DECLINE_LABEL = "voicaw.declineLabel";

    private static IncomingCallActivity current;
    private String callId;

    /** The call stopped ringing: close its screen if it's showing. */
    static void finishFor(String callId) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (current != null && callId.equals(current.callId)) current.finish();
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        show(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        show(intent);
    }

    private void show(Intent intent) {
        callId = intent.getStringExtra(Notifications.EXTRA_CALL_ID);
        if (callId == null) {
            finish();
            return;
        }
        current = this;
        String url = intent.getStringExtra(Notifications.EXTRA_URL);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(getColor(R.color.call_background));
        root.setPadding(dp(24), dp(96), dp(24), dp(64));

        ImageView picture = new ImageView(this);
        Bitmap bitmap = Notifications.callerPictures.get(callId);
        if (bitmap != null) {
            RoundedBitmapDrawable round = RoundedBitmapDrawableFactory.create(getResources(), bitmap);
            round.setCircular(true);
            picture.setImageDrawable(round);
        } else {
            picture.setImageResource(R.mipmap.ic_launcher_round);
        }
        root.addView(picture, new LinearLayout.LayoutParams(dp(112), dp(112)));

        TextView title = new TextView(this);
        title.setText(intent.getStringExtra(EXTRA_TITLE));
        title.setTextColor(getColor(R.color.call_text));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(24), 0, dp(8));
        root.addView(title);

        TextView body = new TextView(this);
        body.setText(intent.getStringExtra(EXTRA_BODY));
        body.setTextColor(getColor(R.color.call_subtext));
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        body.setGravity(Gravity.CENTER);
        root.addView(body);

        LinearLayout spacer = new LinearLayout(this);
        root.addView(spacer, new LinearLayout.LayoutParams(0, 0, 1));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        Button decline = button(intent.getStringExtra(EXTRA_DECLINE_LABEL), R.color.call_decline);
        decline.setOnClickListener(v -> {
            CallActionReceiver.decline(this, callId, null);
            finish();
        });
        Button answer = button(intent.getStringExtra(EXTRA_ANSWER_LABEL), R.color.call_answer);
        answer.setOnClickListener(v -> answer(url));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(64), 1);
        params.setMargins(dp(12), 0, dp(12), 0);
        buttons.addView(decline, params);
        buttons.addView(answer, new LinearLayout.LayoutParams(params));
        root.addView(buttons, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    // Unlock first (the app never shows over the lock screen), then the app answers.
    private void answer(String url) {
        String id = callId;
        Runnable open = () -> {
            startActivity(Notifications.answerIntent(this, id, url));
            finish();
        };
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && keyguard != null && keyguard.isKeyguardLocked()) {
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    open.run();
                }
            });
        } else {
            open.run();
        }
    }

    private Button button(String text, int color) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        button.setTextColor(getColor(R.color.call_text));
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(getColor(color));
        shape.setCornerRadius(dp(32));
        button.setBackground(shape);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        super.onDestroy();
    }
}
