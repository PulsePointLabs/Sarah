package com.pulsepointlabs.sarah;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private SarahWebChromeClient sarahWebChromeClient;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BloodPressureHealthPlugin.class);
        registerPlugin(OmronBloodPressurePlugin.class);
        registerPlugin(SarahFileSaverPlugin.class);
        registerPlugin(SarahBackgroundJobsPlugin.class);
        registerPlugin(SarahMediaPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            sarahWebChromeClient = new SarahWebChromeClient(this, getBridge());
            getBridge().getWebView().setWebChromeClient(sarahWebChromeClient);
        }
    }

    @Override
    public void onBackPressed() {
        if (sarahWebChromeClient != null && sarahWebChromeClient.hideCustomView()) return;
        super.onBackPressed();
    }

    @Override
    public void onDestroy() {
        if (sarahWebChromeClient != null) sarahWebChromeClient.hideCustomView();
        super.onDestroy();
    }
}
