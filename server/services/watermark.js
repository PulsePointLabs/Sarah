import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './ttsCore.js';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const WATERMARK_VIDEO_THREADS = Math.max(1, Math.min(16, Number(process.env.WATERMARK_VIDEO_THREADS || 4)));

export const WATERMARK_PRESETS = {
  public_export: 'Public Export',
  private_archive: 'Private Archive',
  preview: 'Preview',
};

export const DEFAULT_WATERMARK_SETTINGS = {
  preset: 'public_export',
  enabled: true,
  primaryText: 'Clinical Climax',
  secondaryText: 'Powered by Sarah',
  handleText: '',
  opacity: 0.62,
  textSize: 34,
  logoSize: 76,
  portraitEnabled: true,
  logoEnabled: true,
  portraitPath: 'brand/sarah-lab.jpg',
  logoPath: 'icons/sarah-192.png',
  paddingPercent: 4,
  positionMode: 'top_right',
  movementIntervalSeconds: 24,
  movementTransitionSeconds: 0.7,
  shadowEnabled: true,
  backgroundPlateEnabled: false,
  subtleCenterEnabled: false,
  metadataScrubEnabled: true,
};

const POSITION_SEQUENCE = ['top_left', 'bottom_left', 'top_right', 'bottom_right'];
const POSITION_SET = new Set([
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
  'fixed_custom',
  'rotating_corners',
  'intelligent_safe_area',
]);

function clamp(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function normalizeWatermarkSettings(input = {}) {
  const requestedPreset = input?.preset || DEFAULT_WATERMARK_SETTINGS.preset;
  const preset = WATERMARK_PRESETS[requestedPreset] ? requestedPreset : DEFAULT_WATERMARK_SETTINGS.preset;
  const presetDefaults = preset === 'private_archive'
    ? { enabled: false, metadataScrubEnabled: false }
    : preset === 'preview'
      ? { enabled: true, metadataScrubEnabled: true, opacity: 0.7 }
      : { enabled: true, metadataScrubEnabled: true };

  const enabled = Boolean(input?.enabled ?? presetDefaults.enabled ?? DEFAULT_WATERMARK_SETTINGS.enabled);
  const metadataScrubEnabled = Boolean(input?.metadataScrubEnabled ?? presetDefaults.metadataScrubEnabled ?? DEFAULT_WATERMARK_SETTINGS.metadataScrubEnabled);
  const positionMode = POSITION_SET.has(input?.positionMode) ? input.positionMode : DEFAULT_WATERMARK_SETTINGS.positionMode;

  return {
    ...DEFAULT_WATERMARK_SETTINGS,
    ...presetDefaults,
    preset,
    enabled,
    primaryText: cleanText(input?.primaryText, DEFAULT_WATERMARK_SETTINGS.primaryText) || DEFAULT_WATERMARK_SETTINGS.primaryText,
    secondaryText: cleanText(input?.secondaryText, DEFAULT_WATERMARK_SETTINGS.secondaryText),
    handleText: cleanText(input?.handleText, ''),
    opacity: clamp(input?.opacity, 0.05, 1, presetDefaults.opacity || DEFAULT_WATERMARK_SETTINGS.opacity),
    textSize: Math.round(clamp(input?.textSize, 18, 96, DEFAULT_WATERMARK_SETTINGS.textSize)),
    logoSize: Math.round(clamp(input?.logoSize, 32, 220, DEFAULT_WATERMARK_SETTINGS.logoSize)),
    portraitEnabled: Boolean(input?.portraitEnabled ?? DEFAULT_WATERMARK_SETTINGS.portraitEnabled),
    logoEnabled: Boolean(input?.logoEnabled ?? DEFAULT_WATERMARK_SETTINGS.logoEnabled),
    portraitPath: cleanAssetPath(input?.portraitPath, DEFAULT_WATERMARK_SETTINGS.portraitPath),
    logoPath: cleanAssetPath(input?.logoPath, DEFAULT_WATERMARK_SETTINGS.logoPath),
    paddingPercent: clamp(input?.paddingPercent, 1, 12, DEFAULT_WATERMARK_SETTINGS.paddingPercent),
    positionMode,
    movementIntervalSeconds: clamp(input?.movementIntervalSeconds, 8, 120, DEFAULT_WATERMARK_SETTINGS.movementIntervalSeconds),
    movementTransitionSeconds: clamp(input?.movementTransitionSeconds, 0, 3, DEFAULT_WATERMARK_SETTINGS.movementTransitionSeconds),
    shadowEnabled: Boolean(input?.shadowEnabled ?? DEFAULT_WATERMARK_SETTINGS.shadowEnabled),
    backgroundPlateEnabled: Boolean(input?.backgroundPlateEnabled ?? DEFAULT_WATERMARK_SETTINGS.backgroundPlateEnabled),
    subtleCenterEnabled: Boolean(input?.subtleCenterEnabled ?? DEFAULT_WATERMARK_SETTINGS.subtleCenterEnabled),
    metadataScrubEnabled,
  };
}

function cleanAssetPath(value, fallback = '') {
  const cleaned = String(value || fallback || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.+/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim();
  return cleaned || fallback;
}

export function safeExportFilename({ contentType = 'video', extension = 'mp4', date = new Date(), shortId = '' } = {}) {
  const yyyyMmDd = new Date(date).toISOString().slice(0, 10);
  const id = cleanText(shortId || crypto.randomUUID().slice(0, 4), '0000')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8) || '0000';
  const rawType = String(contentType || '');
  const typeSource = /[\\/:]|users|appdata|onedrive/i.test(rawType) ? 'video' : rawType;
  const type = cleanText(typeSource, 'video')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'video';
  const ext = cleanText(extension, 'mp4').replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
  return `clinical-climax_${type}_${yyyyMmDd}_${id}.${ext}`;
}

function ffmpegText(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
}

function fontFile() {
  const raw = String(process.env.REVIEW_VIDEO_FONT || process.env.WATERMARK_FONT || 'C\\:/Windows/Fonts/arial.ttf');
  return raw
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z])\/:\//, '$1\\:/')
    .replace(/^([A-Za-z]):\//, '$1\\:/');
}

