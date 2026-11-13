import { registerPlugin } from '@capacitor/core';

export const PhoneTelemetry = registerPlugin('SarahTelemetry');
export const isPhoneAcquisition = () => Boolean(window.Capacitor?.isNativePlatform?.());
