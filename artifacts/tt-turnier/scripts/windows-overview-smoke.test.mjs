import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { win32 } from 'node:path';

const source = await readFile(new URL('./windows-installer-smoke.mjs', import.meta.url), 'utf8');

test('all smoke failures report bounded app output and Windows context before cleanup', () => {
  const failureHandler = source.slice(source.lastIndexOf('} catch (error) {'));
  assert.match(failureHandler, /appProcess\?\.startupDiagnostics/);
  assert.match(failureHandler, /describeWindowsStartup\(appProcess\.pid\)/);
  assert.ok(failureHandler.indexOf('throw error') < failureHandler.indexOf('await stopApp'));
});
const helper = source.slice(
  source.indexOf('async function verifyInitialOverview('),
  source.indexOf('async function verifyReleaseNotesLink('),
);

for (const profile of ['C:\\Users\\temporary-one', 'C:\\Users\\temporary-two', 'C:\\Users\\tt-smök-日本語']) {
  test(`standard-user startup replaces inherited paths with ${profile}`, async () => {
    const created = [];
    const env = { USERPROFILE: 'C:\\Users\\wrong-account', APPDATA: 'C:\\Users\\wrong-account\\AppData\\Roaming' };
    const preparation = source.slice(source.indexOf('async function prepareStandardUserProfile('), source.indexOf('async function verifyUnicodeProfileContext('));
    const context = vm.createContext({
      win32, process: { env }, console: { log() {} },
      spawnSync: (_file, args, options) => {
        assert.equal(options.timeout, 30_000);
        assert.match(args.at(-1), /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
        return { status: 0, stdout: JSON.stringify(profile) };
      },
      stat: async (directory) => {
        assert.equal(directory, profile);
        return { isDirectory: () => true };
      },
      mkdir: async (directory, options) => {
        assert.equal(options.recursive, true);
        created.push(directory);
      },
    });
    vm.runInContext(`${preparation}\nglobalThis.prepare = prepareStandardUserProfile;`, context);
    await context.prepare();
    assert.equal(env.USERPROFILE, profile);
    assert.equal(env.APPDATA, win32.join(profile, 'AppData', 'Roaming'));
    assert.equal(env.LOCALAPPDATA, win32.join(profile, 'AppData', 'Local'));
    assert.equal(env.TEMP, win32.join(env.LOCALAPPDATA, 'Temp'));
    assert.equal(env.TMP, env.TEMP);
    assert.ok(created.every((directory) => directory.startsWith(`${profile}\\`)));
  });
}

test('standard-user startup rejects an invalid profile instead of reusing inherited paths', async () => {
  const preparation = source.slice(source.indexOf('async function prepareStandardUserProfile('), source.indexOf('async function verifyUnicodeProfileContext('));
  for (const profile of ['', 'relative-profile', null]) {
    const env = { USERPROFILE: 'original-profile' };
    const context = vm.createContext({
      win32, process: { env },
      spawnSync: () => ({ status: 0, stdout: JSON.stringify(profile) }),
      stat: () => assert.fail('Must reject invalid paths before accessing the filesystem'),
      mkdir: () => assert.fail('Must not create directories for an invalid profile'),
    });
    vm.runInContext(`${preparation}\nglobalThis.prepare = prepareStandardUserProfile;`, context);
    await assert.rejects(context.prepare(), /existing absolute profile directory/);
    assert.equal(env.USERPROFILE, 'original-profile');
  }
});

test('the actual PowerShell output preserves umlauts and Japanese profile characters under an OEM default', async (t) => {
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const profile = 'C:\\Users\\tt-smök-日本語';
  const preparation = source.slice(source.indexOf('async function prepareStandardUserProfile('), source.indexOf('async function verifyUnicodeProfileContext('));
  let unavailable = false;
  const context = vm.createContext({
    win32, process: { env: {} }, console: { log() {} },
    spawnSync: (_file, args, options) => {
      const command = args.at(-1);
      assert.ok(command.includes("[Environment]::GetFolderPath('UserProfile')"));
      const result = spawnSync(executable, [
        ...args.slice(0, -1),
        `[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(437); ${command.replace("[Environment]::GetFolderPath('UserProfile')", `'${profile}'`)}`,
      ], options);
      if (process.platform !== 'win32' && result.error?.code === 'ENOENT') {
        unavailable = true;
        return { status: 0, stdout: JSON.stringify(profile) };
      }
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      return result;
    },
    stat: async (directory) => {
      assert.equal(directory, profile);
      return { isDirectory: () => true };
    },
    mkdir: async () => {},
  });
  vm.runInContext(`${preparation}\nglobalThis.prepare = prepareStandardUserProfile;`, context);
  await context.prepare();
  if (unavailable) t.skip('PowerShell is not installed on this non-Windows runner');
});

for (const [label, output, accepted] of [
  ['standard account', 'False\r\n', true],
  ['administrator', 'True\r\n', false],
  ['invalid role response', '', false],
]) {
  test(`Windows role check ${accepted ? 'accepts' : 'rejects'} ${label}`, () => {
    const roleCheck = source.slice(source.indexOf('function verifyStandardUserContext('), source.indexOf('async function verifyUnicodeProfileContext('));
    const context = vm.createContext({
      console: { log() {} },
      spawnSync: (_file, args) => {
        const command = args.at(-1);
        assert.match(command, /\$principal = \[Security\.Principal\.WindowsPrincipal\]::new\(/);
        assert.match(command, /\$principal\.IsInRole\(/);
        return { status: 0, stdout: output };
      },
    });
    vm.runInContext(`${roleCheck}\nglobalThis.check = verifyStandardUserContext;`, context);
    if (accepted) context.check();
    else assert.throws(() => context.check(), /requires a non-administrator user/);
  });
}

test('app launch retains bounded startup diagnostics without changing security arguments', () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const context = vm.createContext({
    executablePath: 'test.exe',
    debuggingPort: 9222,
    spawn: (_file, args, options) => {
      assert.ok(!args.includes('--no-sandbox'));
      assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
      return child;
    },
  });
  const launch = source.slice(source.indexOf('function launchApp('), source.indexOf('async function findAppPage('));
  vm.runInContext(`${launch}\nlaunchApp();`, context);
  child.stdout.emit('data', Buffer.from('x'.repeat(9_000)));
  child.stderr.emit('data', Buffer.from('startup error'));
  assert.equal(child.startupDiagnostics.length, 8_000);
  assert.ok(child.startupDiagnostics.endsWith('startup error'));
});

test('native startup inspection is bounded and reports failures without overriding the launch error', () => {
  let result = { status: 0, stdout: '{"WindowTitle":"Startup error"}' };
  let calls = 0;
  const context = vm.createContext({
    process: { platform: 'win32' },
    spawnSync: (_file, args, options) => {
      calls++;
      assert.equal(options.timeout, 10_000);
      assert.ok(args.at(-1).includes('Get-Process -Id 1234'));
      return result;
    },
  });
  const diagnostic = source.slice(source.indexOf('function describeWindowsStartup('), source.indexOf('async function waitForPageValue('));
  vm.runInContext(`${diagnostic}\nglobalThis.inspect = describeWindowsStartup;`, context);
  assert.equal(context.inspect(1234), result.stdout);
  result = { status: null, error: new Error('timed out') };
  assert.match(context.inspect(1234), /inspection failed: timed out/);
  assert.equal(context.inspect(undefined), 'unavailable');
  assert.equal(calls, 2);
});

test('temporary Windows account descriptions respect the 48-character system limit', async () => {
  const workflow = await readFile(
    new URL('../../../.github/workflows/windows-installer.yml', import.meta.url), 'utf8',
  );
  const accounts = [...workflow.matchAll(/New-LocalUser\b[^\r\n]+/g)];
  assert.ok(accounts.length >= 4, 'Missing temporary smoke-test accounts');
  for (const [command] of accounts) {
    const description = command.match(/-Description "([^"]*)"/)?.[1];
    assert.ok(description, 'Temporary accounts must have a recognizable description');
    assert.ok(description.length <= 48, `Windows account description is too long: ${description}`);
  }
});

function page({ ready = 'complete', navigation = true, overview = true, action = true, text = 'TURNIERÜBERSICHT', storageError = null } = {}) {
  return {
    readyState: ready,
    body: { innerText: text },
    querySelector(selector) {
      if (selector === '#main-navigation') return navigation ? {} : null;
      if (selector === '[data-testid="desktop-storage-error"]') return storageError ? { textContent: storageError } : null;
      if (selector === 'main .page-heading .eyebrow') {
        return overview ? { textContent: 'Turnierübersicht' } : null;
      }
      if (selector === 'main [data-testid="button-edit-tournament"]') return action ? {} : null;
      throw new Error(`Unexpected overview selector: ${selector}`);
    },
  };
}

function harness(pages) {
  let clock = 0;
  let calls = 0;
  const context = vm.createContext({
    Date: { now: () => clock },
    delay: async (milliseconds) => { clock += milliseconds; },
    evaluatePage: async (_url, expression) => {
      const document = pages[Math.min(calls++, pages.length - 1)];
      return vm.runInNewContext(expression, { document });
    },
  });
  vm.runInContext(`${helper}\nglobalThis.check = verifyInitialOverview;`, context);
  return { check: () => context.check('synthetic-devtools-url'), calls: () => calls };
}

test('overview recognition ignores CSS uppercasing of rendered text', async () => {
  const check = harness([page()]);
  await check.check();
  assert.equal(check.calls(), 1);
});

test('overview recognition waits for the document and React page to finish loading', async () => {
  const check = harness([
    page({ ready: 'loading', navigation: false, overview: false, action: false }),
    page({ overview: false, action: false }),
    page(),
  ]);
  await check.check();
  assert.equal(check.calls(), 3);
});

test('a desktop storage failure is reported immediately rather than mistaken for a slow launch', async () => {
  const check = harness([page({ storageError: 'Cannot read saved tournament file' })]);
  await assert.rejects(check.check(), /Desktop storage initialization failed: Cannot read saved tournament file/);
  assert.equal(check.calls(), 1);
});

for (const [label, options] of [
  ['missing overview page', { overview: false }],
  ['missing navigation', { navigation: false }],
  ['missing overview action', { action: false }],
  ['incomplete document', { ready: 'loading' }],
]) {
  test(`overview recognition still rejects ${label}`, async () => {
    const check = harness([page({ ...options, text: 'Turnierübersicht' })]);
    await assert.rejects(check.check(), /did not reach the overview screen within 15 seconds/);
    assert.equal(check.calls(), 60);
  });
}

function preparationHarness(initial, createWorks = true) {
  const previous = structuredClone(initial);
  const window = { active: initial };
  let dialog = false;
  let name;
  let creations = 0;
  const document = {
    querySelector(selector) {
      if (selector === '[data-testid="button-new-tournament"]') {
        return { click() { dialog = true; } };
      }
      if (selector === '[data-testid="button-create-tournament"]') {
        return { click() {
          assert.equal(dialog, true);
          if (createWorks) {
            window.active = { name, players: [], pairs: [], matches: [] };
            creations++;
            dialog = false;
          }
        } };
      }
      if (selector === '[data-testid="button-add-first-pair"]') {
        return !dialog && window.active.players.length === 0 ? {} : null;
      }
      throw new Error(`Unexpected test preparation selector: ${selector}`);
    },
  };
  const evaluatePage = async (_url, expression) => vm.runInNewContext(expression, { window, document });
  const context = vm.createContext({
    console: { log() {} },
    activeTournamentExpression: () => 'window.active',
    savedTournamentName: 'Independent test tournament',
    evaluatePage,
    fillInput: async (_url, selector, value) => {
      assert.equal(dialog, true);
      assert.equal(selector, '[data-testid="input-new-tournament-name"]');
      name = value;
    },
    waitForPageValue: async (url, expression, expected, description) => {
      assert.equal(await evaluatePage(url, expression), expected, description);
    },
  });
  const preparation = source.slice(source.indexOf('async function prepareSmokeTournament('), source.indexOf('async function createSmokeTournament('));
  vm.runInContext(`${preparation}\nglobalThis.prepare = prepareSmokeTournament;`, context);
  return { prepare: () => context.prepare('synthetic-page'), window, previous, creations: () => creations };
}

test('repeat smoke scenarios create a separate tournament and retain existing matches and players', async () => {
  const existing = { name: 'Previous tournament', players: [{ id: 'player-one' }], pairs: [{ id: 'pair-one' }], matches: [{ sets: [[11, 7]] }] };
  const h = preparationHarness(existing);
  await h.prepare();
  assert.equal(h.creations(), 1);
  assert.deepEqual(existing, h.previous);
  assert.deepEqual(h.window.active, { name: 'Independent test tournament', players: [], pairs: [], matches: [] });
});

test('a fresh smoke profile uses its existing empty workspace', async () => {
  const empty = { name: '', players: [], pairs: [], matches: [] };
  const h = preparationHarness(empty);
  await h.prepare();
  assert.equal(h.creations(), 0);
  assert.equal(h.window.active, empty);
});

test('smoke preparation fails if the UI does not create an independent empty tournament', async () => {
  const h = preparationHarness({ name: 'Existing', players: ['player'], pairs: ['pair'], matches: ['result'] }, false);
  await assert.rejects(h.prepare(), /did not create an independent empty smoke tournament/);
  assert.deepEqual(h.window.active, h.previous);
});
