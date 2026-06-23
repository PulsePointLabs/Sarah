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
  onBackendExit(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('backend-exit', (_event, payload) => callback(payload));
  },
});
