import express from 'express';
import fs from 'node:fs/promises';
import { dataDir, databasePath, defaultUploadDir, mediaOutputRoot, ttsRenderDir, uploadDir, uploadDirs } from '../config.js';

export const statusRouter = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = Math.max(3000, Number(process.env.PROVIDER_STATUS_TIMEOUT_MS || 12000));

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
  return {
    provider: 'OpenAI API',
    apiConfigured: Boolean(process.env.OPENAI_API_KEY),
    reportingConfigured: Boolean(process.env.OPENAI_ADMIN_API_KEY),
    reportingHint: process.env.OPENAI_ADMIN_API_KEY
      ? ''
      : 'Add OPENAI_ADMIN_API_KEY to show official API cost reports.',
    costReport: null,
    error: null,
  };
}

async function getOpenAIStatus() {
  const status = openAIBaseStatus();
  if (!process.env.OPENAI_ADMIN_API_KEY) return status;

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

statusRouter.get('/providers', async (_req, res) => {
  const [openai, anthropic] = await Promise.all([
    getOpenAIStatus(),
    getAnthropicStatus(),
  ]);

  res.json({
    checkedAt: new Date().toISOString(),
    providers: { openai, anthropic },
    note: 'Provider APIs report configured usage and cost visibility here when admin reporting keys are available; a prepaid remaining-balance endpoint is not assumed.',
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
