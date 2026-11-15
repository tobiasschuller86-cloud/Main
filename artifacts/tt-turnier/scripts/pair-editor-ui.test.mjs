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

function tournamentWithDuplicatePlayer() {
  return {
    name: 'Testturnier',
    date: '2026-11-14',
    venue: '',
    tableCount: 4,
    groupRounds: 3,
    qualifiersPerGroup: 2,
    phase: 'setup',
    players: [
      { id: 'm1', name: 'Max Original', club: 'DJK Beispiel', category: 'men', groupId: '' },
      { id: 'w1', name: 'Mia Original', club: 'TTC Nord', category: 'women', groupId: '' },
      { id: 'm2', name: 'Moritz Alt', category: 'men', groupId: '' },
      { id: 'w2', name: 'Wanda Original', club: 'DJK Beispiel', category: 'women', groupId: '' },
    ],
    pairs: [
      { id: 'pair-1', menPlayerId: 'm1', womenPlayerId: 'w1', groupId: '' },
      { id: 'pair-2', menPlayerId: 'm1', womenPlayerId: 'w2', groupId: '' },
    ],
    groups: [],
    matches: [],
    qualifiedIds: [],
  };
}

function recoveryBackup() {
  return JSON.stringify({
    format: 'tt-turnier-backup',
    version: 1,
    exportedAt: '2026-11-14T12:00:00.000Z',
    tournament: {
      name: 'Wiederhergestelltes Turnier',
      date: '2026-11-14',
      venue: '',
      tableCount: 4,
      groupRounds: 3,
      qualifiersPerGroup: 2,
      phase: 'setup',
      players: [],
      pairs: [],
      groups: [],
      matches: [],
      qualifiedIds: [],
    },
  });
}

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
      // The app can still be loading or re-rendering.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const dialogs = [];
  const dialogResponses = [];
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push(message.params.message);
      const accept = dialogResponses.length ? dialogResponses.shift() : true;
      socket.send(JSON.stringify({
        id: ++nextId,
        method: 'Page.handleJavaScriptDialog',
        params: { accept },
      }));
      return;
    }
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  return {
    dialogs,
    dialogResponses,
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
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
      }
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

async function replaceFocusedText(cdp, text) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 0 });
  await cdp.send('Input.insertText', { text });
}

