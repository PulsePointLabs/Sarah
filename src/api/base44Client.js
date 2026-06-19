import { apiUrl, serverUrl } from "@/lib/mobileApiBase";

async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: await response.text() };
    const rawMessage = data?.error || data?.message || `Request failed: ${response.status}`;
    const message = String(rawMessage).includes('<!DOCTYPE html>')
      ? `Request failed: ${response.status}`
      : rawMessage;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
    return response;
  }
  return contentType.includes('application/json') ? response.json() : response.text();
}

async function invokeFunction(name, payload, options = {}) {
  const response = await fetch(apiUrl(`/functions/${name}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: options.signal,
  });
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: await response.text() };
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (contentType.includes('audio/')) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return {
      status: response.status,
      data: {
        audio: btoa(binary),
        model: response.headers.get('x-tts-model') || undefined,
        voice: response.headers.get('x-tts-voice') || undefined,
        speed: response.headers.get('x-tts-speed') || undefined,
        format: response.headers.get('x-tts-format') || undefined,
        latency_ms: response.headers.get('x-tts-latency-ms') || undefined,
        retries: response.headers.get('x-tts-retries') || undefined,
      },
    };
  }

  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data, ...data };
}

function entityApi(entity) {
  return {
    list: (sort, limit, skip) => {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (limit != null) params.set('limit', limit);
      if (skip != null) params.set('skip', skip);
      return request(`/entities/${entity}?${params.toString()}`);
    },
    listFields: (fields = [], sort, limit, skip) => {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (limit != null) params.set('limit', limit);
      if (skip != null) params.set('skip', skip);
      if (Array.isArray(fields) && fields.length) params.set('fields', fields.join(','));
      return request(`/entities/${entity}?${params.toString()}`);
    },
    filter: (criteria = {}, sort, limit, skip) => request(`/entities/${entity}/filter`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ criteria, sort, limit, skip }),
    }),
    filterFields: (criteria = {}, fields = [], sort, limit, skip) => request(`/entities/${entity}/filter`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ criteria, fields, sort, limit, skip }),
    }),
    create: (data) => request(`/entities/${entity}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}),
    }),
    update: (id, data) => request(`/entities/${entity}/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}),
    }),
    delete: (id) => request(`/entities/${entity}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    bulkCreate: (rows) => request(`/entities/${entity}/bulk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }),
    }),
  };
}

const entityNames = [
  'Session', 'BodyExploration', 'HeartRateTimeline', 'EMGTimeline', 'HowlTelemetry', 'HowlControlCommand', 'HowlControlSettings', 'AudioExport', 'SessionReviewVideo', 'CompareAnalysisResult',
  'CascadeAnalysisResult', 'SessionClusterAnalysis', 'Journal', 'CustomMethod', 'User',
];

export const base44 = {
  entities: Object.fromEntries(entityNames.map((name) => [name, entityApi(name)])),
  auth: {
    me: () => request('/auth/me'),
    meFields: (fields = []) => {
      const params = new URLSearchParams();
      if (Array.isArray(fields) && fields.length) params.set('fields', fields.join(','));
      return request(`/auth/me${params.toString() ? `?${params}` : ''}`);
    },
    updateMe: (data) => request('/auth/me', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}),
    }),
    logout: () => Promise.resolve(),
    redirectToLogin: () => Promise.resolve(),
  },
  integrations: {
    Core: {
      InvokeLLM: async (payload) => {
        const { startBackgroundJob, waitForBackgroundJob } = await import('@/lib/backgroundJobs');
        const label = payload?.label || 'AI analysis';
        const source = payload?.source || 'base44_invoke_llm';
        const job = await startBackgroundJob('ai_invoke', payload || {}, {
          title: label,
          label,
          source,
          foreground: Boolean(payload?.foreground || payload?.interactive),
          quietInTray: Boolean(payload?.quietInTray || /^ai_chat_/i.test(source) || payload?.foreground || payload?.interactive),
          priority: payload?.priority,
        });
        const completed = await waitForBackgroundJob(job.id, { intervalMs: 1200 });
        return completed.result;
      },
      UploadFile: async ({ file }) => {
        const form = new FormData();
        form.append('file', file);
        return request('/files/upload', { method: 'POST', body: form });
      },
      ProcessVideoClip: async ({ file, startSeconds = 0, endSeconds = 8, label = '', frameCount = 12 }) => {
        const form = new FormData();
        form.append('file', file);
        form.append('startSeconds', String(startSeconds));
        form.append('endSeconds', String(endSeconds));
        form.append('label', label);
        form.append('frameCount', String(frameCount));
        return request('/files/video-clip-preview', { method: 'POST', body: form });
      },
      ProcessLocalVideoClip: async ({ path, startSeconds = 0, endSeconds = 8, label = '', frameCount = 12, maxDurationSeconds }) => request('/files/local-video/clip-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, startSeconds, endSeconds, label, frameCount, maxDurationSeconds }),
      }),
      ProcessUploadedVideoClip: async ({ file_url, url, startSeconds = 0, endSeconds = 8, label = '', frameCount = 12, maxDurationSeconds }) => request('/files/uploaded-video/clip-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_url, url, startSeconds, endSeconds, label, frameCount, maxDurationSeconds }),
      }),
      ProcessLocalVideoAudio: async ({ path, startSeconds = 0, windowSeconds = 300, maxSnippets = 10, transcribe = true }) => request('/files/local-video/audio-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, startSeconds, windowSeconds, maxSnippets, transcribe }),
      }),
      AnalyzeLocalVisionWindow: async (payload) => request('/local-vision/analyze-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }),
      AnalyzeLocalVisionContinuous: async (payload) => request('/local-vision/analyze-continuous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }),
      AskLocalVisionVideo: async (payload) => request('/local-vision/ask-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }),
      GetLocalVisionHealth: async () => request('/local-vision/health'),
      ListLocalVisionResults: async ({ sessionId, recordType = '', limit = 10 } = {}) => {
        const query = new URLSearchParams();
        if (sessionId) query.set('sessionId', sessionId);
        if (recordType) query.set('recordType', recordType);
        if (limit) query.set('limit', String(limit));
        return request(`/local-vision/results?${query.toString()}`);
      },
      AnalyzeLocalVisionAdaptive: async (payload) => request('/local-vision/analyze-adaptive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }),
      AnalyzeLocalVisionForward: async (payload) => request('/local-vision/analyze-forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }),
      ConvertVideoForPlayback: async ({ file, label = '' }) => {
        const form = new FormData();
        form.append('file', file);
        form.append('label', label);
        return request('/files/video-playback-preview', { method: 'POST', body: form });
      },
      ConvertLocalVideoForPlayback: async ({ path, label = '' }) => request('/files/local-video/playback-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, label }),
      }),
      GetLocalVideoMetadata: async ({ path }) => request('/files/local-video/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }),
      ResolveDroppedLocalVideo: async ({ filename, sizeBytes = 0, modifiedAtMs = 0 }) => request('/files/local-video/resolve-drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, sizeBytes, modifiedAtMs }),
      }),
      BrowseLocalVideo: async () => request('/files/local-video/browse', { method: 'POST' }),
      localVideoStreamUrl: (path) => serverUrl(`/api/files/local-video/stream?path=${encodeURIComponent(path)}`),
      localVisionAssetUrl: (path) => serverUrl(path),
    },
  },
  functions: {
    invoke: invokeFunction,
  },
};
