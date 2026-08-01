import { registerPlugin } from "@capacitor/core";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

const SarahVoiceOverlay = registerPlugin("SarahVoiceOverlay");

const unsupportedState = Object.freeze({
  native: false,
  permissionGranted: false,
  enabled: false,
  serviceState: "idle",
  lastError: "",
});

export function isNativeVoiceOverlaySupported() {
  return isSarahNativeShell();
}

export async function getNativeVoiceOverlayState() {
  if (!isNativeVoiceOverlaySupported()) return unsupportedState;
  return SarahVoiceOverlay.getState();
}

export async function requestNativeVoiceOverlayPermission() {
  if (!isNativeVoiceOverlaySupported()) return unsupportedState;
  return SarahVoiceOverlay.requestPermission();
}

export async function setNativeVoiceOverlayEnabled(enabled) {
  if (!isNativeVoiceOverlaySupported()) return unsupportedState;
  const next = await SarahVoiceOverlay.setEnabled({ enabled: Boolean(enabled) });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("sarah:voice-overlay-state", { detail: next }));
  }
  return next;
}

export async function configureNativeVoiceOverlay(configuration = {}) {
  if (!isNativeVoiceOverlaySupported()) return unsupportedState;
  return SarahVoiceOverlay.configure(configuration);
}

export async function ensureNativeVoiceOverlayRunning(configuration = {}) {
  if (!isNativeVoiceOverlaySupported()) return unsupportedState;
  return SarahVoiceOverlay.ensureRunning(configuration);
}
