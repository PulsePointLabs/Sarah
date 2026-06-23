import {
  apiUrl,
  discoverSarahApiBase,
  isSarahNativeShell,
  serverUrl,
} from "@/lib/mobileApiBase";

async function request(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs > 0 && !options.signal ? new AbortController() : null;
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;
  delete fetchOptions.skipApiDiscovery;
  if (controller) fetchOptions.signal = controller.signal;

  const targetUrl = apiUrl(path);
  let response;
  try {
    response = await fetch(targetUrl, fetchOptions);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${targetUrl}`);
    }
    if (
      isSarahNativeShell()
      && !options.skipApiDiscovery
      && !/^https?:\/\//i.test(path)
    ) {
      await discoverSarahApiBase({ timeoutMs: 2200 });
      return request(path, { ...options, skipApiDiscovery: true });
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
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
  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs > 0 && !options.signal ? new AbortController() : null;
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let response;
  try {
    response = await fetch(apiUrl(`/functions/${name}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: options.signal || controller?.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError" && controller) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${apiUrl(`/functions/${name}`)}`);
    }
    if (
      isSarahNativeShell()
      && !options.skipApiDiscovery
    ) {
      await discoverSarahApiBase({ timeoutMs: 2200 });
      return invokeFunction(name, payload, { ...options, skipApiDiscovery: true });
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
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
  'Session', 'BodyExploration', 'HeartRateTimeline', 'EMGTimeline', 'BloodPressureReading', 'HowlTelemetry', 'HowlControlCommand', 'HowlControlSettings', 'AudioExport', 'SessionReviewVideo', 'CompareAnalysisResult',
  'CascadeAnalysisResult', 'SessionClusterAnalysis', 'Journal', 'CustomMethod', 'SessionRecording', 'RecordingUpload', 'RenderedVideo', 'RenderPreset', 'User',
];

export const base44 = {
  entities: Object.fromEntries(entityNames.map((name) => [name, entityApi(name)])),
  auth: {
    me: () => request('/auth/me', { timeoutMs: 7000 }),
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
      GetSessionVideoCapabilities: async () => request('/session-video/capabilities'),
      ListSessionVideoPresets: async () => request('/session-video/presets'),
      CreateSessionRecording: async (payload) => request('/session-video/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        timeoutMs: 15000,
      }),
      ListSessionRecordings: async ({ sessionId } = {}) => {
        const query = new URLSearchParams();
        if (sessionId) query.set('sessionId', sessionId);
        return request(`/session-video/recordings${query.toString() ? `?${query}` : ''}`);
      },
      InitSessionVideoUpload: async (payload) => request('/session-video/uploads/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        timeoutMs: 15000,
      }),
      GetSessionVideoUpload: async (uploadId) => request(`/session-video/uploads/${encodeURIComponent(uploadId)}`),
      UploadSessionVideoChunk: async ({ uploadId, chunkIndex, bytes, signal }) => request(`/session-video/uploads/${encodeURIComponent(uploadId)}/chunks/${encodeURIComponent(chunkIndex)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
        signal,
        timeoutMs: 120000,
      }),
      FinalizeSessionVideoUpload: async (uploadId) => request(`/session-video/uploads/${encodeURIComponent(uploadId)}/finalize`, {
        method: 'POST',
        timeoutMs: 120000,
      }),
      StartSessionVideoRender: async (payload) => request('/session-video/render-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        timeoutMs: 15000,
      }),
      GetSessionVideoRenderJob: async (jobId) => request(`/session-video/render-jobs/${encodeURIComponent(jobId)}`),
      CancelSessionVideoRenderJob: async (jobId) => request(`/session-video/render-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
      GetRenderedSessionVideo: async (renderedId) => request(`/session-video/rendered/${encodeURIComponent(renderedId)}`),
      renderedSessionVideoStreamUrl: (renderedId) => serverUrl(`/api/session-video/rendered/${encodeURIComponent(renderedId)}/stream`),
      renderedSessionVideoDownloadUrl: (renderedId) => serverUrl(`/api/session-video/rendered/${encodeURIComponent(renderedId)}/download`),
    },
  },
  functions: {
    invoke: invokeFunction,
  },
};
