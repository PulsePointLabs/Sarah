import { registerPlugin } from "@capacitor/core";
import { getSarahApiBaseCandidates, isSarahNativeShell } from "@/lib/mobileApiBase";

const SarahFileSaver = registerPlugin("SarahFileSaver");

function guessMimeType(filename = "", fallback = "") {
  if (fallback) return fallback;
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

export async function saveUrlWithSystemPicker(url, filename, options = {}) {
  if (!isSarahNativeShell()) return null;
  if (!url || !/^https?:\/\//i.test(String(url))) return null;
  return SarahFileSaver.saveFromUrl({
    url,
    alternateUrls: buildAlternateDownloadUrls(url),
    filename: filename || "sarah-media-download",
    mimeType: guessMimeType(filename, options.mimeType),
  });
}

export async function downloadOrSaveUrl(url, filename, options = {}) {
  if (!url) return null;
  if (isSarahNativeShell()) {
    return saveUrlWithSystemPicker(url, filename, options);
  }
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { ok: true, browserDownload: true };
}

function buildAlternateDownloadUrls(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname || ""}${parsed.search || ""}`;
    if (!path.startsWith("/uploads/")) return [];
    const urls = [];
    const seen = new Set([url]);
    for (const base of getSarahApiBaseCandidates()) {
      if (!/^https?:\/\//i.test(base)) continue;
      const origin = base.replace(/\/api\/?$/i, "");
      const alternate = `${origin}${path}`;
      if (!seen.has(alternate)) {
        seen.add(alternate);
        urls.push(alternate);
      }
    }
    return urls;
  } catch {
    return [];
  }
}
