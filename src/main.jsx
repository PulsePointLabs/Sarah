import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { installPwaLifecycleDiagnostics, recordPwaLifecycleEvent } from '@/lib/pwaLifecycleDiagnostics'

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)

installPwaLifecycleDiagnostics();

const PWA_FULL_SEND_V1 = true;
const PWA_NO_FOCUS_RELOAD_V1 = true;
const PWA_FOREGROUND_STABILITY_V1 = true;
const PWA_KEEP_WORKER_REGISTERED_V1 = true;
const PWA_DISABLE_SW_IN_DEV_V1 = true;
const PWA_REGISTER_FIXED_WORKER_IN_STANDALONE_DEV_V1 = true;
const PWA_ENABLE_DEV_NOTIFICATION_WORKER_V1 = true;

const SARAH_CACHE_PREFIXES = ['pulsepoint-shell-', 'workbox-', 'vite-'];

function registerStableServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      recordPwaLifecycleEvent('service_worker_registered', {
        installing: Boolean(registration.installing),
        waiting: Boolean(registration.waiting),
        active: Boolean(registration.active),
      });
      registration.addEventListener?.('updatefound', () => {
        recordPwaLifecycleEvent('service_worker_update_found');
        window.dispatchEvent(new CustomEvent('sarah:pwa-update-available'));
      });
      if (registration.waiting) {
        window.dispatchEvent(new CustomEvent('sarah:pwa-update-available'));
      }
    }).catch((error) => {
      console.warn('Service worker registration failed:', error);
      recordPwaLifecycleEvent('service_worker_registration_failed', { message: error?.message || String(error) });
    });
  };
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

async function cleanupSarahShell() {
  const tasks = [];
  if ('serviceWorker' in navigator && !PWA_ENABLE_DEV_NOTIFICATION_WORKER_V1) {
    tasks.push(
      navigator.serviceWorker.getRegistrations?.()
        .then((registrations = []) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch((error) => {
          console.warn('Service worker cleanup failed:', error);
        })
    );
  }

  if (window.caches?.keys) {
    tasks.push(
      window.caches.keys()
        .then((keys = []) => Promise.all(keys
          .filter((key) => SARAH_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
          .map((key) => window.caches.delete(key))))
        .catch((error) => {
          console.warn('Sarah shell cache cleanup failed:', error);
        })
    );
  }

  await Promise.all(tasks);
}

if (typeof window !== 'undefined') {
  window.sarahCleanupPwaShell = cleanupSarahShell;
  window.pulsepointCleanupPwaShell = cleanupSarahShell;
}

if (import.meta.env.DEV) {
  window.addEventListener('load', () => {
    cleanupSarahShell().finally(registerStableServiceWorker);
  });
} else {
  registerStableServiceWorker();
}

if ('serviceWorker' in navigator) {
  // PWA_NO_FOCUS_RELOAD_V1
  // Do not auto-reload or prompt for service-worker swaps while Sarah is
  // open. Android/Chrome can check for SW updates when the installed app
  // regains focus, and foreground update bookkeeping can interrupt live capture,
  // Motion Lab analysis, AI jobs, or TTS.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    recordPwaLifecycleEvent('controllerchange_no_reload');
    window.dispatchEvent(new CustomEvent('pulsepoint:pwa-controller-changed'));
  });
}
