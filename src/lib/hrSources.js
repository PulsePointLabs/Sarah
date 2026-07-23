export const HR_SOURCE_OPTIONS = [
  {
    value: "heartrateonstream",
    label: "HeartRateOnStream",
    helper: "Existing OBS relay workflow",
  },
  {
    value: "pulsoid",
    label: "Pulsoid / Polar H10",
    helper: "Polar H10 through Pulsoid",
  },
  {
    value: "direct_h10",
    label: "Direct Polar H10",
    helper: "Local Web Bluetooth HR + RR intervals",
  },
];

export const PULSOID_MODE_OPTIONS = [
  { value: "websocket", label: "WebSocket" },
  { value: "http", label: "HTTP latest" },
];

const DIRECT_H10_SOURCE_MIGRATION_KEY = "pulsepoint.hrSource.directH10DefaultV1";

export function maskPulsoidToken(token = "") {
  const value = String(token || "").trim();
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function readHrSourceSettings() {
  let source = localStorage.getItem("pulsepoint.hrSource");
  if (!localStorage.getItem(DIRECT_H10_SOURCE_MIGRATION_KEY)) {
    localStorage.setItem(DIRECT_H10_SOURCE_MIGRATION_KEY, "1");
    if (!source || source === "heartrateonstream") {
      source = "direct_h10";
      localStorage.setItem("pulsepoint.hrSource", source);
    }
  }
  return {
    source: source || "direct_h10",
    pulsoidToken: localStorage.getItem("pulsepoint.pulsoid.accessToken") || "",
    pulsoidMode: localStorage.getItem("pulsepoint.pulsoid.mode") || "websocket",
  };
}

export function writeHrSourceSettings(settings) {
  if (settings.source) localStorage.setItem("pulsepoint.hrSource", settings.source);
  if (settings.pulsoidToken != null) localStorage.setItem("pulsepoint.pulsoid.accessToken", settings.pulsoidToken);
  if (settings.pulsoidMode) localStorage.setItem("pulsepoint.pulsoid.mode", settings.pulsoidMode);
}

export function cleanRrIntervals(values) {
  const list = Array.isArray(values) ? values : [];
  return list
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 300 && value <= 2000);
}

export function computeHrvFromRr(rrIntervalsMs, { windowSeconds = 90 } = {}) {
  const rr = cleanRrIntervals(rrIntervalsMs);
  if (rr.length < 20) {
    return {
      sampleCount: rr.length,
      windowSeconds,
      quality: rr.length ? "low" : "unavailable",
    };
  }
  const mean = rr.reduce((sum, value) => sum + value, 0) / rr.length;
  const sdnnMs = Math.sqrt(rr.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / rr.length);
  const successiveDiffs = rr.slice(1).map((value, index) => value - rr[index]);
  const rmssdMs = Math.sqrt(successiveDiffs.reduce((sum, diff) => sum + (diff ** 2), 0) / successiveDiffs.length);
  const pnn50 = successiveDiffs.filter((diff) => Math.abs(diff) > 50).length / successiveDiffs.length;
  const quality = rr.length >= 80 ? "high" : rr.length >= 40 ? "moderate" : "low";
  return {
    rmssdMs: Number(rmssdMs.toFixed(1)),
    sdnnMs: Number(sdnnMs.toFixed(1)),
    pnn50: Number(pnn50.toFixed(3)),
    sampleCount: rr.length,
    windowSeconds,
    quality,
  };
}
