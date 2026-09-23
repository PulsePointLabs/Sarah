import crypto from 'node:crypto';
import WebSocket from 'ws';

// OBS v5 connection. No overlay, telemetry relay, scene changes or session creation.
export class ObsPeer {
  constructor({ url, password = '', onEvent = () => {}, onChange = () => {} }) {
    Object.assign(this, { url, password, onEvent, onChange });
    this.ready = false;
    this.pending = new Map();
    this.closed = false;
    this.error = '';
  }
  connect() {
    if (this.closed) return;
    clearTimeout(this.retry);
    const socket = new WebSocket(this.url, { handshakeTimeout: 5000 });
    this.socket = socket;
    const identifyTimer = setTimeout(() => {
      if (!this.ready) { this.error = 'Secondary OBS did not complete its WebSocket login.'; socket.terminate(); }
    }, 8000);
    socket.on('error', () => { this.error = 'Cannot connect to secondary OBS. Check its address, firewall and WebSocket settings.'; this.onChange(); });
    socket.on('close', (code) => {
      clearTimeout(identifyTimer);
      this.ready = false;
      this.error = code === 4009 ? 'Secondary OBS authentication failed. Check the saved password.' : this.error || 'Secondary OBS disconnected';
      for (const request of this.pending.values()) request.reject(new Error(this.error));
      this.pending.clear();
      this.onChange();
      if (!this.closed) { this.retry = setTimeout(() => this.connect(), 3000); this.retry.unref?.(); }
    });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.op === 0) {
        const identify = { rpcVersion: 1, eventSubscriptions: 64 };
        const auth = message.d?.authentication;
        if (auth) {
          const hash = (value) => crypto.createHash('sha256').update(value).digest('base64');
          identify.authentication = hash(hash(this.password + auth.salt) + auth.challenge);
        }
        socket.send(JSON.stringify({ op: 1, d: identify }));
      } else if (message.op === 2) {
        clearTimeout(identifyTimer);
        this.ready = true; this.error = ''; this.onChange();
      } else if (message.op === 5) this.onEvent(message.d?.eventType, message.d?.eventData || {});
      else if (message.op === 7) {
        const pending = this.pending.get(message.d?.requestId);
        if (!pending) return;
        this.pending.delete(message.d.requestId);
        if (message.d.requestStatus?.result) pending.resolve(message.d.responseData || {});
        else pending.reject(new Error(message.d.requestStatus?.comment || 'Secondary OBS rejected the command'));
      }
    });
  }
  request(requestType) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error(this.error || 'Secondary OBS is not ready'));
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Secondary OBS ${requestType} timed out`));
      }, 8000);
      const finish = (callback) => (value) => { clearTimeout(timer); callback(value); };
      this.pending.set(requestId, { resolve: finish(resolve), reject: finish(reject) });
      this.socket.send(JSON.stringify({ op: 6, d: { requestId, requestType } }));
    });
  }
  close() {
    this.closed = true; this.ready = false; clearTimeout(this.retry);
    for (const request of this.pending.values()) request.reject(new Error('Secondary OBS connection closed'));
    this.pending.clear(); this.socket?.close();
  }
}