export function watermarkText(settings = {}) {
  const normalized = normalizeWatermarkSettings(settings);
  return [normalized.primaryText, normalized.secondaryText, normalized.handleText]
    .filter(Boolean)
    .join('  |  ');
}

function fixedPositionExpression(position, padExpression) {
  if (position === 'top_right') return { x: `w-text_w-${padExpression}`, y: padExpression };
  if (position === 'bottom_left') return { x: padExpression, y: `h-text_h-${padExpression}` };
  if (position === 'bottom_right') return { x: `w-text_w-${padExpression}`, y: `h-text_h-${padExpression}` };
  return { x: padExpression, y: padExpression };
}

function assetPath(relativePath) {
  const cleaned = cleanAssetPath(relativePath);
  if (!cleaned) return null;
  return path.join(PUBLIC_DIR, cleaned);
}

async function existingWatermarkAsset(relativePath) {
  const resolved = assetPath(relativePath);
  if (!resolved) return null;
  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    return null;
  }
}

export function watermarkPositionPlan(settings = {}, durationSeconds = 0) {
  const normalized = normalizeWatermarkSettings(settings);
  if (!normalized.enabled) return [];
  const interval = normalized.movementIntervalSeconds;
  const count = Math.max(1, Math.ceil(Math.max(1, Number(durationSeconds || interval)) / interval));
  if (!['rotating_corners', 'intelligent_safe_area'].includes(normalized.positionMode)) {
    return [{ startSeconds: 0, position: normalized.positionMode === 'fixed_custom' ? 'bottom_right' : normalized.positionMode }];
  }
  return Array.from({ length: count }, (_, index) => ({
    startSeconds: Number((index * interval).toFixed(3)),
    position: POSITION_SEQUENCE[index % POSITION_SEQUENCE.length],
  }));
}

