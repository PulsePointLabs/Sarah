package com.pulsepointlabs.sarah;

final class SarahDisplayPolicy {
    private SarahDisplayPolicy() {}

    static boolean useDesktopScale(boolean deskMode, boolean samsungDesktop, int displayId, int widthDp) {
        // Keep phone accessibility sizing even while DeX runs on another display.
        return deskMode || (samsungDesktop && (displayId != 0 || widthDp >= 600));
    }
}
