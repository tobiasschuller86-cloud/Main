import assert from 'node:assert/strict';
import test from 'node:test';
import { installDesktopStorage, type DurableStorageBridge } from './desktop-storage';

function memory() {
  class MemoryStorage {
    values = new Map<string, string>();
    get length() { return this.values.size; }
    key(index: number) { return [...this.values.keys()][index] ?? null; }
    getItem(key: string) { return this.values.get(String(key)) ?? null; }
    setItem(key: string, value: string) { this.values.set(String(key), String(value)); }
    removeItem(key: string) { this.values.delete(String(key)); }
    clear() { this.values.clear(); }
  }
  return new MemoryStorage() as unknown as Storage;
}
const raw = (entries: Record<string, string>) => JSON.stringify({
  format: 'tt-turnier-desktop-storage', version: 1, entries,
});
function bridge(initial: string | null = null) {
  let disk = initial;
  let failure = false;
  const api: DurableStorageBridge = {
    loadTournamentStorage: () => ({ ok: true, raw: disk }),
    saveTournamentStorage: (next) => {
      if (failure) return { ok: false, message: 'Disk full' };
      disk = next;
      return { ok: true };
    },
  };
  return { api, read: () => disk, fail: () => { failure = true; } };
}

test('first desktop start migrates existing workspaces, backups, and names without clearing browser data', () => {
  const storage = memory();
  storage.setItem('tt-turnier-workspaces-v1', '{"activeId":"one"}');
  storage.setItem('tt-turnier-tournament-v1-one', '{"name":"Vereinsturnier"}');
  storage.setItem('tt-turnier-recovery-v1', '[{"raw":"previous"}]');
  storage.setItem('unrelated-key', 'untouched');
  const disk = bridge();
  installDesktopStorage(storage, disk.api, assert.fail);
  const entries = JSON.parse(disk.read()!).entries;
  assert.equal(entries['tt-turnier-tournament-v1-one'], '{"name":"Vereinsturnier"}');
  assert.equal(entries['tt-turnier-recovery-v1'], '[{"raw":"previous"}]');
  assert.equal(entries['unrelated-key'], undefined);
  assert.equal(storage.getItem('unrelated-key'), 'untouched');
});

test('a synced snapshot restores data even if Chromium loses all of its local storage', () => {
  const first = memory();
  const disk = bridge();
  installDesktopStorage(first, disk.api, assert.fail);
  first.setItem('tt-turnier-workspaces-v1', '{"activeId":"two"}');
  first.setItem('tt-turnier-tournament-v1-two', '{"name":"Herr 1 + Dame 1","sets":[[11,7],[11,8]]}');
  first.setItem('tt-turnier-recovery-v1', '["original tournament"]');
  const restarted = memory();
  installDesktopStorage(restarted, disk.api, assert.fail);
  for (const key of ['tt-turnier-workspaces-v1', 'tt-turnier-tournament-v1-two', 'tt-turnier-recovery-v1']) {
    assert.equal(restarted.getItem(key), first.getItem(key));
  }
});

test('native writes finish before local storage changes; a disk error leaves the previous value intact', () => {
  const storage = memory();
  storage.setItem('tt-turnier-state-v2', 'original');
  const disk = bridge();
  const errors: string[] = [];
  installDesktopStorage(storage, disk.api, (message) => errors.push(message));
  disk.fail();
  assert.throws(() => storage.setItem('tt-turnier-state-v2', 'unsaved'), /Disk full/);
  assert.equal(storage.getItem('tt-turnier-state-v2'), 'original');
  assert.equal(JSON.parse(disk.read()!).entries['tt-turnier-state-v2'], 'original');
  assert.deepEqual(errors, ['Disk full']);
});

test('restore removes only obsolete tournament entries, and later removals are persisted', () => {
  const storage = memory();
  storage.setItem('tt-turnier-obsolete', 'old');
  storage.setItem('unrelated', 'keep');
  const disk = bridge(raw({ 'tt-turnier-active': 'saved' }));
  installDesktopStorage(storage, disk.api, assert.fail);
  assert.equal(storage.getItem('tt-turnier-obsolete'), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
  storage.removeItem('tt-turnier-active');
  assert.deepEqual(JSON.parse(disk.read()!).entries, {});
  storage.setItem('tt-turnier-active', 'next');
  storage.clear();
  assert.deepEqual(JSON.parse(disk.read()!).entries, {});
});

test('unreadable native data blocks initialization without erasing browser data or overwriting the file', () => {
  const storage = memory();
  storage.setItem('tt-turnier-state-v2', 'existing browser copy');
  for (const invalid of ['{broken', raw({ unrelated: 'not allowed' })]) {
    let saved = false;
    assert.throws(() => installDesktopStorage(storage, {
      loadTournamentStorage: () => ({ ok: true, raw: invalid }),
      saveTournamentStorage: () => { saved = true; return { ok: true }; },
    }, assert.fail));
    assert.equal(saved, false);
    assert.equal(storage.getItem('tt-turnier-state-v2'), 'existing browser copy');
  }
});

test('session storage and unrelated local keys never enter the tournament file', () => {
  const storage = memory();
  const disk = bridge();
  installDesktopStorage(storage, disk.api, assert.fail);
  const session = Object.assign(Object.create(Object.getPrototypeOf(storage)), {
    values: new Map<string, string>(),
  }) as Storage;
  session.setItem('tt-turnier-session-only', 'temporary');
  storage.setItem('unrelated', 'value');
  assert.deepEqual(JSON.parse(disk.read()!).entries, {});
  assert.equal(session.getItem('tt-turnier-session-only'), 'temporary');
});

test('remounting the app does not restore stale data or install duplicate storage wrappers', () => {
  const storage = memory();
  const disk = bridge();
  let loads = 0;
  const api: DurableStorageBridge = {
    ...disk.api,
    loadTournamentStorage() { loads++; return disk.api.loadTournamentStorage(); },
  };
  const firstErrors: string[] = [];
  const secondErrors: string[] = [];
  const cleanup = installDesktopStorage(storage, api, (message) => firstErrors.push(message));
  storage.setItem('tt-turnier-state-v2', 'current');
  assert.equal(installDesktopStorage(storage, api, (message) => secondErrors.push(message)), cleanup);
  assert.equal(loads, 1);
  assert.equal(storage.getItem('tt-turnier-state-v2'), 'current');
  disk.fail();
  assert.throws(() => storage.setItem('tt-turnier-state-v2', 'unsaved'), /Disk full/);
  assert.deepEqual(firstErrors, []);
  assert.deepEqual(secondErrors, ['Disk full']);
  cleanup();
});