export function buildWatermarkFilter(settings = {}) {
  const normalized = normalizeWatermarkSettings(settings);
  if (!normalized.enabled) return null;
  const text = ffmpegText(watermarkText(normalized));
  const font = fontFile();
  const pad = `(min(w\\,h)*${(normalized.paddingPercent / 100).toFixed(4)})`;
  const position = fixedPositionExpression(normalized.positionMode, pad);
  const slot = `mod(floor(t/${normalized.movementIntervalSeconds.toFixed(3)})\\,4)`;
  const rotatingX = `if(eq(${slot}\\,0)\\,${pad}\\,if(eq(${slot}\\,1)\\,${pad}\\,w-text_w-${pad}))`;
  const rotatingY = `if(eq(${slot}\\,0)\\,${pad}\\,if(eq(${slot}\\,2)\\,${pad}\\,h-text_h-${pad}))`;
  const useRotating = ['rotating_corners', 'intelligent_safe_area'].includes(normalized.positionMode);
  const x = useRotating ? rotatingX : position.x;
  const y = useRotating ? rotatingY : position.y;
  const alpha = normalized.opacity.toFixed(3);
  const box = normalized.backgroundPlateEnabled
    ? `:box=1:boxcolor=0x000000@${Math.min(0.55, normalized.opacity).toFixed(3)}:boxborderw=${Math.round(normalized.textSize * 0.42)}`
    : '';
  const shadow = normalized.shadowEnabled
    ? `:shadowcolor=0x000000@${Math.min(0.9, normalized.opacity + 0.15).toFixed(3)}:shadowx=2:shadowy=2`
    : '';
  const main = `drawtext=fontfile='${font}':text='${text}':fontsize=${normalized.textSize}:fontcolor=white@${alpha}:x=${x}:y=${y}${box}${shadow}`;
  const center = normalized.subtleCenterEnabled
    ? `drawtext=fontfile='${font}':text='${text}':fontsize=${Math.max(18, Math.round(normalized.textSize * 0.82))}:fontcolor=white@0.115:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=0x000000@0.18:shadowx=1:shadowy=1`
    : null;
  return [main, center].filter(Boolean).join(',');
}

function ffmpegPath(value = '') {
  return String(value || '').replace(/\\/g, '/');
}

