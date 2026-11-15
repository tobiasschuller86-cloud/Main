const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createDurableStorage, parseSnapshot, registerDurableStorageHandlers, STORAGE_FORMAT } = require('./durable-storage.cjs');

const snapshot = (name) => JSON.stringify({
  format: STORAGE_FORMAT, version: 1,
  entries: { 'tt-turnier-tournament-v1-one': JSON.stringify({ name }) },
});
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-durable-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('snapshots remain readable immediately after their writer is forcibly terminated', (t) => {
  const directory = temporary(t);
  const raw = snapshot('Saved before termination');
  const script = `const { createDurableStorage } = require(${JSON.stringify(require.resolve('./durable-storage.cjs'))});
    createDurableStorage(process.argv[1]).save(process.argv[2]);
    process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['-e', script, directory, raw], { encoding: 'utf8' });
  assert.ok(child.signal || child.status !== 0, 'The writer must not exit through a normal shutdown');
  assert.equal(createDurableStorage(directory).load(), raw);
});

test('the file is synced before atomic replacement, and failed writes keep the old snapshot', (t) => {
  const directory = temporary(t);
  const store = createDurableStorage(directory);
  store.save(snapshot('Original'));
  const calls = [];
  const io = {
    ...fs,
    fsyncSync(fd) { calls.push('sync'); return fs.fsyncSync(fd); },
    renameSync(from, to) { calls.push('rename'); return fs.renameSync(from, to); },
  };
  createDurableStorage(directory, io).save(snapshot('Updated'));
  assert.equal(calls[0], 'sync');
  assert.equal(calls[1], 'rename');
  for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const failing = createDurableStorage(directory, {
      ...fs, [operation]() { throw Object.assign(new Error('Disk failure'), { code: 'EIO' }); },
    });
    assert.throws(() => failing.save(snapshot('Must not replace')), /Disk failure/);
    assert.equal(store.load(), snapshot('Updated'));
    assert.deepEqual(fs.readdirSync(directory), ['tournament-storage.json']);
  }
});

test('missing storage permits migration, but corruption is explicit and never rewritten', (t) => {
  const directory = temporary(t);
  const store = createDurableStorage(directory);
  assert.equal(store.load(), null);
  fs.writeFileSync(store.filePath, '{broken');
  assert.throws(() => store.load());
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), '{broken');
});

test('different Windows-profile directories keep independent snapshots', (t) => {
  const directory = temporary(t);
  const first = createDurableStorage(path.join(directory, 'account-one'));
  const second = createDurableStorage(path.join(directory, 'account-日本語'));
  first.save(snapshot('First account'));
  second.save(snapshot('Second account'));
  assert.equal(first.load(), snapshot('First account'));
  assert.equal(second.load(), snapshot('Second account'));
});

test('invalid formats, unrelated keys, non-string values, and oversized snapshots are rejected', () => {
  for (const raw of [
    '{}',
    JSON.stringify({ format: STORAGE_FORMAT, version: 2, entries: {} }),
    JSON.stringify({ format: STORAGE_FORMAT, version: 1, entries: { secret: 'value' } }),
    JSON.stringify({ format: STORAGE_FORMAT, version: 1, entries: { 'tt-turnier-test': 1 } }),
    ' '.repeat(16 * 1024 * 1024 + 1),
  ]) assert.throws(() => parseSnapshot(raw));
});

test('only the main app frame can read or write; failures are returned without logging snapshot data', (t) => {
  const store = createDurableStorage(temporary(t));
  const handlers = new Map();
  const reports = [];
  registerDurableStorageHandlers({ on: (channel, handler) => handlers.set(channel, handler) }, store,
    (...args) => reports.push(args));
  const event = (url, child = false) => {
    const mainFrame = { url };
    return { sender: { mainFrame }, senderFrame: child ? { url } : mainFrame };
  };
  for (const denied of [event('https://example.com'), event('ttturnier://other/'), event('ttturnier://app/', true)]) {
    handlers.get('tt-turnier:save-storage')(denied, snapshot('Not allowed'));
    assert.equal(denied.returnValue.ok, false);
    assert.equal(store.load(), null);
  }
  const allowed = event('ttturnier://app/settings');
  handlers.get('tt-turnier:save-storage')(allowed, snapshot('Allowed'));
  assert.equal(allowed.returnValue.ok, true);
  handlers.get('tt-turnier:load-storage')(allowed);
  assert.equal(allowed.returnValue.raw, snapshot('Allowed'));
  handlers.get('tt-turnier:save-storage')(allowed, 'invalid private content');
  assert.equal(allowed.returnValue.ok, false);
  assert.equal(store.load(), snapshot('Allowed'));
  assert.ok(!JSON.stringify(reports).includes('private content'));
});

test('startup traces contain only operation names and are limited to the first read and write', () => {
  const handlers = new Map();
  const traces = [];
  registerDurableStorageHandlers({ on: (channel, fn) => handlers.set(channel, fn) },
    { load: () => snapshot('Private name'), save() {} }, assert.fail, (message) => traces.push(message));
  const frame = { url: 'ttturnier://app/' };
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  for (let count = 0; count < 3; count++) {
    handlers.get('tt-turnier:load-storage')(event);
    handlers.get('tt-turnier:save-storage')(event, snapshot('Private name'));
  }
  assert.deepEqual(traces, [
    'tt-turnier:load-storage: started', 'tt-turnier:load-storage: completed',
    'tt-turnier:save-storage: started', 'tt-turnier:save-storage: completed',
  ]);
});

test('a disposed sender frame returns an error instead of leaving synchronous IPC unanswered', () => {
  const handlers = new Map();
  const reports = [];
  registerDurableStorageHandlers({ on: (channel, fn) => handlers.set(channel, fn) },
    { load: assert.fail, save: assert.fail }, (...args) => reports.push(args));
  const event = { get senderFrame() { throw new Error('Frame disposed'); } };
  handlers.get('tt-turnier:load-storage')(event);
  assert.equal(event.returnValue.ok, false);
  assert.equal(reports.length, 1);
});
