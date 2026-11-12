package com.pulsepointlabs.sarah;

import org.junit.Test;
import static org.junit.Assert.*;

public class OmronDeliveryTimeTest {
    @Test public void historicalCorruptPacketCannotEnterDeliveryAgain() {
        assertFalse(OmronDeliveryTime.isUsable("-0001-11-28T04:56:02Z"));
        assertFalse(OmronDeliveryTime.isUsable(""));
        assertFalse(OmronDeliveryTime.isUsable(null));
        assertFalse(OmronDeliveryTime.isUsable("garbage"));
        assertFalse(OmronDeliveryTime.isUsable("+10000-01-01T00:00:00Z"));
    }
    @Test public void validStoredReadingsKeepTheirOriginalDate() {
        assertTrue(OmronDeliveryTime.isUsable("2026-11-08T20:54:20Z"));
        assertTrue(OmronDeliveryTime.isUsable("2026-11-12T03:20:00.123Z"));
    }
}
