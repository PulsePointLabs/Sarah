import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)

const PWA_FULL_SEND_V1 = true;
const PWA_NO_FOCUS_RELOAD_V1 = true;

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

  // PWA_NO_FOCUS_RELOAD_V1
  // Do not auto-reload on service-worker controller changes. Android/Chrome can
  // check for SW updates when the installed app regains focus, and an automatic
  // reload here can interrupt live capture, Motion Lab analysis, AI jobs, or TTS.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.dispatchEvent(new CustomEvent('pulsepoint:pwa-controller-changed'));
  });
}
