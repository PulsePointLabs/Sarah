package com.pulsepointlabs.sarah;

import android.content.Intent;
import android.os.Bundle;
import android.content.res.Configuration;
import android.webkit.WebView;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private SarahWebChromeClient sarahWebChromeClient;
    private int phoneTextZoom = 100;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BloodPressureHealthPlugin.class);
        registerPlugin(BodyCompositionHealthPlugin.class);
        registerPlugin(OmronBloodPressurePlugin.class);
        registerPlugin(SarahFileSaverPlugin.class);
        registerPlugin(SarahBackgroundJobsPlugin.class);
        registerPlugin(SarahMediaPlugin.class);
        registerPlugin(SarahKeepAwakePlugin.class);
        registerPlugin(SarahH10Plugin.class);
        registerPlugin(SharedVitalImportPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            phoneTextZoom = getBridge().getWebView().getSettings().getTextZoom();
            configureDisplay(getResources().getConfiguration());
            sarahWebChromeClient = new SarahWebChromeClient(this, getBridge());
            getBridge().getWebView().setWebChromeClient(sarahWebChromeClient);
            if (BuildConfig.SARAH_CHAT_ONLY) {
                getBridge().getWebView().postDelayed(() -> {
                    String appUrl = getBridge().getAppUrl();
                    String separator = appUrl.endsWith("/") ? "" : "/";
                    getBridge().getWebView().loadUrl(appUrl + separator + "chat?standalone=1");
                }, 250);
            }
        }
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        configureDisplay(configuration);
    }

    private void configureDisplay(Configuration configuration) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        boolean samsungDesktop = false;
        // Samsung documents these fields; fall back safely on non-Samsung devices.
        try {
            samsungDesktop = configuration.getClass().getField("SEM_DESKTOP_MODE_ENABLED").getInt(configuration)
                == configuration.getClass().getField("semDesktopModeEnabled").getInt(configuration);
        } catch (ReflectiveOperationException | SecurityException ignored) { }
        boolean desktop = SarahDisplayPolicy.useDesktopScale(
            (configuration.uiMode & Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_DESK,
            samsungDesktop, getWindowManager().getDefaultDisplay().getDisplayId(), configuration.screenWidthDp);
        // Honor width=device-width rather than retaining a narrow compatibility viewport.
        webView.getSettings().setUseWideViewPort(true);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.getSettings().setTextZoom(desktop ? 100 : phoneTextZoom);
        webView.setInitialScale(0);
        webView.post(() -> {
            webView.requestLayout();
            webView.invalidate();
            webView.evaluateJavascript("window.dispatchEvent(new Event('resize'));", null);
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
    }

    @Override
    public void onBackPressed() {
        if (sarahWebChromeClient != null && sarahWebChromeClient.hideCustomView()) return;
        super.onBackPressed();
    }

    @Override
    public void onDestroy() {
        if (sarahWebChromeClient != null) sarahWebChromeClient.hideCustomView();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onDestroy();
    }
}
