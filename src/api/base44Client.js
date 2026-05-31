const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
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
  const response = await fetch(`${API_BASE}/functions/${name}`, {
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
    filter: (criteria = {}, sort, limit, skip) => request(`/entities/${entity}/filter`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ criteria, sort, limit, skip }),
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
  'Session', 'BodyExploration', 'HeartRateTimeline', 'EMGTimeline', 'AudioExport', 'CompareAnalysisResult',
  'CascadeAnalysisResult', 'SessionClusterAnalysis', 'Journal', 'CustomMethod', 'User',
];

export const base44 = {
  entities: Object.fromEntries(entityNames.map((name) => [name, entityApi(name)])),
  auth: {
    me: () => request('/auth/me'),
    updateMe: (data) => request('/auth/me', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}),
    }),
    logout: () => Promise.resolve(),
    redirectToLogin: () => Promise.resolve(),
  },
  integrations: {
    Core: {
      InvokeLLM: (payload) => request('/ai/invoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
      }),
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
      GetLocalVideoMetadata: async ({ path }) => request('/files/local-video/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }),
      localVideoStreamUrl: (path) => `/api/files/local-video/stream?path=${encodeURIComponent(path)}`,
    },
  },
  functions: {
    invoke: invokeFunction,
  },
};
