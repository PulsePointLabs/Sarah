function escapeSvgText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function videoPosterDataUrl({ title = "Sarah video", subtitle = "Tap to play", timestamp = "" } = {}) {
  const safeTitle = escapeSvgText(title).slice(0, 80);
  const safeSubtitle = escapeSvgText(subtitle).slice(0, 110);
  const safeTimestamp = escapeSvgText(timestamp).slice(0, 64);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#f7fbfb"/>
      <stop offset="0.48" stop-color="#f4eff9"/>
      <stop offset="1" stop-color="#eef8f6"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" x2="1">
      <stop offset="0" stop-color="#18b8a6"/>
      <stop offset="1" stop-color="#a24ad6"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#3d2850" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="1280" height="720" rx="42" fill="url(#bg)"/>
  <rect x="70" y="62" width="1140" height="596" rx="34" fill="#ffffff" fill-opacity="0.64" stroke="#d9cfdf"/>
  <circle cx="640" cy="340" r="92" fill="url(#mark)" filter="url(#shadow)" opacity="0.96"/>
  <path d="M612 289v102c0 13 14 21 25 14l78-51c10-7 10-21 0-28l-78-51c-11-7-25 1-25 14z" fill="#fff"/>
  <text x="640" y="500" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="46" font-weight="800" fill="#201b25">${safeTitle}</text>
  <text x="640" y="552" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="25" font-weight="600" fill="#6f6375">${safeSubtitle}</text>
  ${safeTimestamp ? `<text x="640" y="596" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="#2a9f93">${safeTimestamp}</text>` : ""}
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
