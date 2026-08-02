import { Capacitor, registerPlugin } from "@capacitor/core";

const SharedVitalImport = registerPlugin("SharedVitalImport");
let pendingImport = null;

function bytesFromBase64(value = "") {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function consume(onImport) {
  const result = await SharedVitalImport.consumePendingImport();
  if (!result?.pending || !result.base64) return false;
  pendingImport = {
    name: result.name || "shared-vitals.csv",
    mimeType: result.mimeType || "application/octet-stream",
    size: Number(result.size || 0),
    bytes: bytesFromBase64(result.base64),
  };
  onImport?.(pendingImport);
  return true;
}

export function takePendingSharedVitalImport() {
  const value = pendingImport;
  pendingImport = null;
  return value;
}

export async function startSharedVitalImportBridge(onImport) {
  if (!Capacitor.isNativePlatform()) return () => {};
  const listener = await SharedVitalImport.addListener("sharedVitalImportReceived", () => {
    consume(onImport).catch(() => {});
  });
  await consume(onImport).catch(() => {});
  return () => listener?.remove?.();
}
