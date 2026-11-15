const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STORAGE_FORMAT = 'tt-turnier-desktop-storage';
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function parseSnapshot(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new Error('Invalid desktop storage size.');
  }
  const snapshot = JSON.parse(raw);
  if (snapshot?.format !== STORAGE_FORMAT || snapshot.version !== 1
    || !snapshot.entries || typeof snapshot.entries !== 'object' || Array.isArray(snapshot.entries)) {
    throw new Error('Invalid desktop storage format.');
  }
  for (const [key, value] of Object.entries(snapshot.entries)) {
    if (!key.startsWith('tt-turnier-') || typeof value !== 'string') {
      throw new Error('Invalid desktop storage entry.');
    }
  }
  return snapshot;
}

function createDurableStorage(directory, io = fs) {
  const filePath = path.join(directory, 'tournament-storage.json');
  return {
    filePath,
    load() {
      let raw;
      try {
        const size = io.statSync(filePath).size;
        if (size > MAX_SNAPSHOT_BYTES) throw new Error('Desktop storage file is too large.');
        raw = io.readFileSync(filePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      parseSnapshot(raw);
      return raw;
    },
    save(raw) {
      parseSnapshot(raw);
      io.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = path.join(directory, `.tournament-storage-${randomUUID()}.tmp`);
      let descriptor;
      try {
        descriptor = io.openSync(temporaryPath, 'wx', 0o600);
        io.writeFileSync(descriptor, raw, 'utf8');
        io.fsyncSync(descriptor);
        io.closeSync(descriptor);
        descriptor = undefined;
        io.renameSync(temporaryPath, filePath);
        if (process.platform !== 'win32') {
          const directoryDescriptor = io.openSync(directory, 'r');
          try { io.fsyncSync(directoryDescriptor); }
          finally { io.closeSync(directoryDescriptor); }
        }
      } finally {
        if (descriptor !== undefined) io.closeSync(descriptor);
        io.rmSync(temporaryPath, { force: true });
      }
    },
  };
}

function trustedStorageSender(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender?.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'ttturnier:' && url.hostname === 'app';
  } catch {
    return false;
  }
}

function registerDurableStorageHandlers(ipcMain, storage, reportError = console.error, reportOperation = () => {}) {
  for (const [channel, operation, message] of [
    ['tt-turnier:load-storage', () => storage.load(), 'Die lokale Turnierdatei konnte nicht gelesen werden. Gespeicherte Daten wurden nicht ersetzt.'],
    ['tt-turnier:save-storage', (raw) => storage.save(raw), 'Die Änderung konnte nicht dauerhaft gespeichert werden. Bitte prüfe Speicherplatz und Schreibrechte.'],
  ]) {
    let firstRequest = true;
    ipcMain.on(channel, (event, raw) => {
      try {
        if (!trustedStorageSender(event)) {
          event.returnValue = { ok: false, message: 'Nicht erlaubter Zugriff auf die lokalen Turnierdaten.' };
          return;
        }
        const trace = firstRequest;
        firstRequest = false;
        if (trace) reportOperation(`${channel}: started`);
        event.returnValue = { ok: true, raw: operation(raw) ?? null };
        if (trace) reportOperation(`${channel}: completed`);
      } catch (error) {
        reportError('Desktop tournament storage failed:', error.code || error.name);
        event.returnValue = { ok: false, message };
      }
    });
  }
}

module.exports = { STORAGE_FORMAT, MAX_SNAPSHOT_BYTES, parseSnapshot, createDurableStorage, registerDurableStorageHandlers };
