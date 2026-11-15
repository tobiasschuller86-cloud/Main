import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./windows-installer-smoke.mjs', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('const devtoolsConnections ='), source.indexOf('async function evaluatePage('));

test('page exceptions include a bounded description instead of hiding the failing input', async () => {
  const context = vm.createContext({
    sendDevtoolsCommand: async () => ({ exceptionDetails: {
      exception: { description: `Missing smoke-test input: input-pair-man ${'x'.repeat(4000)}` },
    } }),
  });
  const evaluate = source.slice(source.indexOf('async function evaluatePage('), source.indexOf('async function waitForAppPage('));
  vm.runInContext(`${evaluate}\nglobalThis.evaluate = evaluatePage;`, context);
  await assert.rejects(context.evaluate('synthetic-page', 'expression'), (error) => {
    assert.match(error.message, /Missing smoke-test input: input-pair-man/);
    assert.ok(error.message.length < 1600);
    return true;
  });
});

function harness() {
  const sockets = [];
  const timers = new Set();
  class Socket {
    constructor() { this.readyState = 0; this.events = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(event, listener) { this.events.set(event, listener); }
    emit(event, data) { this.events.get(event)?.(data); }
    open() { this.readyState = 1; this.emit('open'); }
    send(message) { this.sent.push(JSON.parse(message)); }
    reply(id, result, error) { this.emit('message', { data: JSON.stringify({ id, result, error }) }); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const context = vm.createContext({
    WebSocket: Socket,
    setTimeout: (fn) => { timers.add(fn); return fn; },
    clearTimeout: (fn) => timers.delete(fn),
  });
  vm.runInContext(`${helper}\nglobalThis.send = sendDevtoolsCommand;`, context);
  return { send: (method, params) => context.send('ws://synthetic-app', method, params), sockets, timers };
}

test('document, file-input lookup, and file selection keep one debugging session', async () => {
  const h = harness();
  const document = h.send('DOM.getDocument');
  const socket = h.sockets[0];
  socket.open();
  socket.reply(1, { root: { nodeId: 10 } });
  assert.equal((await document).root.nodeId, 10);
  const input = h.send('DOM.querySelector', { nodeId: 10, selector: 'input[type=file]' });
  socket.reply(2, { nodeId: 11 });
  assert.equal((await input).nodeId, 11);
  const files = h.send('DOM.setFileInputFiles', { nodeId: 11, files: ['backup.json'] });
  socket.reply(3, {});
  await files;
  assert.equal(h.sockets.length, 1);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(socket.sent.map((command) => command.id), [0, 1, 2, 3]);
  assert.equal(socket.sent[0].method, 'Page.enable');
  assert.equal(h.timers.size, 0);
  socket.close();
});

test('concurrent responses resolve their own request even out of order', async () => {
  const h = harness();
  const first = h.send('first');
  const second = h.send('second');
  h.sockets[0].open();
  h.sockets[0].reply(2, { value: 2 });
  h.sockets[0].reply(1, { value: 1 });
  assert.equal((await second).value, 2);
  assert.equal((await first).value, 1);
  assert.equal(h.timers.size, 0);
  h.sockets[0].close();
});

test('protocol errors fail the request without silently treating it as success', async () => {
  const h = harness();
  const failed = assert.rejects(h.send('DOM.querySelector'), /rejected DOM.querySelector: Missing node/);
  h.sockets[0].open();
  h.sockets[0].reply(1, null, { message: 'Missing node' });
  await failed;
  assert.equal(h.timers.size, 0);
  h.sockets[0].close();
});

test('closing the app rejects pending work and allows a fresh session after restart', async () => {
  const h = harness();
  const closed = assert.rejects(h.send('pending'), /connection closed/);
  h.sockets[0].open();
  h.sockets[0].close();
  await closed;
  assert.equal(h.timers.size, 0);
  const next = h.send('restarted');
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open();
  h.sockets[1].reply(1, { restarted: true });
  assert.equal((await next).restarted, true);
  h.sockets[1].close();
});

test('a request timeout closes the session and rejects all outstanding work', async () => {
  const h = harness();
  const first = assert.rejects(h.send('first'), /Timed out/);
  const second = assert.rejects(h.send('second'), /Timed out/);
  h.sockets[0].open();
  [...h.timers][0]();
  await Promise.all([first, second]);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.timers.size, 0);
});

test('unexpected import alerts report their message rather than hanging or accepting the dialog', async () => {
  const h = harness();
  const failed = assert.rejects(h.send('Runtime.evaluate'), /Unexpected alert.*Invalid backup/);
  const socket = h.sockets[0];
  socket.open();
  socket.emit('message', { data: JSON.stringify({
    method: 'Page.javascriptDialogOpening',
    params: { type: 'alert', message: 'Invalid backup' },
  }) });
  await failed;
  assert.equal(h.timers.size, 0);
  assert.ok(!socket.sent.some((command) => command.method === 'Page.handleJavaScriptDialog'));
});
