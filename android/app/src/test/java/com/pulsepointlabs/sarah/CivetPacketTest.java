package com.pulsepointlabs.sarah;

import org.junit.Test;
import static org.junit.Assert.*;

public class CivetPacketTest {
    @Test public void decodesSignedLittleEndianHundredthsOfKpa() {
        assertEquals(Integer.valueOf(1234),CivetPacket.decode("d000000000000000d204"));
        assertEquals(Integer.valueOf(-1234),CivetPacket.decode("d0000000000000002efb"));
        assertEquals(Integer.valueOf(0),CivetPacket.decode("d0000000000000000000"));
    }
    @Test public void rejectsTruncatedWrongTypeAndMalformedPackets() {
        assertNull(CivetPacket.decode(null));
        assertNull(CivetPacket.decode("d000"));
        assertNull(CivetPacket.decode("5000000000000000d204"));
        assertNull(CivetPacket.decode("d000000000000000zz04"));
        assertNull(CivetPacket.decode("d0"+"00".repeat(20)));
    }
}