export function buildSarahBrandFilterComplex(settings = {}, { hasPortrait = false, hasLogo = false } = {}) {
  const normalized = normalizeWatermarkSettings(settings);
  if (!normalized.enabled) return null;

  const text = ffmpegText(normalized.primaryText);
  const subtext = ffmpegText([normalized.secondaryText, normalized.handleText].filter(Boolean).join('  |  '));
  const font = fontFile();
  const alpha = normalized.opacity.toFixed(3);
  const pad = `(min(w\\,h)*${(normalized.paddingPercent / 100).toFixed(4)})`;
  const overlayPad = `(min(main_w\\,main_h)*${(normalized.paddingPercent / 100).toFixed(4)})`;
  const portraitSize = normalized.logoSize;
  const iconSize = Math.max(22, Math.round(normalized.logoSize * 0.42));
  const textSize = normalized.textSize;
  const subTextSize = Math.max(14, Math.round(normalized.textSize * 0.58));
  const gap = Math.max(10, Math.round(normalized.logoSize * 0.16));
  const estimatedTextWidth = Math.max(
    140,
    Math.round(Math.max(normalized.primaryText.length, normalized.secondaryText.length) * textSize * 0.48),
  );
  const panelWidth = Math.max(
    300,
    Math.round(portraitSize + iconSize + gap * 3 + estimatedTextWidth),
  );
  const panelHeight = Math.max(portraitSize, Math.round(textSize + subTextSize + gap * 1.6));
  const fixedPosition = normalized.positionMode === 'fixed_custom'
    || normalized.positionMode === 'rotating_corners'
    || normalized.positionMode === 'intelligent_safe_area'
    ? 'top_right'
    : normalized.positionMode;
  const leftAligned = fixedPosition.includes('left');
  const topAligned = fixedPosition.includes('top');
  const mediaWidth = (hasPortrait ? portraitSize + gap : 0) + (hasLogo ? iconSize + gap : 0);
  const panelX = leftAligned ? pad : `max(${pad}\\,w-${panelWidth}-${pad})`;
  const panelY = topAligned ? pad : `max(${pad}\\,h-${panelHeight}-${pad})`;
  const portraitX = leftAligned
    ? overlayPad
    : `max(${overlayPad}\\,main_w-${estimatedTextWidth + iconSize + portraitSize + gap * 3}-${overlayPad})`;
  const portraitY = topAligned ? overlayPad : `max(${overlayPad}\\,main_h-${portraitSize}-${overlayPad})`;
  const iconX = leftAligned
    ? `${overlayPad}+${hasPortrait ? portraitSize + gap : 0}`
    : `max(${overlayPad}\\,main_w-${estimatedTextWidth + iconSize + gap * 2}-${overlayPad})`;
  const iconY = topAligned
    ? `${overlayPad}+${Math.round(gap * 0.35)}`
    : `main_h-${panelHeight}-${overlayPad}+${Math.round(gap * 0.35)}`;
  const textX = leftAligned ? `${pad}+${mediaWidth}` : `w-text_w-${pad}`;
  const primaryY = topAligned
    ? `${pad}+${Math.round(gap * 0.25)}`
    : `h-${panelHeight}-${pad}+${Math.round(gap * 0.25)}`;
  const secondaryY = topAligned
    ? `${pad}+${Math.round(textSize + gap * 0.85)}`
    : `h-${panelHeight}-${pad}+${Math.round(textSize + gap * 0.85)}`;
  const labelX = textX;
  const shadow = normalized.shadowEnabled
    ? `:shadowcolor=0x000000@${Math.min(0.9, normalized.opacity + 0.15).toFixed(3)}:shadowx=2:shadowy=2`
    : '';
  const plate = normalized.backgroundPlateEnabled
    ? `drawbox=x=${panelX}:y=${panelY}:w=${panelWidth}:h=${panelHeight}:color=black@${Math.min(0.45, normalized.opacity).toFixed(3)}:t=fill,`
    : '';

  const steps = ['[0:v]format=rgba[base0]'];
  let current = 'base0';
  let inputIndex = 1;
  if (hasPortrait) {
    steps.push(`[${inputIndex}:v]scale=${portraitSize}:${portraitSize}:force_original_aspect_ratio=increase,crop=${portraitSize}:${portraitSize},format=rgba,colorchannelmixer=aa=${alpha}[sarahPortrait]`);
    steps.push(`[${current}][sarahPortrait]overlay=x=${portraitX}:y=${portraitY}:format=auto[withPortrait]`);
    current = 'withPortrait';
    inputIndex += 1;
  }
  if (hasLogo) {
    steps.push(`[${inputIndex}:v]scale=${iconSize}:${iconSize}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=${alpha}[sarahLogo]`);
    steps.push(`[${current}][sarahLogo]overlay=x=${iconX}:y=${iconY}:format=auto[withLogo]`);
    current = 'withLogo';
  }

  steps.push(`[${current}]${plate}drawtext=fontfile='${font}':text='${text}':fontsize=${textSize}:fontcolor=white@${alpha}:x=${labelX}:y=${primaryY}${shadow},drawtext=fontfile='${font}':text='${subtext}':fontsize=${subTextSize}:fontcolor=white@${Math.min(0.86, normalized.opacity).toFixed(3)}:x=${textX}:y=${secondaryY}${shadow}[vout]`);
  return steps.join(';');
}

