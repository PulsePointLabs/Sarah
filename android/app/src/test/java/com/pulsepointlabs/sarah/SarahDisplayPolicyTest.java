package com.pulsepointlabs.sarah;

import org.junit.Test;
import static org.junit.Assert.*;

public class SarahDisplayPolicyTest {
    @Test public void desktopWindowCanShrinkWithoutReturningToPhoneScale() {
        assertTrue(SarahDisplayPolicy.useDesktopScale(false, true, 2, 400));
        assertTrue(SarahDisplayPolicy.useDesktopScale(true, false, 0, 400));
    }
    @Test public void phoneDoesNotInheritAnotherDisplaysDesktopScale() {
        assertFalse(SarahDisplayPolicy.useDesktopScale(false, true, 0, 412));
        assertFalse(SarahDisplayPolicy.useDesktopScale(false, false, 0, 800));
    }
    @Test public void samsungStandaloneDesktopOnTabletUsesDesktopScale() {
        assertTrue(SarahDisplayPolicy.useDesktopScale(false, true, 0, 900));
    }
}
