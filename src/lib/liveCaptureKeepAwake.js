import { registerPlugin } from "@capacitor/core";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

const SarahKeepAwake = registerPlugin("SarahKeepAwake");

export async function setLiveCaptureKeepAwake(enabled) {
  if (!isSarahNativeShell()) return { enabled: false, native: false };
  return SarahKeepAwake.set({ enabled: Boolean(enabled) });
}
