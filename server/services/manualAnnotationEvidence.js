import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { uploadDir } from '../config.js';

const worker = fileURLToPath(new URL('../../tools/cloud/manual_annotation_motion.py', import.meta.url));
const root = path.join(os.tmpdir(), 'sarah-manual-review');
const live = new Set();

export function runEvidenceProcess(command, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
    child.on('error', (error) => { signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Visual review cancelled.'));
      else if (code) reject(new Error(`Visual evidence processing failed: ${stderr}`));
      else resolve(stdout);
    });
  });
}

export async function withManualEvidenceWorkspace(task) {
  await fsp.mkdir(root, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(root, 'job-'));
  live.add(directory);
  try {
    await fsp.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }));
    return await task(directory);
  }
  finally {
    // Only a directory created by mkdtemp under our isolated root is removable.
    if (path.dirname(directory) !== root || !path.basename(directory).startsWith('job-')) throw new Error('Unsafe visual workspace cleanup path.');
    await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    live.delete(directory);
  }
}

// finally cannot execute after OS termination/power loss. Recover abandoned
// workspaces on server startup; never touch uploads or source video directories.
export async function cleanupAbandonedManualWorkspaces() {
  await fsp.mkdir(root, { recursive: true });
  for (const item of await fsp.readdir(root, { withFileTypes: true })) {
    const directory = path.join(root, item.name);
    if (!item.isDirectory() || !/^job-[\w-]+$/.test(item.name) || live.has(directory)) continue;
    let alive = false;
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(directory, 'owner.json'), 'utf8'));
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
      }
    } catch {
      // Allow a concurrent process time to write its ownership file.
      const stat = await fsp.stat(directory);
      alive = Date.now() - stat.mtimeMs < 60_000;
    }
    if (!alive) await fsp.rm(directory, { recursive: true, force: true });
  }
}

export async function probeAnnotationVideo(sourcePath, signal) {
  const probe = JSON.parse(await runEvidenceProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate:format=duration', '-of', 'json', sourcePath], signal));
  const stream = probe.streams?.[0] || {};
  const [n, d] = String(stream.avg_frame_rate || stream.r_frame_rate || '0/1').split('/').map(Number);
  if (!stream.width || !stream.height || !n || !d) throw new Error('Source video dimensions/frame rate could not be read.');
  return { width: stream.width, height: stream.height, fps: n / d, duration_s: Number(probe.format?.duration) };
}

async function imageDescriptor(directory, filename, time, extra = {}) {
  return { filename, frameTimeSeconds: time, mimeType: 'image/jpeg', data: (await fsp.readFile(path.join(directory, filename))).toString('base64'), ...extra };
}

export async function extractNativeAnnotationFrames({ sourcePath, timesSeconds, directory, signal, prefix = 'full' }) {
  const frames = [];
  for (const [index, time] of timesSeconds.entries()) {
    const filename = `${prefix}-${index}.jpg`;
    await runEvidenceProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(time), '-i', sourcePath, '-map', '0:v:0', '-frames:v', '1', '-q:v', '2', path.join(directory, filename)], signal);
    frames.push(await imageDescriptor(directory, filename, time, { context: 'full native frame' }));
  }
  return frames;
}

export const LOWER_BODY_LOCALIZATION_SCHEMA = {
  type: 'object', properties: { regions: { type: 'array', maxItems: 32, items: {
    type: 'object', properties: {
      region: { type: 'string', enum: ['pelvis', 'hip', 'thigh', 'knee', 'calf', 'ankle', 'heel', 'foot', 'forefoot', 'sole', 'toes'] },
      side: { type: 'string', enum: ['left', 'right', 'midline', 'unresolved'] },
      confidence: { type: 'string', enum: ['low', 'moderate', 'high'] },
      box: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
    }, required: ['region', 'side', 'confidence', 'box'],
  } } }, required: ['regions'],
};

