const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ttTurnierDesktop', {
  isWindows: process.platform === 'win32',
  checkForUpdate: (releaseNotesUrl) => ipcRenderer.invoke('tt-turnier:check-for-update', releaseNotesUrl),
  openExternal: (url) => ipcRenderer.invoke('tt-turnier:open-external', url),
  installPortableUpdate: () => ipcRenderer.invoke('tt-turnier:install-portable-update'),
});
