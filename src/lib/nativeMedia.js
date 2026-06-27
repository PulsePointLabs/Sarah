import { Capacitor, registerPlugin } from "@capacitor/core";

const SarahMedia = registerPlugin("SarahMedia");

export function isNativeMediaPlayerAvailable() {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

export async function openNativeMedia({ url, title, mimeType, positionSeconds = 0, headers = {} } = {}) {
  if (!isNativeMediaPlayerAvailable()) return { ok: false, nativePlayer: false };
  const cleanUrl = String(url || "").trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error("This media source is local to the page and cannot be handed to Android playback.");
  }
  return SarahMedia.open({
    url: cleanUrl,
    title: String(title || "Sarah media").trim() || "Sarah media",
    mimeType: String(mimeType || "video/mp4").trim() || "video/mp4",
    positionMs: Math.max(0, Math.round(Number(positionSeconds || 0) * 1000)),
    headers,
  });
}

export async function handOffVideoPlayToAndroid(event, options = {}) {
  if (!isNativeMediaPlayerAvailable()) return false;
  const video = event?.currentTarget;
  const url = String(options.url || video?.currentSrc || video?.src || "").trim();
  if (!/^https?:\/\//i.test(url)) return false;
  video?.pause?.();
  await openNativeMedia({
    url,
    title: options.title || "Sarah video",
    mimeType: options.mimeType || "video/mp4",
    positionSeconds: video?.currentTime || 0,
    headers: options.headers || {},
  });
  return true;
}