export async function denseFeetEvidence({ sourcePath, start, end, mark, offset, directory, signal, invoke, source }) {
  const fps = Math.min(8, source.fps);
  const count = Math.floor((end - start) * fps + .00001) + 1;
  await runEvidenceProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(start), '-i', sourcePath,
    '-map', '0:v:0', '-an', '-vf', `fps=${fps}`, '-frames:v', String(count), '-q:v', '2', path.join(directory, 'dense-%03d.jpg')], signal);
  const files = (await fsp.readdir(directory)).filter((name) => /^dense-\d+\.jpg$/.test(name)).sort();
  if (files.length < Math.max(2, count - 1)) throw new Error('The full dense annotation window could not be decoded.');
  const descriptors = files.map((filename, i) => ({ filename, time_s: Number((start + i / fps + offset).toFixed(4)) }));
  const seeds = await Promise.all([0, Math.floor(files.length/2), files.length-1].map(i => imageDescriptor(directory, files[i], descriptors[i].time_s-offset)));
  const localized = await invoke({ model: 'claude_sonnet_4_6', max_tokens: 3000, max_images: 3, signal,
    response_json_schema: LOWER_BODY_LOCALIZATION_SCHEMA, images: seeds.map(f => ({ filename: f.filename, media_type: f.mimeType, data: f.data })),
    prompt: 'Localize the ACTUALLY VISIBLE lower body in the FIRST unmirrored full source frame. The other two frames provide orientation context only; all boxes must describe the FIRST frame. Return normalized x,y,width,height boxes for visible pelvis/hip, thigh, knee, calf, ankle, heel, whole foot and toes on each resolvable anatomical side. Include the whole lower body, not only toes. Do not assume both feet or all regions are visible. Never place a second foot box on equipment or background; omit occluded/off-screen regions. Determine anatomical left/right using body axis, connected limb orientation and medial big-toe position together; screen side alone is insufficient. Use side unresolved and low confidence when ambiguous, but retain resolvable sides. Boxes must tightly contain the named anatomy and fit inside [0,1]. This is geometry for tracking, not an interpretation of movement or an annotation. No genital or stimulation analysis.' });
  await fsp.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ frames: descriptors, regions: localized.regions || [] }));
  const command = process.env.SARAH_CLOUD_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  await runEvidenceProcess(command, ['-X', 'utf8', worker, path.join(directory, 'manifest.json')], signal);
  const motion = JSON.parse(await fsp.readFile(path.join(directory, 'motion.json'), 'utf8'));
  motion.sample_fps = fps;
  motion.source_fps = source.fps;
  // Full context throughout plus adjacent samples around the largest short
  // movements. Semantic selection never replaces the dense CV time series.
  const selected = new Set([0, files.length - 1, Math.round((mark - start) * fps)]);
  for (let i = 0; i < files.length; i += Math.max(1, Math.round(fps))) selected.add(i);
  const peaks = [...motion.frame_metrics].sort((a, b) => Math.max(...b.tiles.map(t => t.p90_px)) - Math.max(...a.tiles.map(t => t.p90_px)));
  let picked = 0;
  for (const peak of peaks) {
    const i = motion.frame_times_s.indexOf(peak.time_s);
    if (i < 0 || [i-1, i, i+1].every(n => selected.has(n))) continue;
    for (const n of [i-1, i, i+1]) if (n >= 0 && n < files.length) selected.add(n);
    if (++picked >= (Math.max(source.width, source.height) > 2000 ? 1 : 4)) break;
  }
  const frames = await Promise.all([...selected].filter(i => i >= 0 && i < files.length).sort((a,b) => a-b).map(i => imageDescriptor(directory, files[i], descriptors[i].time_s-offset, { context: 'full native frame' })));
  const detailRegions = motion.tracks.filter(r => ['foot', 'toes'].includes(r.region))
    .sort((a,b) => (a.region === 'foot' ? 0 : 1)-(b.region === 'foot' ? 0 : 1))
    .slice(0, Math.max(source.width, source.height) > 2000 ? 2 : 4);
  const crops = [];
  for (const region of detailRegions) {
    const samples = region.samples.filter(s => s.tracking === 'tracked').sort((a,b) => b.motion_p90_px-a.motion_p90_px);
    if (!samples.length) continue;
    const peak = samples[0];
    const i = motion.frame_times_s.indexOf(peak.time_s);
    if (Math.max(source.width, source.height) > 2000 && frames.length+crops.length+3 > 20) break;
    for (const n of [Math.max(0, i-1), i, Math.min(files.length-1, i+1)]) {
      const box = region.samples.find(s => s.time_s === descriptors[n].time_s)?.box || peak.box;
      crops.push(await nativeCrop(directory, files[n], descriptors[n].time_s-offset, box, source, `${region.side} ${region.region}; tracking/localization confidence ${region.confidence}`, crops.length, signal));
    }
  }
  return { frames, crops, motion };
}

