const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: ()         => ipcRenderer.invoke('get-version'),
  downloadAndInstall: (url, fileName) => ipcRenderer.invoke('download-and-install', url, fileName),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_, data) => cb(data)),
  isElectron: true
});
