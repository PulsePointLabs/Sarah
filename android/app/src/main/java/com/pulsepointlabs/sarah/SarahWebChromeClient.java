package com.pulsepointlabs.sarah;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Capacitor's default WebChromeClient dismisses HTML video custom views.
 * Sarah keeps the normal Capacitor behavior but hosts video fullscreen views.
 */
public class SarahWebChromeClient extends BridgeWebChromeClient {
    private final Activity activity;
    private final Bridge bridge;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private int previousSystemUiVisibility;
    private int previousOrientation;

    public SarahWebChromeClient(Activity activity, Bridge bridge) {
        super(bridge);
        this.activity = activity;
        this.bridge = bridge;
    }

    @Override
    public void onShowCustomView(View view, WebChromeClient.CustomViewCallback callback) {
        if (customView != null) {
            callback.onCustomViewHidden();
            return;
        }

        customView = view;
        customViewCallback = callback;
        previousSystemUiVisibility = activity.getWindow().getDecorView().getSystemUiVisibility();
        previousOrientation = activity.getRequestedOrientation();

        if (customView.getParent() instanceof ViewGroup) {
            ((ViewGroup) customView.getParent()).removeView(customView);
        }
        customView.setBackgroundColor(Color.BLACK);
        FrameLayout decor = (FrameLayout) activity.getWindow().getDecorView();
        decor.addView(customView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        bridge.getWebView().setVisibility(View.INVISIBLE);
        activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        decor.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );
        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
    }

    @Override
    public void onHideCustomView() {
        hideCustomView();
    }

    public boolean hideCustomView() {
        if (customView == null) return false;

        FrameLayout decor = (FrameLayout) activity.getWindow().getDecorView();
        decor.removeView(customView);
        customView = null;
        bridge.getWebView().setVisibility(View.VISIBLE);
        activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        decor.setSystemUiVisibility(previousSystemUiVisibility);
        activity.setRequestedOrientation(previousOrientation);

        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
        return true;
    }
}