export async function applyWatermarkToVideo(inputPath, outputPath, settings = {}, {
  durationSeconds = 0,
  contentType = 'video',
  onProgress = null,
  appVersion = '',
} = {}) {
  const normalized = normalizeWatermarkSettings(settings);
  const portraitAsset = normalized.portraitEnabled ? await existingWatermarkAsset(normalized.portraitPath) : null;
  const logoAsset = normalized.logoEnabled ? await existingWatermarkAsset(normalized.logoPath) : null;
  const brandFilter = (portraitAsset || logoAsset)
    ? buildSarahBrandFilterComplex(normalized, { hasPortrait: Boolean(portraitAsset), hasLogo: Boolean(logoAsset) })
    : null;
  const debug = {
    export_id: crypto.randomUUID(),
    preset: normalized.preset,
    content_type: contentType,
    watermark_enabled: normalized.enabled,
    primary_text: normalized.primaryText,
    secondary_text: normalized.secondaryText,
    opacity: normalized.opacity,
    movement_mode: normalized.positionMode,
    portrait_enabled: Boolean(portraitAsset),
    logo_enabled: Boolean(logoAsset),
    portrait_asset: portraitAsset ? normalized.portraitPath : null,
    logo_asset: logoAsset ? normalized.logoPath : null,
    movement_interval_seconds: normalized.movementIntervalSeconds,
    positions_used: watermarkPositionPlan(normalized, durationSeconds),
    metadata_scrub_enabled: normalized.metadataScrubEnabled,
    metadata_fields_removed: normalized.metadataScrubEnabled ? ['all_input_metadata'] : [],
    app_version: appVersion || null,
    output_path: outputPath,
  };
  const start = Date.now();
  if (!normalized.enabled && !normalized.metadataScrubEnabled) {
    if (inputPath !== outputPath) await fs.copyFile(inputPath, outputPath);
    return { ...debug, success: true, render_duration_ms: Date.now() - start, copied_without_watermark: true };
  }

  const filter = buildWatermarkFilter(normalized);
  const args = [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    ...(portraitAsset ? ['-loop', '1', '-i', ffmpegPath(portraitAsset)] : []),
    ...(logoAsset ? ['-loop', '1', '-i', ffmpegPath(logoAsset)] : []),
    ...(brandFilter ? ['-filter_complex', brandFilter, '-map', '[vout]'] : ['-map', '0:v:0']),
    '-map', '0:a?',
    ...(!brandFilter && filter ? ['-vf', filter] : []),
    '-c:v', 'libx264',
    '-threads', String(WATERMARK_VIDEO_THREADS),
    '-preset', process.env.WATERMARK_VIDEO_PRESET || 'medium',
    '-crf', String(process.env.WATERMARK_VIDEO_CRF || 18),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    ...(brandFilter ? ['-shortest'] : []),
    ...(normalized.metadataScrubEnabled ? [
      '-map_metadata', '-1',
      '-metadata', 'creator=PulsePointLabs',
      '-metadata', `application=${appVersion ? `Sarah v${appVersion}` : 'Sarah'}`,
      '-metadata', 'brand=Clinical Climax',
      '-metadata', 'comment=Public export rendered by Sarah',
    ] : []),
    '-movflags', '+faststart',
    outputPath,
  ];
  onProgress?.({
    phase: 'watermark',
    current: 4,
    total: 5,
    message: normalized.enabled ? 'Baking Clinical Climax watermark into video...' : 'Scrubbing export metadata...',
  });
  await runProcess('ffmpeg', args);
  return { ...debug, success: true, render_duration_ms: Date.now() - start };
}

export async function replaceVideoWithWatermarkedExport(filePath, settings = {}, options = {}) {
  const normalized = normalizeWatermarkSettings(settings);
  if (!normalized.enabled && !normalized.metadataScrubEnabled) {
    return {
      watermark_enabled: false,
      metadata_scrub_enabled: false,
      skipped: true,
    };
  }
  const parsed = path.parse(filePath);
  const tempPath = path.join(parsed.dir, `${parsed.name}.watermarked-${crypto.randomUUID().slice(0, 8)}${parsed.ext || '.mp4'}`);
  const debug = await applyWatermarkToVideo(filePath, tempPath, normalized, options);
  await fs.rename(tempPath, filePath);
  return debug;
}
