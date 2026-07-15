const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sarahDesktop', {
  isDesktop: true,
  getStorageSettings() {
    return ipcRenderer.invoke('storage:get-settings');
  },
  chooseMediaRoot() {
    return ipcRenderer.invoke('storage:choose-media-root');
  },
  clearMediaRoot() {
    return ipcRenderer.invoke('storage:clear-media-root');
  },
  startVoiceWake() {
    return ipcRenderer.invoke('voice-wake:start');
  },
  stopVoiceWake() {
    return ipcRenderer.invoke('voice-wake:stop');
  },
  getVoiceWakeStatus() {
    return ipcRenderer.invoke('voice-wake:status');
  },
  onVoiceWakeEvent(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('voice-wake:event', handler);
    return () => ipcRenderer.removeListener('voice-wake:event', handler);
  },
  onBackendExit(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('backend-exit', (_event, payload) => callback(payload));
  },
});