test('organizers can repair duplicate players in the pair editor', async (t) => {
  const chromiumPath = process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium';
  const port = await availablePort();
  const appUrl = `http://127.0.0.1:${port}/participants`;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'tt-pair-editor-'));
  const vite = spawn(process.execPath, [
    path.join(appDirectory, 'node_modules/vite/bin/vite.js'),
    '--config',
    'vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
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
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--remote-debugging-port=0',
    `--user-data-dir=${tempDirectory}`,
    'about:blank',
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
      if (!response.ok) return false;
      return response.json();
    } catch {
      return false;
    }
  }, 'the browser tab');

  cdp = createCdpClient(target.webSocketDebuggerUrl);
  const evaluate = cdp.evaluate.bind(cdp);
  cdp.evaluate = (expression) => evaluate(expression.replaceAll(
    'tt-turnier-state-v2',
    'tt-turnier-tournament-v1-pair-editor-test',
  ));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await waitFor(() => cdp.evaluate(
    `document.querySelector('[data-testid="link-participants"]') !== null`,
  ), 'the roster screen');
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="alert-unreadable-tournament"]') !== null`),
    false,
    'missing saved data should not trigger the recovery warning',
  );

  const initialTournament = {
    name: '',
    date: '2026-11-14',
    venue: '',
    tableCount: 4,
    groupRounds: 3,
    qualifiersPerGroup: 2,
    phase: 'setup',
    players: [],
    pairs: [],
    groups: [],
    matches: [],
    qualifiedIds: [],
  };
  await cdp.evaluate(`localStorage.setItem('tt-turnier-workspaces-v1', ${JSON.stringify(JSON.stringify({
    activeId: 'pair-editor-test',
    workspaces: [{ id: 'pair-editor-test', name: 'Pair editor test' }],
  }))});
    localStorage.setItem('tt-turnier-tournament-v1-pair-editor-test', ${JSON.stringify(JSON.stringify(initialTournament))});`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="link-participants"]') !== null`),
    'the seeded tournament workspace',
  );

  const unreadableValue = '{malformed tournament state';
  const backup = recoveryBackup();
  await cdp.evaluate(`localStorage.setItem('tt-turnier-state-v2', ${JSON.stringify(unreadableValue)});
    localStorage.setItem('tt-turnier-recovery-v1', ${JSON.stringify(backup)});`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="alert-unreadable-tournament"]') !== null`),
    'the unreadable-data warning',
  );
  assert.equal(
    await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')`),
    unreadableValue,
    'unreadable saved data must remain untouched while the recovery dialog is open',
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="button-select-startup-backup"]') !== null`),
    true,
    'a backup-file recovery option should be offered',
  );
  await clickElement(cdp, '[data-testid="button-load-startup-recovery"]');
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="alert-unreadable-tournament"]')`),
    'the recovery copy to load',
  );
  assert.equal(
    await cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-state-v2')).name`),
    'Wiederhergestelltes Turnier',
  );

  const validLegacySave = JSON.stringify({
    name: 'Altes Turnier',
    date: '2026-11-13',
    venue: 'Alte Halle',
    tableCount: 6,
    qualifiersPerGroup: 2,
    players: [{ name: 'Marta Alt' }, { name: 'Johann Alt' }],
  });
  await cdp.evaluate(`localStorage.removeItem('tt-turnier-workspaces-v1');
    localStorage.removeItem('tt-turnier-tournament-v1-pair-editor-test');
    localStorage.removeItem('tt-turnier-tournament-v1-tournament-1');
    localStorage.removeItem('tt-turnier-state-v2');
    localStorage.setItem('tt-turnier-state-v1', ${JSON.stringify(validLegacySave)});`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="link-participants"]') !== null
      && document.body.textContent.includes('Marta Alt · Johann Alt')`),
    'the valid legacy participant names to appear on the roster route',
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="alert-unreadable-tournament"]') !== null`),
    false,
    'a valid legacy save should migrate without opening recovery',
  );
  assert.deepEqual(
    await cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-tournament-v1-tournament-1')).legacyParticipantNames`),
    ['Marta Alt', 'Johann Alt'],
    'the migrated workspace should retain the legacy participant names',
  );
  assert.equal(
    await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v1')`),
    validLegacySave,
    'migration should not rewrite the original legacy save',
  );

  const failedLegacyMigration = JSON.stringify({ name: 'Altdaten', players: [{ name: 7 }] });
  await cdp.evaluate(`localStorage.removeItem('tt-turnier-workspaces-v1');
    localStorage.removeItem('tt-turnier-tournament-v1-pair-editor-test');
    localStorage.removeItem('tt-turnier-tournament-v1-tournament-1');
    localStorage.removeItem('tt-turnier-state-v2');
    localStorage.setItem('tt-turnier-state-v1', ${JSON.stringify(failedLegacyMigration)});`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="alert-unreadable-tournament"]') !== null`),
    'the failed legacy-save migration warning',
  );
  assert.equal(
    await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v1')`),
    failedLegacyMigration,
    'a failed legacy migration must leave its original data untouched',
  );
  assert.equal(
    await cdp.evaluate(`window.location.pathname === '/participants'
      && document.querySelector('[data-testid="button-select-startup-backup"]') !== null`),
    true,
    'the startup recovery dialog should remain available on the affected route',
  );

  const uploadStartupBackup = async (contents, fileName) => cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="input-startup-backup"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(contents)}], ${JSON.stringify(fileName)}, { type: 'application/json' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await uploadStartupBackup('{broken backup', 'broken.json');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="text-startup-backup-error"]') !== null`),
    'the invalid backup warning',
  );
  assert.equal(
    await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v1')`),
    failedLegacyMigration,
    'an invalid recovery file must not overwrite unreadable saved data',
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="alert-unreadable-tournament"]') !== null
      && document.querySelector('[data-testid="button-continue-blank"]') !== null`),
    true,
    'the unreadable-data warning and blank-tournament option should remain after an invalid file',
  );
  await clickElement(cdp, '[data-testid="button-continue-blank"]');
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="alert-unreadable-tournament"]')`),
    'the explicit blank-tournament choice after an invalid file',
  );
  await waitFor(
    () => cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-tournament-v1-tournament-1'))?.name === ''`),
    'the blank tournament to be saved after confirmation',
  );
  assert.equal(
    await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v1')`),
    failedLegacyMigration,
    'continuing blank must not delete the unreadable source data',
  );

  await cdp.evaluate(`localStorage.removeItem('tt-turnier-workspaces-v1');
    localStorage.removeItem('tt-turnier-tournament-v1-tournament-1');
    localStorage.removeItem('tt-turnier-state-v2');
    localStorage.setItem('tt-turnier-state-v1', ${JSON.stringify(failedLegacyMigration)});`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="alert-unreadable-tournament"]') !== null`),
    'the unreadable-data warning before restoring a valid file',
  );
  await uploadStartupBackup(recoveryBackup(), 'restored.json');
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="alert-unreadable-tournament"]')`),
    'the valid file recovery',
  );
  await waitFor(
    () => cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-tournament-v1-tournament-1'))?.name === 'Wiederhergestelltes Turnier'`),
    'the restored backup to be saved',
  );
  await cdp.evaluate(`localStorage.setItem('tt-turnier-workspaces-v1', ${JSON.stringify(JSON.stringify({
    activeId: 'pair-editor-test',
    workspaces: [{ id: 'pair-editor-test', name: 'Pair editor test' }],
  }))});
    localStorage.setItem('tt-turnier-tournament-v1-pair-editor-test', localStorage.getItem('tt-turnier-tournament-v1-tournament-1'));
    localStorage.removeItem('tt-turnier-tournament-v1-tournament-1');`);

  await cdp.evaluate(`localStorage.setItem('tt-turnier-state-v2', ${JSON.stringify(JSON.stringify(tournamentWithDuplicatePlayer()))})`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-2"]')?.textContent.includes('Wanda Original')`),
    'the seeded duplicate roster',
  );
  await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    tournament.pairs.push({ id: 'pair-3', menPlayerId: 'm2', womenPlayerId: 'w2', groupId: '' });
    localStorage.setItem('tt-turnier-state-v2', JSON.stringify(tournament));
  })()`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-3"]')?.textContent.includes('Wanda Original')`),
    'the third pair in the conflict test',
  );
  await clickElement(cdp, '[data-testid="link-groups"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="button-generate-groups"]') !== null`), 'the schedule creation screen');
  await clickElement(cdp, '[data-testid="button-generate-groups"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="button-close-roster-conflict"]') !== null`),
    'the multiple-conflict warning',
  );
  const displayedConflicts = await cdp.evaluate(`[
    ...document.querySelectorAll('[data-testid="roster-conflict-list"] > li')
  ].map((item) => ({
    player: item.querySelector(':scope > strong').textContent,
    pairs: [...item.querySelectorAll(':scope > ul > li')].map((pair) => pair.textContent.trim()),
  }))`);
  assert.deepEqual(displayedConflicts, [
    {
      player: 'Max Original',
      pairs: ['Paar 1: Max Original + Mia Original', 'Paar 2: Max Original + Wanda Original'],
    },
    {
      player: 'Wanda Original',
      pairs: ['Paar 2: Max Original + Wanda Original', 'Paar 3: Moritz Alt + Wanda Original'],
    },
  ], 'the warning should name each duplicated player and every affected pair');
  await clickElement(cdp, '[data-testid="button-close-roster-conflict"]');
  await cdp.evaluate(`localStorage.setItem('tt-turnier-state-v2', ${JSON.stringify(JSON.stringify(tournamentWithDuplicatePlayer()))})`);
  await cdp.send('Page.navigate', { url: appUrl });
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-2"]')?.textContent.includes('Wanda Original')`),
    'the original duplicate roster after conflict details are checked',
  );
  await clickElement(cdp, '[data-testid="button-add-pair"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="input-pair-list"]') !== null`), 'the bulk pair editor');
  const rosterBeforeMalformedPaste = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const visiblePairs = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
      .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
    return { tournament, visiblePairs };
  })()`);

  await clickElement(cdp, '[data-testid="input-pair-list"]');
  await replaceFocusedText(cdp, 'Neue Herren;Neue Damen\nUnvollständig;;Spielerin');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="status-toast"]')?.textContent.includes('Zeile 2: genau zwei Namen')`),
    'the missing-name warning',
  );
  assert.ok(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-list"]') !== null`), 'the dialog should stay open after a missing name');
  assert.deepEqual(
    await cdp.evaluate(`(() => {
      const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
      const visiblePairs = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
        .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
      return { tournament, visiblePairs };
    })()`),
    rosterBeforeMalformedPaste,
    'a missing pasted name must leave saved and visible pairs unchanged',
  );

  await clickElement(cdp, '[data-testid="input-pair-list"]');
  await replaceFocusedText(cdp, 'Neue Herren;Neue Damen\n\n\nNur Leerzeichen;   ');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="status-toast"]')?.textContent.includes('Zeile 4: genau zwei Namen')`),
    'the whitespace-only name warning',
  );
  assert.ok(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-list"]') !== null`), 'the dialog should stay open after a whitespace-only name');
  assert.deepEqual(
    await cdp.evaluate(`(() => {
      const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
      const visiblePairs = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
        .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
      return { tournament, visiblePairs };
    })()`),
    rosterBeforeMalformedPaste,
    'a whitespace-only pasted name must leave saved and visible pair assignments unchanged',
  );

  await clickElement(cdp, '[data-testid="input-pair-list"]');
  await replaceFocusedText(cdp, 'Neue Herren;Neue Damen\nGültig;Gültig\nZu viele;Felder;Hier');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="status-toast"]')?.textContent.includes('Zeile 3: genau zwei Namen')`),
    'the extra-field warning',
  );
  assert.ok(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-list"]') !== null`), 'the dialog should stay open after extra fields');
  assert.deepEqual(
    await cdp.evaluate(`(() => {
      const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
      const visiblePairs = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
        .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
      return { tournament, visiblePairs };
    })()`),
    rosterBeforeMalformedPaste,
    'an extra pasted field must leave saved and visible pairs unchanged',
  );

  await clickElement(cdp, '[data-testid="input-pair-list"]');
  await replaceFocusedText(cdp, '  Einmalig  ;Spielerin A\n eInMaLiG ;Spielerin B');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="status-toast"]')?.textContent.includes('Name bereits vorhanden: eInMaLiG')`),
    'the repeated bulk-name warning',
  );
  assert.ok(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-list"]') !== null`), 'the dialog should stay open after a repeated name');
  assert.deepEqual(
    await cdp.evaluate(`(() => {
      const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
      const visiblePairs = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
        .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
      return { tournament, visiblePairs };
    })()`),
    rosterBeforeMalformedPaste,
    'case-insensitive repeated names with surrounding whitespace must not change saved or visible pairs',
  );
  await clickElement(cdp, '[data-testid="button-cancel-pair"]');
  await waitFor(() => cdp.evaluate(`!document.querySelector('[data-testid="input-pair-list"]')`), 'the bulk pair editor to close');

  await clickElement(cdp, '[data-testid="button-edit-pair-pair-2"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]') !== null`), 'the pair editor before cancelling');
  await clickElement(cdp, 'label[for="input-pair-woman"]');
  await clickElement(cdp, '[data-testid="input-pair-man"]');
  await replaceFocusedText(cdp, 'Marek Verworfen');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]').value`), 'Marek Verworfen');
  await clickElement(cdp, '[data-testid="button-cancel-pair"]');
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="input-pair-man"]')`),
    'the pair editor to close after cancelling',
  );

  const cancelledEdit = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const pair = tournament.pairs.find((item) => item.id === 'pair-2');
    const playerNames = Object.fromEntries(tournament.players.map((player) => [player.id, player.name]));
    return {
      row: document.querySelector('[data-testid="row-pair-pair-2"]')?.textContent,
      pair,
      playerNames,
      stored: localStorage.getItem('tt-turnier-state-v2'),
    };
  })()`);
  assert.match(cancelledEdit.row, /Max Original/);
  assert.match(cancelledEdit.row, /Wanda Original/);
  assert.doesNotMatch(cancelledEdit.row, /Marek Verworfen/);
  assert.equal(cancelledEdit.pair.menPlayerId, 'm1');
  assert.equal(cancelledEdit.pair.womenPlayerId, 'w2');
  assert.equal(cancelledEdit.playerNames[cancelledEdit.pair.menPlayerId], 'Max Original');
  assert.equal(cancelledEdit.playerNames[cancelledEdit.pair.womenPlayerId], 'Wanda Original');
  assert.doesNotMatch(cancelledEdit.stored, /Marek Verworfen/);

  await clickElement(cdp, '[data-testid="button-edit-pair-pair-2"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]') !== null`), 'the pair editor');
  await clickElement(cdp, 'label[for="input-pair-woman"]');
  assert.equal(await cdp.evaluate(`document.activeElement?.id`), 'input-pair-woman');
  await clickElement(cdp, '[data-testid="input-pair-woman"]');
  const rosterBeforeDuplicateAttempt = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const visiblePairs = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
      .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
    return { tournament, visiblePairs };
  })()`);
  await replaceFocusedText(cdp, '  mIa OrIgInAl  ');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-woman"]').value`), '  mIa OrIgInAl  ');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="status-toast"]')?.textContent.includes('Name bereits vorhanden: mIa OrIgInAl (bereits registriert als: Mia Original)')`),
    'the duplicate-name warning',
  );
  assert.ok(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]') !== null`), 'the pair editor should stay open');
  const rejectedDuplicate = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const visiblePairs = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
      .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
    return { tournament, visiblePairs };
  })()`);
  assert.deepEqual(
    rejectedDuplicate,
    rosterBeforeDuplicateAttempt,
    'a rejected duplicate edit must leave the saved tournament and visible pair assignments unchanged',
  );

  await clickElement(cdp, '[data-testid="input-pair-woman"]');
  await replaceFocusedText(cdp, 'Wanda Original');
  await clickElement(cdp, '[data-testid="input-pair-man"]');
  await replaceFocusedText(cdp, 'Marek Neu');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]').value`), 'Marek Neu');
  await clickElement(cdp, '[data-testid="input-pair-club"]');
  await replaceFocusedText(cdp, 'DJK Beispiel e.V.');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-club"]').value`), 'DJK Beispiel e.V.');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="input-pair-man"]')`),
    'the pair editor to close after saving',
  );
  await waitFor(
    () => cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')?.includes('Marek Neu')`),
    'the repaired roster to be saved',
  );

  const result = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const rows = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
      .map((row) => [row.dataset.testid.replace('row-pair-', ''), row.textContent]));
    const playerIds = new Set(tournament.players.map((player) => player.id));
    const assignedIds = tournament.pairs.flatMap((pair) => [pair.menPlayerId, pair.womenPlayerId]);
    return {
      rows,
      pairIds: tournament.pairs.map((pair) => pair.id),
      pair1: tournament.pairs.find((pair) => pair.id === 'pair-1'),
      pair2: tournament.pairs.find((pair) => pair.id === 'pair-2'),
      playerNames: Object.fromEntries(tournament.players.map((player) => [player.id, player.name])),
      playerClubs: Object.fromEntries(tournament.players.map((player) => [player.id, player.club])),
      hasDuplicateAssignments: new Set(assignedIds).size !== assignedIds.length,
      missingPlayerIds: assignedIds.filter((id) => !playerIds.has(id)),
    };
  })()`);

  assert.match(result.rows['pair-1'], /Max Original/);
  assert.match(result.rows['pair-1'], /Mia Original/);
  assert.match(result.rows['pair-2'], /Marek Neu/);
  assert.match(result.rows['pair-2'], /Wanda Original/);
  assert.match(result.rows['pair-2'], /DJK Beispiel e\.V\./);
  assert.deepEqual(result.pairIds, ['pair-1', 'pair-2']);
  assert.equal(result.pair2.id, 'pair-2');
  assert.equal(result.pair2.womenPlayerId, 'w2');
  assert.equal(result.playerNames[result.pair1.menPlayerId], 'Max Original');
  assert.equal(result.playerNames[result.pair2.menPlayerId], 'Marek Neu');
  assert.equal(result.playerNames[result.pair2.womenPlayerId], 'Wanda Original');
  assert.equal(result.playerClubs[result.pair2.menPlayerId], 'DJK Beispiel e.V.');
  assert.equal(result.playerClubs[result.pair2.womenPlayerId], 'DJK Beispiel e.V.');
  assert.equal(result.playerClubs[result.pair1.menPlayerId], 'DJK Beispiel');
  assert.equal(result.playerClubs[result.pair1.womenPlayerId], 'TTC Nord');
  assert.equal(result.hasDuplicateAssignments, false);
  assert.deepEqual(result.missingPlayerIds, []);

  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-1"]')?.textContent.includes('Max Original')
      && document.querySelector('[data-testid="row-pair-pair-2"]')?.textContent.includes('Marek Neu')`),
    'the edited roster to restore after reload',
  );
  const restoredEdit = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const rows = [...document.querySelectorAll('[data-testid^="row-pair-"]')].map((row) => ({
      id: row.dataset.testid.replace('row-pair-', ''),
      text: row.textContent,
      order: row.querySelector('.rank')?.textContent.trim(),
    }));
    const playersById = new Map(tournament.players.map((player) => [player.id, player]));
    const assignedIds = tournament.pairs.flatMap((pair) => [pair.menPlayerId, pair.womenPlayerId]);
    return {
      rows,
      pairs: tournament.pairs,
      playersById: Object.fromEntries(playersById),
      invalidPlayerIds: assignedIds.filter((id) => !playersById.has(id)),
    };
  })()`);
  assert.deepEqual(
    restoredEdit.rows.map(({ id, order }) => [id, order]),
    [['pair-1', '01'], ['pair-2', '02']],
    'the saved pair IDs and roster order should remain unchanged after reload',
  );
  assert.match(restoredEdit.rows[0].text, /Max Original/);
  assert.match(restoredEdit.rows[0].text, /Mia Original/);
  assert.match(restoredEdit.rows[1].text, /Marek Neu/);
  assert.match(restoredEdit.rows[1].text, /Wanda Original/);
  assert.match(restoredEdit.rows[1].text, /DJK Beispiel e\.V\./);
  assert.equal(restoredEdit.playersById[restoredEdit.pairs[1].menPlayerId].name, 'Marek Neu');
  assert.equal(restoredEdit.playersById[restoredEdit.pairs[1].womenPlayerId].name, 'Wanda Original');
  assert.equal(restoredEdit.playersById[restoredEdit.pairs[1].menPlayerId].club, 'DJK Beispiel e.V.');
  assert.equal(restoredEdit.playersById[restoredEdit.pairs[1].womenPlayerId].club, 'DJK Beispiel e.V.');
  assert.deepEqual(restoredEdit.invalidPlayerIds, [], 'every saved pair should reference an existing player');

  await clickElement(cdp, '[data-testid="button-edit-pair-pair-2"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]') !== null`), 'the pair editor for a typo warning');
  await clickElement(cdp, 'label[for="input-pair-man"]');
  await clickElement(cdp, '[data-testid="input-pair-man"]');
  await replaceFocusedText(cdp, 'Moriz Alt');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]').value`), 'Moriz Alt');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  const typoWarningState = await cdp.evaluate(`({
    inputValue: document.querySelector('[data-testid="input-pair-man"]')?.value,
    warning: document.querySelector('[data-testid="similar-name-warning"]')?.textContent,
    savedNames: JSON.parse(localStorage.getItem('tt-turnier-state-v2')).players.map((player) => player.name),
  })`);
  assert.ok(
    typoWarningState.warning?.includes('Möglicher Schreibfehler')
      && typoWarningState.warning.includes('Moritz Alt'),
    `expected a visible likely-typo warning; got ${JSON.stringify(typoWarningState)}`,
  );
  assert.ok(typoWarningState.savedNames.includes('Moritz Alt'));
  assert.ok(!typoWarningState.savedNames.includes('Moriz Alt'), 'the similar name must not be saved before the organizer chooses');
  await clickElement(cdp, '[data-testid="button-review-similar-names"]');
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="similar-name-warning"]') === null`),
    true,
    'the organizer should be able to return to the form and review the name',
  );
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="similar-name-warning"]')?.textContent.includes('Moritz Alt')`),
    'the similar-name warning to appear again after another save attempt',
  );
  await clickElement(cdp, '[data-testid="button-accept-similar-names"]');
  await waitFor(
    () => cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')?.includes('Moriz Alt')`),
    'the organizer-approved similar name to save',
  );
  assert.ok(
    await cdp.evaluate(`!document.querySelector('[data-testid="input-pair-man"]')`),
    'confirming the typo warning should allow the intentional name',
  );

  await clickElement(cdp, '[data-testid="button-add-pair"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="input-pair-list"]') !== null`), 'the bulk pair editor for valid registration');
  const rosterBeforeValidPaste = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    return { pairCount: tournament.pairs.length, playerCount: tournament.players.length };
  })()`);
  await clickElement(cdp, '[data-testid="input-pair-club"]');
  await replaceFocusedText(cdp, '  TTC Test  ');
  await clickElement(cdp, '[data-testid="input-pair-list"]');
  await replaceFocusedText(cdp, '   Nora Erfolgreich   |   Nils Erfolgreich   \n\n   Olaf Erfolgreich   |   Olivia Erfolgreich   ');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="input-pair-list"]')`),
    'the bulk pair editor to close after successful registration',
  );
  await waitFor(
    () => cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')?.includes('Olivia Erfolgreich')`),
    'the successfully registered pairs to be saved',
  );

  const bulkRegistration = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const playerNames = Object.fromEntries(tournament.players.map((player) => [player.id, player.name]));
    const rows = Object.fromEntries([...document.querySelectorAll('[data-testid^="row-pair-"]')]
      .map((row) => [row.dataset.testid.replace('row-pair-', ''), {
        text: row.textContent,
        displayedNames: [...row.querySelector('td.strong > span').childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(''),
      }]));
    return {
      pairs: tournament.pairs.map((pair) => ({
        id: pair.id,
        names: [playerNames[pair.menPlayerId], playerNames[pair.womenPlayerId]],
        clubs: tournament.players
          .filter((player) => pair.menPlayerId === player.id || pair.womenPlayerId === player.id)
          .map((player) => player.club),
      })),
      rows,
      playerCount: tournament.players.length,
      toast: document.querySelector('[data-testid="status-toast"]')?.textContent,
    };
  })()`);
  const registeredPairs = bulkRegistration.pairs.slice(rosterBeforeValidPaste.pairCount);
  assert.deepEqual(
    registeredPairs.map((pair) => pair.names),
    [
      ['Nora Erfolgreich', 'Nils Erfolgreich'],
      ['Olaf Erfolgreich', 'Olivia Erfolgreich'],
    ],
    'every valid pasted row must be saved as a pair with its two players',
  );
  assert.ok(
    registeredPairs.flatMap((pair) => pair.names).every((name) => name === name.trim()),
    'saved player names must not contain surrounding whitespace',
  );
  assert.equal(bulkRegistration.pairs.length, rosterBeforeValidPaste.pairCount + 2);
  assert.equal(bulkRegistration.playerCount, rosterBeforeValidPaste.playerCount + 4);
  for (const pair of registeredPairs) {
    assert.ok(bulkRegistration.rows[pair.id], `pair ${pair.id} should appear in the visible roster`);
    assert.equal(
      bulkRegistration.rows[pair.id].displayedNames,
      `${pair.names[0]} + ${pair.names[1]}`,
      'the visible pair row should show the trimmed player names without surrounding whitespace',
    );
    assert.ok(bulkRegistration.rows[pair.id].text.includes('TTC Test'), 'the selected club should appear in every visible pair row');
    assert.deepEqual(pair.clubs, ['TTC Test', 'TTC Test'], 'the selected club should apply to every pasted player');
  }
  assert.match(bulkRegistration.toast, /2 Mixed-Paare hinzugefügt/);

  await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    tournament.pairs[0].womenPlayerId = 'missing-roster-player';
    localStorage.setItem('tt-turnier-state-v2', JSON.stringify(tournament));
  })()`);
  await cdp.send('Page.reload');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-1"]')?.textContent.includes('Fehlende Spielerin')`),
    'the visible missing-player roster entry',
  );
  await clickElement(cdp, '[data-testid="link-groups"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="button-generate-groups"]') !== null`),
    'the schedule creation screen',
  );
  await clickElement(cdp, '[data-testid="button-generate-groups"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="button-close-roster-conflict"]') !== null`),
    'the missing roster reference warning before schedule generation',
  );
  const missingRosterWarning = await cdp.evaluate(`document.querySelector('[data-testid="button-close-roster-conflict"]').parentElement.parentElement.textContent`);
  assert.match(missingRosterWarning, /missing-roster-player/);
  assert.match(missingRosterWarning, /Paar 1/);
  assert.deepEqual(
    await cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-state-v2')).groups`),
    [],
    'schedule generation must not proceed with a missing player record',
  );
  await clickElement(cdp, '[data-testid="button-close-roster-conflict"]');
  await clickElement(cdp, '[data-testid="link-participants"]');
  await clickElement(cdp, '[data-testid="button-edit-pair-pair-1"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="input-pair-woman"]') !== null`),
    'the pair editor for repairing a missing player',
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="input-pair-woman"]').value`),
    '',
    'the missing player name should be visibly empty for replacement',
  );
  await clickElement(cdp, '[data-testid="input-pair-woman"]');
  await replaceFocusedText(cdp, 'Wiebke Repariert');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  const missingPlayerRepairWarning = await cdp.evaluate(
    `document.querySelector('[data-testid="similar-name-warning"]')?.textContent ?? null`,
  );
  if (missingPlayerRepairWarning) {
    await clickElement(cdp, '[data-testid="button-accept-similar-names"]');
  }
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="input-pair-woman"]')`),
    `the repaired pair to save${missingPlayerRepairWarning ? ' after confirming its similar-name warning' : ''}`,
  );
  const repairedMissingPlayer = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    const pair = tournament.pairs.find((candidate) => candidate.id === 'pair-1');
    const player = tournament.players.find((candidate) => candidate.id === pair.womenPlayerId);
    return { pair, player, missing: pair.womenPlayerId === 'missing-roster-player' };
  })()`);
  assert.equal(repairedMissingPlayer.missing, false);
  assert.equal(repairedMissingPlayer.player.name, 'Wiebke Repariert');
  assert.equal(repairedMissingPlayer.player.category, 'women');
  assert.match(
    await cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-1"]').textContent`),
    /Wiebke Repariert/,
  );

  const existingTournamentRaw = await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')`);
  const recoverySavedAt = '2026-11-14T15:30:00.000Z';
  await cdp.evaluate(`localStorage.setItem('tt-turnier-recovery-v1', ${JSON.stringify(JSON.stringify([
    { savedAt: recoverySavedAt, raw: recoveryBackup() },
  ]))})`);
  await clickElement(cdp, '[data-testid="link-settings"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="button-preview-recovery-0"]') !== null`),
    'the saved recovery history',
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="button-download-recovery-0"]') !== null`),
    true,
    'each recovery copy should offer a download action',
  );
  await clickElement(cdp, '[data-testid="button-preview-recovery-0"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="backup-comparison"]') !== null`),
    'the recovery comparison preview',
  );
  const playerDifference = await cdp.evaluate(`document.querySelector('[data-testid="backup-difference-spieler"]').textContent`);
  assert.match(
    playerDifference,
    /Spieler:\s*\d+ → 0/,
    'the preview should show the roster difference before replacement',
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[aria-label="Spiele in der Sicherung"]') !== null`),
    true,
    'the preview should retain its backup content details',
  );
  assert.equal(
    await cdp.evaluate(`(() => {
      const text = document.querySelector('[data-testid="backup-comparison"]').parentElement.textContent;
      const savedAt = new Date(${JSON.stringify(recoverySavedAt)});
      const formattedTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(savedAt);
      return text.includes('Gespeichert am') && text.includes(formattedTime);
    })()`),
    true,
    'the recovery preview should show its saved time',
  );
  assert.equal(
    await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')`),
    existingTournamentRaw,
    'previewing a recovery copy must not alter the active tournament',
  );
  await clickElement(cdp, '[data-testid="button-cancel-backup-preview"]');
  await waitFor(
    () => cdp.evaluate(`!document.querySelector('[data-testid="backup-comparison"]')`),
    'the recovery comparison to close without restoring',
  );

  const tournamentWithResults = {
    name: 'Ergebnisschutz-Test',
    date: '2026-11-14',
    venue: '',
    tableCount: 4,
    groupRounds: 3,
    qualifiersPerGroup: 2,
    phase: 'groups',
    players: [
      { id: 'm1', name: 'Max', category: 'men', groupId: 'group-1' },
      { id: 'w1', name: 'Mia', category: 'women', groupId: 'group-1' },
      { id: 'm2', name: 'Moritz', category: 'men', groupId: 'group-1' },
      { id: 'w2', name: 'Wanda', category: 'women', groupId: 'group-1' },
    ],
    pairs: [
      { id: 'pair-1', menPlayerId: 'm1', womenPlayerId: 'w1', groupId: 'group-1' },
      { id: 'pair-2', menPlayerId: 'm2', womenPlayerId: 'w2', groupId: 'group-1' },
    ],
    groups: [{ id: 'group-1', name: 'Gruppe 1' }],
    matches: [{
      id: 'match-1',
      stage: 'group',
      round: 1,
      groupId: 'group-1',
      side1: ['m1', 'w1'],
      side2: ['m2', 'w2'],
      status: 'completed',
      sets: [{ p1: 11, p2: 7 }, { p1: 11, p2: 9 }],
      winnerSide: 1,
      tableNumber: 1,
    }],
    qualifiedIds: [],
  };
  await cdp.evaluate(`localStorage.setItem('tt-turnier-state-v2', ${JSON.stringify(JSON.stringify(tournamentWithResults))})`);
  await cdp.send('Page.navigate', { url: appUrl });
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-1"]')?.textContent.includes('Max')`),
    'the tournament with a completed match',
  );
  await clickElement(cdp, '[data-testid="button-edit-pair-pair-1"]');
  await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]') !== null`), 'the pair editor with match results');
  await clickElement(cdp, '[data-testid="input-pair-man"]');
  await replaceFocusedText(cdp, 'Max Neu');
  const tournamentBeforeRejectedSave = await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')`);
  cdp.dialogs.length = 0;
  cdp.dialogResponses.push(false);
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.dialogs.some((message) => message.includes('Spielplan einschließlich aller Ergebnisse zurückgesetzt')),
    'the warning before changing a pair with match results',
  );
  assert.deepEqual(cdp.dialogs, [
    'Beim Ändern dieses Paars wird der vorhandene Spielplan einschließlich aller Ergebnisse zurückgesetzt. Fortfahren?',
  ]);
  assert.equal(
    await cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')`),
    tournamentBeforeRejectedSave,
    'cancelling the confirmation must leave the saved pair, schedule, and match result unchanged',
  );
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]')?.value`),
    'Max Neu',
    'cancelling the confirmation should leave the edit available without saving it',
  );

  cdp.dialogResponses.push(true);
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`(() => {
      const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
      return tournament.players.some((player) => player.name === 'Max Neu')
        && tournament.matches.length === 0
        && tournament.groups.length === 0
        && tournament.phase === 'setup';
    })()`),
    'the confirmed pair edit to reset the old schedule and results',
  );
  const confirmedEdit = await cdp.evaluate(`JSON.parse(localStorage.getItem('tt-turnier-state-v2'))`);
  assert.equal(confirmedEdit.players.find((player) => player.id === 'm1')?.name, 'Max Neu');
  assert.deepEqual(confirmedEdit.matches, []);
  assert.deepEqual(confirmedEdit.groups, []);
  assert.equal(confirmedEdit.phase, 'setup');

  const unsharedPairTournament = {
    name: 'Ungeteilte Spieler',
    date: '2026-11-14',
    venue: '',
    tableCount: 4,
    groupRounds: 3,
    qualifiersPerGroup: 2,
    phase: 'setup',
    players: [
      { id: 'm1', name: 'Max Original', club: 'TTC Nord', category: 'men', groupId: '' },
      { id: 'w1', name: 'Mia Original', club: 'TTC Nord', category: 'women', groupId: '' },
      { id: 'm2', name: 'Moritz Alt', club: 'DJK Beispiel', category: 'men', groupId: '' },
      { id: 'w2', name: 'Wanda Original', club: 'DJK Beispiel', category: 'women', groupId: '' },
    ],
    pairs: [
      { id: 'pair-1', menPlayerId: 'm1', womenPlayerId: 'w1', groupId: '' },
      { id: 'pair-2', menPlayerId: 'm2', womenPlayerId: 'w2', groupId: '' },
    ],
    groups: [],
    matches: [],
    qualifiedIds: [],
  };
  await cdp.evaluate(`localStorage.setItem('tt-turnier-state-v2', ${JSON.stringify(JSON.stringify(unsharedPairTournament))})`);
  await cdp.send('Page.navigate', { url: appUrl });
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="row-pair-pair-2"]')?.textContent.includes('Wanda Original')`),
    'the clean roster with unshared players',
  );
  const unsharedRosterBefore = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    return {
      pairs: tournament.pairs,
      players: tournament.players,
      pairOrder: tournament.pairs.map((pair) => pair.id),
      playerIdsByPair: tournament.pairs.map((pair) => [pair.menPlayerId, pair.womenPlayerId]),
    };
  })()`);
  assert.deepEqual(unsharedRosterBefore.pairOrder, ['pair-1', 'pair-2']);
  assert.deepEqual(unsharedRosterBefore.playerIdsByPair, [['m1', 'w1'], ['m2', 'w2']]);
  await clickElement(cdp, '[data-testid="button-edit-pair-pair-2"]');
  await waitFor(
    () => cdp.evaluate(`document.querySelector('[data-testid="input-pair-man"]') !== null`),
    'the editor for the unshared pair',
  );
  await clickElement(cdp, '[data-testid="input-pair-man"]');
  await replaceFocusedText(cdp, 'Ralf Neu');
  await clickElement(cdp, '[data-testid="button-save-pair"]');
  await waitFor(
    () => cdp.evaluate(`localStorage.getItem('tt-turnier-state-v2')?.includes('Ralf Neu')`),
    'the single-name edit to save',
  );
  const unsharedRosterAfter = await cdp.evaluate(`(() => {
    const tournament = JSON.parse(localStorage.getItem('tt-turnier-state-v2'));
    return { pairs: tournament.pairs, players: tournament.players };
  })()`);
  const expectedPlayersAfterEdit = structuredClone(unsharedRosterBefore.players);
  expectedPlayersAfterEdit.find((player) => player.id === 'm2').name = 'Ralf Neu';
  assert.deepEqual(unsharedRosterAfter.pairs, unsharedRosterBefore.pairs);
  assert.deepEqual(unsharedRosterAfter.players, expectedPlayersAfterEdit);
});
