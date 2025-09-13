// CommonJS preload (works reliably with contextIsolation)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('file:openDialog'),
  readDropped: (filePath) => ipcRenderer.invoke('file:readDrop', filePath),
  parseDeny: (filePath, opts) => ipcRenderer.invoke('deny:parse', filePath, opts)
});
