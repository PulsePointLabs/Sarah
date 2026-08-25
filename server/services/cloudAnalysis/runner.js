import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCloudAnalysisPreflight } from './preflight.js';
import { fuseCloudMultimodalEvidence } from './fusion.js';
import { persistCloudAnalysisResult } from './persistence.js';
import { getEntity, listEntitiesByExactCriteria } from '../../db.js';

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serviceDir, '..', '..', '..');
const workerPath = path.join(repoRoot, 'tools', 'cloud', 'sarah_modal_worker.py');
const resultDir = path.join(repoRoot, 'data', 'cloud-analysis', 'results');
const RESULT_PREFIX = 'SARAH_CLOUD_RESULT=';

function pythonCommand() {
  if (process.env.SARAH_CLOUD_PYTHON) {
    return { command: process.env.SARAH_CLOUD_PYTHON, prefix: [] };
  }
  return process.platform === 'win32'
    ? { command: 'py', prefix: ['-X', 'utf8'] }
    : { command: 'python3', prefix: ['-X', 'utf8'] };
}

function tail(value, max = 32_000) {
  const text = String(value || '');
  return text.length > max ? text.slice(-max) : text;
}

async function loadLaneResult(summary = {}) {
  const requested = path.resolve(String(summary.result_path || ''));
  const safeRoot = `${path.resolve(resultDir)}${path.sep}`.toLowerCase();
  if (!requested.toLowerCase().startsWith(safeRoot)) throw new Error('Cloud worker returned an unsafe result path.');
  return JSON.parse(await fsp.readFile(requested, 'utf8'));
}

function runModalLane(mode, inputPath, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const python = pythonCommand();
    const args = [
      ...python.prefix,
      '-m', 'modal', 'run', workerPath,
      '--mode', mode,
      '--input-path', inputPath,
      '--result-dir', resultDir,
    ];
    const child = spawn(python.command, args, {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    let summary = null;
    let cloudJobId = '';
    let settled = false;
    const abort = () => {
      if (child.exitCode == null) child.kill();
    };
    signal?.addEventListener?.('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout = tail(stdout + chunk.toString('utf8'));
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith('SARAH_CLOUD_JOB=')) cloudJobId = line.slice('SARAH_CLOUD_JOB='.length).trim();
        if (!line.startsWith(RESULT_PREFIX)) continue;
        try {
          summary = JSON.parse(line.slice(RESULT_PREFIX.length));
        } catch {
          // The exit handler reports a clean parsing error.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr + chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', abort);
      reject(new Error(`Could not start Modal cloud worker: ${error.message}`));
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', abort);
      if (signal?.aborted) {
        if (cloudJobId) await cleanupModalJob(cloudJobId).catch(() => {});
        return reject(new Error('Cloud analysis was cancelled and its encrypted upload was scrubbed.'));
      }
      if (code !== 0) {
        const detail = tail(stderr || stdout, 4000).replace(/\x1b\[[0-9;]*m/g, '').trim();
        return reject(new Error(`Modal ${mode} failed${detail ? `: ${detail}` : '.'}`));
      }
      if (!summary?.ok || !summary?.result_path) return reject(new Error(`Modal ${mode} completed without a readable result marker.`));
      try {
        onProgress?.({ lane: mode, summary });
        resolve({ summary, result: await loadLaneResult(summary) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function cleanupModalJob(jobId) {
  return new Promise((resolve, reject) => {
    const python = pythonCommand();
    const child = spawn(python.command, [
      ...python.prefix,
      '-m', 'modal', 'run', workerPath,
      '--mode', 'cleanup-job',
      '--job-id', jobId,
    ], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk.toString('utf8')); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not scrub cancelled Modal job: ${tail(stderr, 1200)}`));
    });
  });
}

export async function runCloudMultimodalAnalysis(payload = {}, { signal, onProgress } = {}) {
  const sessionId = String(payload.sessionId || '').trim();
  const recordType = payload.recordType === 'body_exploration' ? 'body_exploration' : 'session';
  const requestedVideoPath = String(payload.videoPath || '').trim();
  if (!sessionId) throw new Error('A saved Session or Body Exploration record is required.');
  if (!requestedVideoPath) throw new Error('A linked local video is required.');
  const videoPath = path.resolve(requestedVideoPath);

  const preflight = await prepareCloudAnalysisPreflight({ sessionId, recordType });
  const linked = preflight.localAssets.find((asset) => (
    path.resolve(String(asset.local_path || '')).toLowerCase() === videoPath.toLowerCase()
  ));
  if (!linked?.exists) throw new Error('The selected video is not an available linked video for this record.');
  await fsp.mkdir(resultDir, { recursive: true });
  const entity = recordType === 'body_exploration' ? 'BodyExploration' : 'Session';
  const record = getEntity(entity, sessionId) || {};
  const exactRows = (name) => listEntitiesByExactCriteria(name, { session: sessionId }) || [];
  const physiology = {
    heartRateRows: exactRows('HeartRateTimeline'),
    emgRows: exactRows('EMGTimeline'),
    howlCommands: exactRows('HowlControlCommand'),
    bloodPressureRows: Array.isArray(record.blood_pressure_readings) ? record.blood_pressure_readings : [],
    pulseOxRows: Array.isArray(record.pulse_ox_readings) ? record.pulse_ox_readings : [],
  };

  onProgress?.({
    phase: 'audio',
    current: 1,
    total: 4,
    message: 'Encrypting and analyzing the session audio on Modal...',
    privacy: { encryptedInTransit: true, cloudRetention: 'none_after_job' },
  });
  const audio = await runModalLane('audio-pilot', videoPath, { signal });

  onProgress?.({
    phase: 'visual',
    current: 2,
    total: 4,
    message: 'Building the encrypted visual proxy and running dense GPU analysis...',
    audioDurationSeconds: audio.summary.duration_seconds,
  });
  const visual = await runModalLane('visual-pilot', videoPath, { signal });

  onProgress?.({
    phase: 'fusion',
    current: 3,
    total: 4,
    message: 'Aligning audio, visual, pose, and available physiology evidence...',
    visualFrames: visual.summary.frame_metrics,
    semanticWindows: visual.summary.semantic_windows,
  });
  const fused = fuseCloudMultimodalEvidence({
    audioResult: audio.result,
    visualResult: visual.result,
    preflight,
    physiology,
  });
  const fusedPath = path.join(resultDir, `${fused.id}.json`);
  const sourceIndex = preflight.localAssets.findIndex((asset) => (
    path.resolve(String(asset.local_path || '')).toLowerCase() === videoPath.toLowerCase()
  ));
  const sourceVideo = preflight.cloudJob.source_media[sourceIndex] || {};
  const finalResult = {
    ...fused,
    saved_to_record: true,
    saved_at: new Date().toISOString(),
    result_files: {
      audio: path.basename(audio.summary.result_path),
      visual: path.basename(visual.summary.result_path),
      fused: path.basename(fusedPath),
    },
  };
  await fsp.writeFile(fusedPath, JSON.stringify(finalResult, null, 2), 'utf8');
  persistCloudAnalysisResult({ sessionId, recordType, result: finalResult, sourceVideo });

  onProgress?.({
    phase: 'complete',
    current: 4,
    total: 4,
    message: 'Cloud multimodal evidence is ready for review.',
  });
  return finalResult;
}
