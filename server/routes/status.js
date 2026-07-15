import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import { dataDir, databasePath, defaultUploadDir, mediaOutputRoot, ttsRenderDir, uploadDir, uploadDirs } from '../config.js';
import { resolveSttProvider } from '../services/sttProvider.js';

export const statusRouter = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = Math.max(3000, Number(process.env.PROVIDER_STATUS_TIMEOUT_MS || 12000));

function cpuSnapshot() {
  return os.cpus().map((cpu) => ({ ...cpu.times }));
}

function cpuPercentBetween(before = [], after = []) {
  let idleDelta = 0;
  let totalDelta = 0;
  const count = Math.min(before.length, after.length);
  for (let index = 0; index < count; index += 1) {
    const previous = before[index] || {};
    const current = after[index] || {};
    const keys = ['user', 'nice', 'sys', 'idle', 'irq'];
    totalDelta += keys.reduce((sum, key) => sum + Math.max(0, Number(current[key] || 0) - Number(previous[key] || 0)), 0);
    idleDelta += Math.max(0, Number(current.idle || 0) - Number(previous.idle || 0));
  }
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

async function currentSystemLoad() {
  const before = cpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = cpuSnapshot();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const processMemory = process.memoryUsage();
  const cpu = os.cpus()[0];
  return {
    checkedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    uptimeSeconds: os.uptime(),
    cpu: {
      percent: cpuPercentBetween(before, after),
      cores: os.cpus().length,
      model: cpu?.model || 'Unknown CPU',
    },
    memory: {
      totalBytes: totalMemory,
      usedBytes: usedMemory,
      freeBytes: freeMemory,
      percent: totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 1000) / 10 : null,
    },
    backend: {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      rssBytes: processMemory.rss,
      heapUsedBytes: processMemory.heapUsed,
      heapTotalBytes: processMemory.heapTotal,
    },
  };
}

async function pathStatus(dir = '') {
  try {
    const stat = await fs.stat(dir);
    return {
      path: dir,
      exists: true,
      directory: stat.isDirectory(),
    };
  } catch {
    return {
      path: dir,
      exists: false,
      directory: false,
    };
  }
}

function unixDaysAgo(days) {
  return Math.floor((Date.now() - days * DAY_MS) / 1000);
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.error || data?.message || `${response.status} ${response.statusText}`.trim());
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function sumOpenAICost(report) {
  const buckets = Array.isArray(report?.data) ? report.data : [];
  return buckets.reduce((sum, bucket) => {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    return sum + results.reduce((resultSum, result) => resultSum + (numberOrNull(result?.amount?.value) || 0), 0);
  }, 0);
}

function sumAnthropicCost(report) {
  const buckets = Array.isArray(report?.data) ? report.data : [];
  const lowestUnitTotal = buckets.reduce((sum, bucket) => {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    return sum + results.reduce((resultSum, result) => {
      const amount = numberOrNull(result?.amount) ?? numberOrNull(result?.amount?.value) ?? numberOrNull(result?.cost);
      return resultSum + (amount || 0);
    }, 0);
  }, 0);
  return lowestUnitTotal ? lowestUnitTotal / 100 : 0;
}

function openAIBaseStatus() {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.OPENAI_ENABLED || '').trim().toLowerCase());
  return {
    provider: 'OpenAI API',
    enabled,
    apiConfigured: enabled && Boolean(process.env.OPENAI_API_KEY),
    reportingConfigured: Boolean(process.env.OPENAI_ADMIN_API_KEY),
    reportingHint: process.env.OPENAI_ADMIN_API_KEY
      ? ''
      : 'Add OPENAI_ADMIN_API_KEY to show official API cost reports.',
    costReport: null,
    error: null,
  };
}

let openAIStatusCache = null;

