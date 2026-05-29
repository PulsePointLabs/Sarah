from pathlib import Path
import json

manifest_path = Path("public/manifest.json")
index_path = Path("index.html")
sw_path = Path("public/sw.js")
main_path = Path("src/main.jsx")

missing = [str(path) for path in [manifest_path, index_path, sw_path, main_path] if not path.exists()]
if missing:
    raise SystemExit("Run this from the PulsePoint-Standalone repo root. Missing: " + ", ".join(missing))

manifest_text = manifest_path.read_text(encoding="utf-8")
index_text = index_path.read_text(encoding="utf-8")
sw_text = sw_path.read_text(encoding="utf-8")
main_text = main_path.read_text(encoding="utf-8")

if "PWA_FULL_SEND_V1" in manifest_text or "PWA_FULL_SEND_V1" in sw_text or "PWA_FULL_SEND_V1" in main_text:
    print("PulsePoint PWA full-send v1 already appears to be applied. No changes made.")
    raise SystemExit(0)

for path, text in [(manifest_path, manifest_text), (index_path, index_text), (sw_path, sw_text), (main_path, main_text)]:
    backup = path.with_suffix(path.suffix + ".bak-pwa-full-send-v1")
    backup.write_text(text, encoding="utf-8")

manifest = json.loads(manifest_text)
manifest.update({
    "name": "PulsePoint Standalone",
    "short_name": "PulsePoint",
    "description": "Private local physiology, session review, Motion Lab, AI analysis, and audio summaries.",
    "id": "/?source=pwa",
    "start_url": "/?source=pwa",
    "scope": "/",
    "display": "standalone",
    "display_override": ["window-controls-overlay", "standalone", "minimal-ui"],
    "orientation": "any",
    "background_color": "#090d14",
    "theme_color": "#10161f",
    "categories": ["health", "lifestyle", "productivity", "utilities"],
    "prefer_related_applications": False,
    "edge_side_panel": { "preferred_width": 420 },
    "launch_handler": { "client_mode": ["navigate-existing", "auto"] },
    "shortcuts": [
        {
            "name": "New Session",
            "short_name": "New",
            "description": "Create a new PulsePoint session.",
            "url": "/new?source=pwa-shortcut",
            "icons": [{ "src": "/icons/pulsepoint-192.png", "sizes": "192x192", "type": "image/png" }],
        },
        {
            "name": "Live Capture",
            "short_name": "Capture",
            "description": "Open live physiology capture.",
            "url": "/capture?source=pwa-shortcut",
            "icons": [{ "src": "/icons/pulsepoint-192.png", "sizes": "192x192", "type": "image/png" }],
        },
        {
            "name": "Motion Lab",
            "short_name": "Motion",
            "description": "Open Motion Lab for local movement evidence review.",
            "url": "/motion-lab?source=pwa-shortcut",
            "icons": [{ "src": "/icons/pulsepoint-192.png", "sizes": "192x192", "type": "image/png" }],
        },
        {
            "name": "Body Exploration",
            "short_name": "Explore",
            "description": "Open body exploration sessions.",
            "url": "/exploration?source=pwa-shortcut",
            "icons": [{ "src": "/icons/pulsepoint-192.png", "sizes": "192x192", "type": "image/png" }],
        },
        {
            "name": "Audio Library",
            "short_name": "Audio",
            "description": "Open generated audio summaries and exports.",
            "url": "/library?source=pwa-shortcut",
            "icons": [{ "src": "/icons/pulsepoint-192.png", "sizes": "192x192", "type": "image/png" }],
        },
    ],
})

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

if '<meta name="application-name" content="PulsePoint" />' not in index_text:
    index_text = index_text.replace(
        '    <meta name="theme-color" content="#10161f" />\n',
        '    <meta name="theme-color" content="#10161f" />\n'
        '    <meta name="application-name" content="PulsePoint" />\n'
        '    <meta name="description" content="Private local physiology, session review, Motion Lab, AI analysis, and audio summaries." />\n'
        '    <meta name="color-scheme" content="dark light" />\n',
        1,
    )

if '<meta name="msapplication-TileColor" content="#10161f" />' not in index_text:
    index_text = index_text.replace(
        '    <link rel="manifest" href="/manifest.json" />\n',
        '    <link rel="manifest" href="/manifest.json" />\n'
        '    <meta name="msapplication-TileColor" content="#10161f" />\n'
        '    <meta name="msapplication-config" content="/browserconfig.xml" />\n',
        1,
    )

index_path.write_text(index_text, encoding="utf-8")

main_new = '''import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)

const PWA_FULL_SEND_V1 = true;

function isLocalDevHost() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

async function clearPulsePointShellCaches() {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith('pulsepoint-shell-'))
      .map((key) => caches.delete(key))
  );
}

if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => registration.unregister());
  });
  clearPulsePointShellCaches();
} else if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent('pulsepoint:pwa-update-ready'));
          }
        });
      });
    }).catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
'''
main_path.write_text(main_new, encoding="utf-8")

sw_new = '''// PWA_FULL_SEND_V1
const CACHE_NAME = "pulsepoint-shell-v3";
const SHELL_ASSETS = [
  "/",
  "/manifest.json",
  "/icons/pulsepoint-icon.svg",
  "/icons/pulsepoint-192.png",
  "/icons/pulsepoint-512.png",
  "/icons/pulsepoint-maskable-512.png"
];

function isSensitiveOrDynamicRequest(url) {
  return (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/uploads") ||
    url.pathname.startsWith("/data") ||
    url.pathname.includes("/tts") ||
    url.pathname.includes("/audio") ||
    url.pathname.match(/\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|csv|sqlite|db)$/i)
  );
}

function isDevelopmentAsset(url) {
  return (
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/@vite/") ||
    url.pathname.startsWith("/@react-refresh") ||
    url.pathname.startsWith("/node_modules/.vite/")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("pulsepoint-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "PULSEPOINT_SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isSensitiveOrDynamicRequest(url) || isDevelopmentAsset(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/") || Response.error())
    );
    return;
  }

  const isShellAsset = SHELL_ASSETS.includes(url.pathname) || url.pathname.startsWith("/icons/");
  if (isShellAsset) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  event.respondWith(fetch(request));
});

self.addEventListener("notificationclick", (event) => {
  const route = event.notification?.data?.route || "/";
  event.notification?.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const existingClient = clients[0];
      if (existingClient) {
        await existingClient.focus();
        if ("navigate" in existingClient) return existingClient.navigate(route);
        return existingClient;
      }
      return self.clients.openWindow ? self.clients.openWindow(route) : null;
    })
  );
});
'''
sw_path.write_text(sw_new, encoding="utf-8")

browserconfig = Path("public/browserconfig.xml")
if not browserconfig.exists():
    browserconfig.write_text('''<?xml version="1.0" encoding="utf-8"?>
<browserconfig>
  <msapplication>
    <tile>
      <square150x150logo src="/icons/pulsepoint-192.png"/>
      <TileColor>#10161f</TileColor>
    </tile>
  </msapplication>
</browserconfig>
''', encoding="utf-8")

print("Applied PulsePoint PWA full-send v1.")
print("Changed:")
print("- public/manifest.json shortcuts and install metadata")
print("- public/sw.js conservative app-shell service worker v3")
print("- src/main.jsx production SW registration/update handling")
print("- index.html app metadata")
print("- public/browserconfig.xml Windows tile metadata")
print("Backups written beside changed files with .bak-pwa-full-send-v1 suffix")
