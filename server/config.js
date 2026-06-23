import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..');
export const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');
export const mediaOutputRoot = process.env.SARAH_MEDIA_ROOT
  ? path.resolve(rootDir, process.env.SARAH_MEDIA_ROOT)
  : '';
export const defaultUploadDir = path.resolve(rootDir, process.env.LEGACY_UPLOAD_DIR || path.join(dataDir, 'uploads'));
export const uploadDir = path.resolve(rootDir, process.env.UPLOAD_DIR || (mediaOutputRoot ? path.join(mediaOutputRoot, 'uploads') : path.join(dataDir, 'uploads')));
export const ttsRenderDir = path.resolve(rootDir, process.env.TTS_RENDER_DIR || (mediaOutputRoot ? path.join(mediaOutputRoot, 'tts-render-work') : './data/tts-render-work'));
export const liveCueAudioDir = path.resolve(rootDir, process.env.LIVE_CUE_AUDIO_DIR || (mediaOutputRoot ? path.join(mediaOutputRoot, 'live-cue-audio') : './data/live-cue-audio'));
export const databasePath = path.resolve(rootDir, process.env.DATABASE_PATH || './data/pulsepoint.sqlite');

export const uploadDirs = [...new Set([
  uploadDir,
  defaultUploadDir,
].map((dir) => path.resolve(dir)))];

export function resolveUploadPath(filename = '') {
  const rawName = String(filename || '').trim().replace(/^\/+/, '');
  const safeName = path.normalize(rawName).replace(/^(\.\.[/\\])+/, '');
  if (!safeName || path.isAbsolute(safeName) || safeName === '..' || safeName.startsWith(`..${path.sep}`)) return '';
  for (const dir of uploadDirs) {
    const candidate = path.join(dir, safeName);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Continue through fallback upload directories.
    }
  }
  return path.join(uploadDir, safeName);
}

const desktopRoot = path.resolve(rootDir, '..');
const hrRelayPort = Number(process.env.HR_CAPTURE_RELAY_PORT || 8765);

export const liveCaptureConfig = {
  hrWsUrl: process.env.HR_CAPTURE_WS_URL || `ws://127.0.0.1:${hrRelayPort}`,
  hrRelayEnabled: process.env.HR_CAPTURE_RELAY_ENABLED !== 'false',
  hrRelayPort,
  hrObsWsUrl: process.env.OBS_WS_URL || 'ws://127.0.0.1:4455',
  hrObsPassword: process.env.OBS_PASSWORD || '',
  hrRecordingsDir: path.resolve(process.env.HR_RECORDINGS_DIR || path.join(desktopRoot, 'HeartRate', 'recordings')),
  emgTextDir: path.resolve(process.env.EMG_TEXT_DIR || path.join(desktopRoot, 'EMG')),
  emgSessionsDir: path.resolve(process.env.EMG_SESSIONS_DIR || path.join(desktopRoot, 'EMG', 'emg_sessions')),
  emgPollMs: Number(process.env.EMG_POLL_MS || 250),
};
