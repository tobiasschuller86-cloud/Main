import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function waitFor(check, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // Wait while the app is loading or rendering.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    async send(method, params = {}) {
      await ready;
      const id = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
      return result.result.value;
    },
    close() {
      socket.close();
    },
  };
}

async function clickElement(cdp, selector) {
  const point = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `Expected a visible element matching ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function typeIntoFocusedField(cdp, text) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 0 });
  await cdp.send('Input.insertText', { text });
}

async function selectWorkspaceByPosition(cdp, key, code) {
  await clickElement(cdp, '[data-testid="select-active-tournament"]');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
}

test('organizers can create, switch, and reopen isolated tournament workspaces', async (t) => {
  const chromiumPath = process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium';
  const port = await availablePort();
  const appUrl = `http://127.0.0.1:${port}/`;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'tt-tournament-workspaces-'));
  const vite = spawn(process.execPath, [
    path.join(appDirectory, 'node_modules/vite/bin/vite.js'),
    '--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { cwd: appDirectory, stdio: 'ignore' });
  let browser;
  let cdp;

  t.after(async () => {
    cdp?.close();
    const stop = (child) => new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
    await stop(browser);
    await stop(vite);
    await rm(tempDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitFor(async () => {
    try {
      const response = await fetch(appUrl);
      return response.ok;
    } catch {
      return false;
    }
  }, 'the app server');

  browser = spawn(chromiumPath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${tempDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });
  const activePortPath = path.join(tempDirectory, 'DevToolsActivePort');
  const debugPort = await waitFor(async () => {
    try {
      const [value] = (await readFile(activePortPath, 'utf8')).split('\n');
      return Number(value) || false;
    } catch {
      return false;
    }
  }, 'Chromium remote debugging');
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' });
      return response.ok ? response.json() : false;
    } catch {
      return false;
    }
  }, 'the browser tab');

  cdp = createCdpClient(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="button-new-tournament"]') !== null`), 'the tournament selector');

  const springCup = {
    name: 'Frühlingspokal',
    date: '2026-05-10',
    venue: '',
    tableCount: 4,
    groupRounds: 3,
    qualifiersPerGroup: 2,
    phase: 'groups',
    players: [
      { id: 'm1', name: 'Max Frühling', category: 'men', groupId: 'g1' },
      { id: 'w1', name: 'Mia Frühling', category: 'women', groupId: 'g1' },
      { id: 'm2', name: 'Moritz Frühling', category: 'men', groupId: 'g1' },
      { id: 'w2', name: 'Wanda Frühling', category: 'women', groupId: 'g1' },
    ],
    pairs: [
      { id: 'pair-spring-1', menPlayerId: 'm1', womenPlayerId: 'w1', groupId: 'g1' },
      { id: 'pair-spring-2', menPlayerId: 'm2', womenPlayerId: 'w2', groupId: 'g1' },
    ],
    groups: [{ id: 'g1', name: 'Gesamtgruppe' }],
    matches: [{
      id: 'match-spring-1',
      stage: 'group',
      round: 1,
      groupId: 'g1',
      side1: ['m1', 'w1'],
      side2: ['m2', 'w2'],
      status: 'completed',
      sets: [{ p1: 11, p2: 8 }, { p1: 11, p2: 7 }],
      winnerSide: 1,
      tableNumber: 1,
    }],
    qualifiedIds: [],
  };
  await cdp.evaluate(`localStorage.setItem('tt-turnier-workspaces-v1', ${JSON.stringify(JSON.stringify({
    activeId: 'spring',
    workspaces: [{ id: 'spring', name: 'Frühlingspokal' }],
  }))});
    localStorage.setItem('tt-turnier-tournament-v1-spring', ${JSON.stringify(JSON.stringify(springCup))});`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="select-active-tournament"]')?.selectedOptions[0]?.textContent === 'Frühlingspokal'`),
    'the existing named tournament to reopen',
  );

  await clickElement(cdp, '[data-testid="link-participants"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-spring-1"]') !== null`), 'the saved pair roster');
  await clickElement(cdp, '[data-testid="link-groups"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="match-match-spring-1"]')?.textContent.includes('11:8')`), 'the saved match result');

  await clickElement(cdp, '[data-testid="button-new-tournament"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="input-new-tournament-name"]') !== null`), 'the new tournament form');
  await clickElement(cdp, '[data-testid="input-new-tournament-name"]');
  await typeIntoFocusedField(cdp, 'Herbstpokal');
  await clickElement(cdp, '[data-testid="button-create-tournament"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="select-active-tournament"]')?.selectedOptions[0]?.textContent === 'Herbstpokal'`),
    'the new tournament to become active',
  );
  const newTournamentId = await cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-workspaces-v1')).activeId`);
  const newState = await cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-tournament-v1-' + encodeURIComponent(${JSON.stringify(newTournamentId)})))`);
  assert.equal(newState.name, 'Herbstpokal');
  assert.deepEqual(newState.players, []);
  assert.deepEqual(newState.matches, []);

  await selectWorkspaceByPosition(cdp, 'Home', 'Home');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="select-active-tournament"]')?.selectedOptions[0]?.textContent === 'Frühlingspokal'`),
    'switching back to the first tournament',
  );
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="match-match-spring-1"]')?.textContent.includes('11:8')`), 'the first tournament result after switching');
  await clickElement(cdp, '[data-testid="link-participants"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-spring-1"]') !== null`), 'the saved pair after switching back');
  await clickElement(cdp, '[data-testid="link-groups"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="match-match-spring-1"]') !== null`), 'the first tournament schedule again');

  await selectWorkspaceByPosition(cdp, 'End', 'End');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="select-active-tournament"]')?.selectedOptions[0]?.textContent === 'Herbstpokal'`),
    'switching back to the new tournament',
  );
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="select-active-tournament"]')?.selectedOptions[0]?.textContent === 'Herbstpokal'`),
    'reopening the selected tournament after reload',
  );
  const finalStates = await cdp.evaluate(`(() => {
    const index = JSON.parse(localStorage.getItem('tt-turnier-workspaces-v1'));
    return index.workspaces.map(({ id, name }) => ({
      id,
      name,
      tournament: JSON.parse(localStorage.getItem('tt-turnier-tournament-v1-' + encodeURIComponent(id))),
    }));
  })()`);
  assert.equal(finalStates.length, 2);
  assert.equal(finalStates.find((item) => item.name === 'Frühlingspokal').tournament.matches[0].sets[0].p1, 11);
  assert.equal(finalStates.find((item) => item.name === 'Herbstpokal').tournament.matches.length, 0);
});
