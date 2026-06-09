import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)

const PWA_FULL_SEND_V1 = true;
const PWA_NO_FOCUS_RELOAD_V1 = true;
const PWA_FOREGROUND_STABILITY_V1 = true;
const PWA_KEEP_WORKER_REGISTERED_V1 = true;
const PWA_DISABLE_SW_IN_DEV_V1 = true;

function isStandalonePwa() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true;
}

if (import.meta.env.DEV) {
  window.addEventListener('load', () => {
    if (isStandalonePwa()) return;
    // Dev/Tailscale builds must not keep an old installed-app shell around.
    // Do this outside the secure-context gate so plain HTTP LAN/Tailscale
    // sessions can still clear Cache Storage even when SW APIs are unavailable.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations?.()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch((error) => {
          console.warn('Service worker cleanup failed:', error);
        });
    }
    window.caches?.keys?.()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('pulsepoint-shell-'))
        .map((key) => window.caches.delete(key))))
      .catch((error) => {
        console.warn('PulsePoint shell cache cleanup failed:', error);
      });
  });
} else if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });

  // PWA_NO_FOCUS_RELOAD_V1
  // Do not auto-reload or prompt for service-worker swaps while PulsePoint is
  // open. Android/Chrome can check for SW updates when the installed app
  // regains focus, and foreground update bookkeeping can interrupt live capture,
  // Motion Lab analysis, AI jobs, or TTS.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.dispatchEvent(new CustomEvent('pulsepoint:pwa-controller-changed'));
  });
}
