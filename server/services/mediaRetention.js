import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataDir, uploadDir } from '../config.js';
import { db } from '../db.js';
import { extractUploadReferences, isRetentionCandidate } from './mediaRetentionRules.js';

const manifestDir = path.join(dataDir, 'cleanup-manifests');
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 10 * 60 * 1000;
let retentionRunning = false;

function addReferences(target, value) {
  for (const filename of extractUploadReferences(value)) target.add(filename);
}

export function collectReferencedUploadFilenames() {
  const references = new Set();
  const rows = db.prepare(`
    SELECT data
    FROM entities
    WHERE entity NOT IN ('HeartRateTimeline', 'EMGTimeline', 'BloodPressureReading', 'PulseOxReading', 'HowlTelemetry')
      AND (instr(data, '/uploads/') > 0 OR instr(data, 'filename') > 0)
  `).iterate();
  for (const row of rows) addReferences(references, row.data);

  for (const row of db.prepare(`SELECT result_json FROM local_vision_results WHERE instr(result_json, '/uploads/') > 0`).iterate()) {
    addReferences(references, row.result_json);
  }
  for (const row of db.prepare(`SELECT source_url, classification_json FROM profile_anatomy_image_classifications`).iterate()) {
    addReferences(references, row.source_url);
    addReferences(references, row.classification_json);
  }
  return references;
}

async function walkFiles(directory) {
  const files = [];
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function summarizeCandidates(candidates) {
  const categories = {};
  let bytes = 0;
  for (const candidate of candidates) {
    bytes += candidate.bytes;
    const current = categories[candidate.category] || { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += candidate.bytes;
    categories[candidate.category] = current;
  }
  return { files: candidates.length, bytes, gigabytes: Number((bytes / 1024 ** 3).toFixed(3)), categories };
}

export async function buildMediaRetentionManifest({ now = Date.now() } = {}) {
  const references = collectReferencedUploadFilenames();
  const files = await walkFiles(uploadDir);
  const candidates = [];
  const preserved = { referenced: 0, non_cache: 0, recent: 0 };

  for (const filePath of files) {
    const relativePath = path.relative(uploadDir, filePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const referenced = references.has(path.basename(filePath).toLowerCase());
    const ageDays = Math.max(0, (now - stat.mtimeMs) / 86_400_000);
    const decision = isRetentionCandidate({ filename: filePath, referenced, ageDays });
    if (decision.eligible) {
      candidates.push({
        relative_path: relativePath,
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        age_days: Number(ageDays.toFixed(2)),
        category: decision.category,
        reason: decision.reason,
      });
    } else if (referenced) preserved.referenced += 1;
    else if (!decision.automatic) preserved.non_cache += 1;
    else preserved.recent += 1;
  }

  return {
    version: 1,
    generated_at: new Date(now).toISOString(),
    mode: 'dry_run',
    upload_dir: uploadDir,
    referenced_filename_count: references.size,
    scanned_file_count: files.length,
    preserved,
    candidate_summary: summarizeCandidates(candidates),
    candidates,
  };
}

async function writeManifest(manifest, suffix) {
  await fsp.mkdir(manifestDir, { recursive: true });
  const stamp = manifest.generated_at.replaceAll(':', '-').replaceAll('.', '-');
  const manifestPath = path.join(manifestDir, `media-retention-${stamp}-${suffix}.json`);
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

export async function runMediaRetention({ apply = false, source = 'manual' } = {}) {
  if (retentionRunning) return { skipped: true, reason: 'already_running' };
  retentionRunning = true;
  try {
    const manifest = await buildMediaRetentionManifest();
    const dryRunPath = await writeManifest({ ...manifest, source }, 'dry-run');
    if (!apply) return { manifest, manifestPath: dryRunPath };

    const deleted = [];
    const failures = [];
    const resolvedRoot = path.resolve(uploadDir);
    for (let offset = 0; offset < manifest.candidates.length; offset += 64) {
      const batch = manifest.candidates.slice(offset, offset + 64);
      await Promise.all(batch.map(async (candidate) => {
        const target = path.resolve(uploadDir, candidate.relative_path);
        if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
          failures.push({ ...candidate, error: 'path_guard_rejected' });
          return;
        }
        try {
          await fsp.unlink(target);
          deleted.push(candidate);
        } catch (error) {
          if (error?.code !== 'ENOENT') failures.push({ ...candidate, error: error?.message || String(error) });
        }
      }));
    }
    const applied = {
      ...manifest,
      mode: 'applied',
      source,
      dry_run_manifest: dryRunPath,
      deleted_summary: summarizeCandidates(deleted),
      failures,
    };
    const appliedPath = await writeManifest(applied, 'applied');
    return { manifest: applied, manifestPath: appliedPath };
  } finally {
    retentionRunning = false;
  }
}

export function startMediaRetentionScheduler() {
  if (process.env.SARAH_MEDIA_RETENTION_ENABLED === 'false') return;
  const execute = () => runMediaRetention({ apply: true, source: 'scheduled' })
    .then((result) => {
      const summary = result?.manifest?.deleted_summary;
      if (summary?.files) console.log(`Sarah media retention removed ${summary.files} expired cache files (${summary.gigabytes} GB).`);
    })
    .catch((error) => console.error(`Sarah media retention failed: ${error?.message || error}`));
  const initial = setTimeout(execute, Number(process.env.SARAH_MEDIA_RETENTION_INITIAL_DELAY_MS || DEFAULT_INITIAL_DELAY_MS));
  initial.unref?.();
  const interval = setInterval(execute, Number(process.env.SARAH_MEDIA_RETENTION_INTERVAL_MS || DEFAULT_INTERVAL_MS));
  interval.unref?.();
}
