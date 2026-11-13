package com.pulsepointlabs.sarah;

/** Same wire format as the existing CIVET helper; no inferred samples. */
public final class CivetPacket {
    private CivetPacket() {}
    public static Integer decode(String hex) {
        if(hex == null || hex.length()<20 || hex.length()>40 || hex.length()%2!=0 || !hex.matches("(?i)d0[0-9a-f]+")) return null;
        int raw=Integer.parseInt(hex.substring(16,18),16)|(Integer.parseInt(hex.substring(18,20),16)<<8);
        return (int)(short)raw;
    }
}
