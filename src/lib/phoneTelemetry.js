import { registerPlugin } from '@capacitor/core';

export const PhoneTelemetry = registerPlugin('SarahTelemetry');
let phoneAcquisition = false;
export const isNativeSarah = () => Boolean(window.Capacitor?.isNativePlatform?.());
export const isPhoneAcquisition = () => isNativeSarah() && phoneAcquisition;
export function setPhoneAcquisition(enabled) { phoneAcquisition = Boolean(enabled); }