async function nativeCrop(directory, filename, time, box, source, label, index, signal) {
  const x = Math.max(0, Math.floor(box[0]*source.width)), y = Math.max(0, Math.floor(box[1]*source.height));
  const w = Math.min(source.width-x, Math.max(2, Math.floor(box[2]*source.width))), h = Math.min(source.height-y, Math.max(2, Math.floor(box[3]*source.height)));
  const name = `crop-${index}.jpg`;
  await runEvidenceProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', path.join(directory, filename), '-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-q:v', '2', path.join(directory, name)], signal);
  return imageDescriptor(directory, name, time, { context: `native detail supplement: ${label}`, box });
}

export async function mainDetailCrops(frames, directory, source, signal, mark) {
  if (source.width <= 1920 && source.height <= 1920) return [];
  const crops = [];
  // Overlapping tiles cover ALL regions, without guessing an anatomical crop.
  // They are cut from native frames, never from a reduced semantic preview.
  const marked = Number.isFinite(mark) ? frames.reduce((best,f) => Math.abs(f.frameTimeSeconds-mark) < Math.abs(best.frameTimeSeconds-mark) ? f : best, frames[0]) : frames[Math.floor(frames.length/2)];
  for (const frame of [marked]) {
    for (const y of [0, 1/3, 2/3]) for (const x of [0, 1/3, 2/3]) {
      crops.push(await nativeCrop(directory, frame.filename, frame.frameTimeSeconds, [x,y,1/3,1/3], source, `full-frame tile x=${x}, y=${y}`, crops.length, signal));
    }
  }
  return crops;
}

export async function retainAnnotationEvidence(frames, directory, identity) {
  const retained = [];
  try {
  for (const [index, frame] of frames.entries()) {
    const filename = `annotation-evidence-${identity}-${index}.jpg`;
    await fsp.copyFile(path.join(directory, frame.filename), path.join(uploadDir, filename));
    retained.push({ url: `/uploads/${filename}`, filename, frameTimeSeconds: frame.frameTimeSeconds, recordTimeSeconds: frame.recordTimeSeconds, purpose: frame.purpose });
  }
  return retained;
  } catch (error) {
    await removeUnpersistedAnnotationEvidence(retained);
    throw error;
  }
}

export async function removeUnpersistedAnnotationEvidence(frames) {
  for (const frame of frames) if (/^annotation-evidence-[\w-]+\.jpg$/.test(frame.filename)) await fsp.rm(path.join(uploadDir, frame.filename), { force: true });
}

export async function retainedEvidenceAvailable(frames = []) {
  if (!frames.length || !frames.some(f => f.purpose === 'annotation_mark')) return false;
  for (const frame of frames) {
    if (!/^annotation-evidence-[\w-]+\.jpg$/.test(frame.filename)) return false;
    try { await fsp.access(path.join(uploadDir, frame.filename)); } catch { return false; }
  }
  return true;
}
