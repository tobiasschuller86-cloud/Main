const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ttTurnierDesktop', {
  isWindows: process.platform === 'win32',
  loadTournamentStorage: () => ipcRenderer.sendSync('tt-turnier:load-storage'),
  saveTournamentStorage: (snapshot) => ipcRenderer.sendSync('tt-turnier:save-storage', snapshot),
  checkForUpdate: (releaseNotesUrl) => ipcRenderer.invoke('tt-turnier:check-for-update', releaseNotesUrl),
  openExternal: (url) => ipcRenderer.invoke('tt-turnier:open-external', url),
  installPortableUpdate: () => ipcRenderer.invoke('tt-turnier:install-portable-update'),
});
