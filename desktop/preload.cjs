const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sarahDesktop', {
  isDesktop: true,
  onBackendExit(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('backend-exit', (_event, payload) => callback(payload));
  },
});
