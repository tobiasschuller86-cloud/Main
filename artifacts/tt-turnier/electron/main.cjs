const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkForNewerWindowsRelease } = require('./update-check.cjs');
const { createWindowOpenHandler, openExternalSafely } = require('./external-links.cjs');
const { stageAndLaunchWindowsZipUpdate } = require('./windows-zip-update.cjs');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ttturnier',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

const publicDirectory = path.resolve(__dirname, '../dist/public');
app.setPath('userData', path.join(app.getPath('appData'), 'Tischtennis-Turnier'));
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function serveApp(request) {
  const requestedPath = decodeURIComponent(new URL(request.url).pathname);
  const candidate = path.resolve(publicDirectory, `.${requestedPath}`);
  if (candidate !== publicDirectory && !candidate.startsWith(`${publicDirectory}${path.sep}`)) {
    return new Response('Not found', { status: 404 });
  }

  let filePath = candidate;
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // Client-side routes such as /groups use the app shell.
    filePath = path.join(publicDirectory, 'index.html');
  }

  try {
    const contents = await fs.readFile(filePath);
    return new Response(contents, {
      headers: {
        'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: true,
    backgroundColor: '#f4f2e9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  window.webContents.setWindowOpenHandler(
    createWindowOpenHandler((url) => shell.openExternal(url)),
  );
  window.loadURL('ttturnier://app/');
}

ipcMain.handle('tt-turnier:check-for-update', async (_event, releaseNotesUrl) => {
  if (process.platform !== 'win32') return { status: 'unsupported' };
  return checkForNewerWindowsRelease({
    releaseNotesUrl,
    currentVersion: app.getVersion(),
  });
});

ipcMain.handle('tt-turnier:open-external', (_event, url) =>
  openExternalSafely(url, (target) => shell.openExternal(target)));

ipcMain.handle('tt-turnier:install-portable-update', async (event) => {
  if (process.platform !== 'win32') return { status: 'unsupported' };
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  const zipDialog = await dialog.showOpenDialog(parentWindow, {
    title: 'Windows-Update-ZIP auswählen',
    properties: ['openFile'],
    filters: [{ name: 'Tischtennis-Turnier Windows-ZIP', extensions: ['zip'] }],
  });
  if (zipDialog.canceled || !zipDialog.filePaths[0]) return { status: 'cancelled' };

  const parentDialog = await dialog.showOpenDialog(parentWindow, {
    title: 'Zielordner für die neue Version auswählen',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (parentDialog.canceled || !parentDialog.filePaths[0]) return { status: 'cancelled' };

  try {
    return await stageAndLaunchWindowsZipUpdate({
      zipPath: zipDialog.filePaths[0],
      parentDirectory: parentDialog.filePaths[0],
      currentVersion: app.getVersion(),
      currentExecutable: process.execPath,
      openPath: (filePath) => shell.openPath(filePath),
    });
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error
        ? error.message
        : 'Die ZIP-Aktualisierung ist fehlgeschlagen. Die bisherige App bleibt unverändert.',
    };
  }
});

app.whenReady().then(async () => {
  await protocol.handle('ttturnier', serveApp);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
