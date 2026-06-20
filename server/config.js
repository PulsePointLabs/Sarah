import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..');
export const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');
export const uploadDir = path.resolve(rootDir, process.env.UPLOAD_DIR || './data/uploads');
export const ttsRenderDir = path.resolve(rootDir, process.env.TTS_RENDER_DIR || './data/tts-render-work');
export const liveCueAudioDir = path.resolve(rootDir, process.env.LIVE_CUE_AUDIO_DIR || './data/live-cue-audio');
export const databasePath = path.resolve(rootDir, process.env.DATABASE_PATH || './data/pulsepoint.sqlite');

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
