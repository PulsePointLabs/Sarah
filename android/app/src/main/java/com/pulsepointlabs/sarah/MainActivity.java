package com.pulsepointlabs.sarah;

import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private SarahWebChromeClient sarahWebChromeClient;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BloodPressureHealthPlugin.class);
        registerPlugin(BodyCompositionHealthPlugin.class);
        registerPlugin(OmronBloodPressurePlugin.class);
        registerPlugin(SarahFileSaverPlugin.class);
        registerPlugin(SarahBackgroundJobsPlugin.class);
        registerPlugin(SarahMediaPlugin.class);
        registerPlugin(SarahKeepAwakePlugin.class);
        registerPlugin(SharedVitalImportPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
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