async function getOpenAIStatus() {
  const status = openAIBaseStatus();
  if (!status.enabled || !process.env.OPENAI_ADMIN_API_KEY) return status;
  const cacheTtlMs = Number(process.env.OPENAI_STATUS_CACHE_MS || 5 * 60 * 1000);
  if (openAIStatusCache && Date.now() - openAIStatusCache.at < cacheTtlMs) {
    return openAIStatusCache.value;
  }

  try {
    const [sevenDay, thirtyDay] = await Promise.all([
      fetchJson(`https://api.openai.com/v1/organization/costs?start_time=${unixDaysAgo(7)}&bucket_width=1d&limit=7`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_ADMIN_API_KEY}` },
      }),
      fetchJson(`https://api.openai.com/v1/organization/costs?start_time=${unixDaysAgo(30)}&bucket_width=1d&limit=31`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_ADMIN_API_KEY}` },
      }),
    ]);
    status.costReport = {
      currency: 'usd',
      last7Days: sumOpenAICost(sevenDay),
      last30Days: sumOpenAICost(thirtyDay),
      bucketCount: Array.isArray(thirtyDay?.data) ? thirtyDay.data.length : 0,
    };
  } catch (error) {
    status.error = error.message || String(error);
  }
  openAIStatusCache = { at: Date.now(), value: status };
  return status;
}

function anthropicBaseStatus() {
  return {
    provider: 'Claude API',
    apiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    reportingConfigured: Boolean(process.env.ANTHROPIC_ADMIN_API_KEY),
    reportingHint: process.env.ANTHROPIC_ADMIN_API_KEY
      ? ''
      : 'Add ANTHROPIC_ADMIN_API_KEY if your Claude account supports Admin cost reports.',
    costReport: null,
    error: null,
  };
}

async function getAnthropicStatus() {
  const status = anthropicBaseStatus();
  if (!process.env.ANTHROPIC_ADMIN_API_KEY) return status;

  try {
    const [sevenDay, thirtyDay] = await Promise.all([
      fetchJson(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(isoDaysAgo(7))}`, {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': process.env.ANTHROPIC_ADMIN_API_KEY,
        },
      }),
      fetchJson(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(isoDaysAgo(30))}`, {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': process.env.ANTHROPIC_ADMIN_API_KEY,
        },
      }),
    ]);
    status.costReport = {
      currency: 'usd',
      last7Days: sumAnthropicCost(sevenDay),
      last30Days: sumAnthropicCost(thirtyDay),
      bucketCount: Array.isArray(thirtyDay?.data) ? thirtyDay.data.length : 0,
    };
  } catch (error) {
    status.error = error.message || String(error);
  }
  return status;
}

function groqBaseStatus() {
  return {
    provider: 'Groq API',
    apiConfigured: Boolean(process.env.GROQ_API_KEY),
    reportingConfigured: false,
    reportingHint: 'Groq transcription can run here when GROQ_API_KEY is set. Official Groq cost reporting is not wired into Sarah yet.',
    costReport: null,
    error: null,
  };
}

statusRouter.get('/providers', async (_req, res) => {
  const [openai, anthropic] = await Promise.all([
    getOpenAIStatus(),
    getAnthropicStatus(),
  ]);
  const groq = groqBaseStatus();
  let activeTranscriptionProvider = 'unconfigured';
  try {
    activeTranscriptionProvider = resolveSttProvider('auto');
  } catch {}

  res.json({
    checkedAt: new Date().toISOString(),
    providers: { anthropic, openai, groq },
    transcription: {
      requested: String(process.env.SARAH_STT_PROVIDER || process.env.STT_PROVIDER || 'auto'),
      active: activeTranscriptionProvider,
      configured: {
        groq: groq.apiConfigured,
        openai: openai.apiConfigured,
      },
    },
    note: 'Provider APIs report configured usage and cost visibility here when admin reporting keys are available; Groq transcription readiness is shown here even though Groq cost reporting is not yet wired in.',
  });
});

statusRouter.get('/storage', async (_req, res) => {
  res.json({
    ok: true,
    restartRequiredForChanges: true,
    storage: {
      dataDir,
      databasePath,
      mediaOutputRoot,
      uploadDir,
      defaultUploadDir,
      ttsRenderDir,
      uploadDirs,
      uploadDirExternal: uploadDir !== defaultUploadDir,
      uploadDirStatus: await pathStatus(uploadDir),
      defaultUploadDirStatus: await pathStatus(defaultUploadDir),
      ttsRenderDirStatus: await pathStatus(ttsRenderDir),
    },
  });
});

statusRouter.get('/system', async (_req, res) => {
  try {
    res.json({ ok: true, system: await currentSystemLoad() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || 'Could not read desktop system load.' });
  }
});
