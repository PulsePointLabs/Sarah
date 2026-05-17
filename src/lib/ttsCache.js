/**
 * Persistent TTS audio cache backed by IndexedDB.
 * Stores raw MP3 bytes (ArrayBuffer) keyed by voice+speed+text hash.
 * Falls back silently to no-op if IndexedDB is unavailable.
 */

const DB_NAME = "tts_audio_cache";
const STORE_NAME = "chunks";
const DB_VERSION = 2; // bumped to clear stale cache from speed-param era

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Drop old store on version upgrade (clears stale/corrupt cache entries)
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => { console.warn("TTS IndexedDB open failed"); resolve(null); };
  });
  return dbPromise;
}

async function cacheKey(text, voice, speed) {
  const raw = `${voice}|${speed}|${text}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Returns ArrayBuffer of MP3 bytes, or null if not cached. */
export async function idbGet(text, voice, speed) {
  try {
    const db = await openDB();
    if (!db) return null;
    const key = await cacheKey(text, voice, speed);
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Stores ArrayBuffer of MP3 bytes. Fire-and-forget safe. */
export async function idbSet(text, voice, speed, buffer) {
  try {
    const db = await openDB();
    if (!db) return;
    const key = await cacheKey(text, voice, speed);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(buffer, key);
      tx.oncomplete = resolve;
      tx.onerror = resolve; // don't reject — cache write failure is non-fatal
    });
  } catch {
    // non-fatal
  }
}