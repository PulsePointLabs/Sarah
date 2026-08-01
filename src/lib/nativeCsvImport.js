import { registerPlugin } from "@capacitor/core";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

const SarahIncomingCsv = registerPlugin("SarahIncomingCsv");

export function isNativeCsvImportSupported() {
  return isSarahNativeShell();
}

export async function consumePendingNativeCsv() {
  if (!isNativeCsvImportSupported()) return { pending: false };
  return SarahIncomingCsv.consumePending();
}

export async function listenForNativeCsv(callback) {
  if (!isNativeCsvImportSupported()) return { remove: async () => {} };
  return SarahIncomingCsv.addListener("incomingCsvAvailable", callback);
}

export function base64ToBytes(value = "") {
  const binary = window.atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
