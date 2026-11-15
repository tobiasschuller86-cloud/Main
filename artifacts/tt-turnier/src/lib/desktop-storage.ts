export interface DurableStorageBridge {
  loadTournamentStorage: () => { ok: boolean; raw?: string | null; message?: string };
  saveTournamentStorage: (snapshot: string) => { ok: boolean; message?: string };
}

const format = 'tt-turnier-desktop-storage';
const isTournamentKey = (key: string) => key.startsWith('tt-turnier-');
const installedStores = new WeakMap<Storage, {
  cleanup: () => void;
  onFailure: (message: string) => void;
}>();

function parseSnapshot(raw: string): Record<string, string> {
  const data = JSON.parse(raw);
  if (data?.format !== format || data.version !== 1 || !data.entries
    || typeof data.entries !== 'object' || Array.isArray(data.entries)
    || Object.entries(data.entries).some(([key, value]) => !isTournamentKey(key) || typeof value !== 'string')) {
    throw new Error('Die lokale Turnierdatei hat ein ungültiges Format. Sie wurde nicht überschrieben.');
  }
  return data.entries;
}

/** Desktop only: acknowledge a storage mutation only after its native file is synced. */
export function installDesktopStorage(
  storage: Storage,
  bridge: DurableStorageBridge,
  onFailure: (message: string) => void,
): () => void {
  const existing = installedStores.get(storage);
  if (existing) {
    existing.onFailure = onFailure;
    return existing.cleanup;
  }
  const prototype = Object.getPrototypeOf(storage) as Storage;
  const originalSet = prototype.setItem;
  const originalRemove = prototype.removeItem;
  const originalClear = prototype.clear;
  const snapshot = (): Record<string, string> => Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && isTournamentKey(key))
      .map((key) => [key, storage.getItem(key)!]),
  );
  const persist = (entries: Record<string, string>) => {
    const result = bridge.saveTournamentStorage(JSON.stringify({ format, version: 1, entries }));
    if (!result.ok) throw new Error(result.message || 'Die Turnierdaten konnten nicht dauerhaft gespeichert werden.');
  };
  const loaded = bridge.loadTournamentStorage();
  if (!loaded.ok) throw new Error(loaded.message || 'Die lokale Turnierdatei konnte nicht gelesen werden.');
  if (loaded.raw === null) {
    // First desktop start: migrate the existing browser database, never reset it.
    persist(snapshot());
  } else {
    if (typeof loaded.raw !== 'string') throw new Error('Die Desktop-Speicherantwort ist ungültig.');
    const entries = parseSnapshot(loaded.raw);
    for (const key of Object.keys(snapshot())) {
      if (!Object.hasOwn(entries, key)) originalRemove.call(storage, key);
    }
    for (const [key, value] of Object.entries(entries)) originalSet.call(storage, key, value);
  }
  const report = (error: unknown): never => {
    const message = error instanceof Error ? error.message : 'Die lokale Datenspeicherung ist fehlgeschlagen.';
    (installedStores.get(storage)?.onFailure ?? onFailure)(message);
    throw error;
  };
  prototype.setItem = function (key, value) {
    key = String(key);
    value = String(value);
    if (this !== storage || !isTournamentKey(key)) return originalSet.call(this, key, value);
    try {
      persist({ ...snapshot(), [key]: value });
      originalSet.call(this, key, value);
    } catch (error) { report(error); }
  };
  prototype.removeItem = function (key) {
    key = String(key);
    if (this !== storage || !isTournamentKey(key)) return originalRemove.call(this, key);
    try {
      const entries = snapshot();
      delete entries[key];
      persist(entries);
      originalRemove.call(this, key);
    } catch (error) { report(error); }
  };
  prototype.clear = function () {
    if (this !== storage) return originalClear.call(this);
    try {
      persist({});
      originalClear.call(this);
    } catch (error) { report(error); }
  };
  const cleanup = () => {
    prototype.setItem = originalSet;
    prototype.removeItem = originalRemove;
    prototype.clear = originalClear;
    installedStores.delete(storage);
  };
  installedStores.set(storage, { cleanup, onFailure });
  return cleanup;
}
