import { registerPlugin } from "@capacitor/core";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

const SarahFileSaver = registerPlugin("SarahFileSaver");
const DOWNLOAD_STATUS_POLL_MS = 500;
const DOWNLOAD_STATUS_MAX_POLLS = 8;

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

export async function saveUrlWithSystemDownloader(url, filename, options = {}) {
  if (!isSarahNativeShell()) return null;
  if (!url || !/^https?:\/\//i.test(String(url))) return null;
  const payload = {
    url,
    filename: filename || "sarah-media-download",
    mimeType: guessMimeType(filename, options.mimeType),
  };
  try {
    const result = await SarahFileSaver.saveFromUrl(payload);
    if (!result?.downloadId) return result;
    const downloadStatus = await waitForDownloadStatus(result.downloadId);
    if (downloadStatus?.status === "failed") {
      const fallback = await SarahFileSaver.openUrl(payload);
      return {
        ...fallback,
        filename: payload.filename,
        systemDownload: false,
        openedExternally: true,
        downloadStatus,
        nativeDownloadError: `Android DownloadManager failed: ${downloadStatus.reasonLabel || downloadStatus.reason || "unknown"}`,
      };
    }
    return { ...result, downloadStatus };
  } catch (error) {
    const fallback = await SarahFileSaver.openUrl(payload);
    return {
      ...fallback,
      filename: payload.filename,
      systemDownload: false,
      openedExternally: true,
      nativeDownloadError: error?.message || "Android DownloadManager did not accept this download.",
    };
  }
}

export async function downloadOrSaveUrl(url, filename, options = {}) {
  if (!url) return null;
  if (isSarahNativeShell()) {
    return saveUrlWithSystemDownloader(url, filename, options);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDownloadStatus(downloadId) {
  let latest = null;
  for (let i = 0; i < DOWNLOAD_STATUS_MAX_POLLS; i += 1) {
    await delay(DOWNLOAD_STATUS_POLL_MS);
    try {
      latest = await SarahFileSaver.getDownloadStatus({ downloadId });
    } catch (error) {
      return {
        ok: false,
        status: "unknown",
        message: error?.message || "Could not read Android download status.",
      };
    }
    if (!latest?.ok) return latest;
    if (latest.status === "failed" || latest.status === "successful") return latest;
    if (latest.status === "running" && Number(latest.bytesDownloaded || 0) > 0) return latest;
  }
  return latest;
}
