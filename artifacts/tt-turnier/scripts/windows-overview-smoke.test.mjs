import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = await readFile(new URL('./windows-installer-smoke.mjs', import.meta.url), 'utf8');
const helper = source.slice(
  source.indexOf('async function verifyInitialOverview('),
  source.indexOf('async function verifyReleaseNotesLink('),
);

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

function page({ ready = 'complete', navigation = true, overview = true, action = true, text = 'TURNIERÜBERSICHT' } = {}) {
  return {
    readyState: ready,
    body: { innerText: text },
    querySelector(selector) {
      if (selector === '#main-navigation') return navigation ? {} : null;
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
