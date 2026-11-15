import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./windows-installer-smoke.mjs', import.meta.url), 'utf8');
const parsing = source.slice(source.indexOf('const zipUpdateSmoke ='), source.indexOf('const debuggingPort ='));
const app = 'C:\\tournament tools\\Tischtennis-Turnier.exe';
const updated = 'C:\\updated tools\\Tischtennis-Turnier.exe';
const installer = 'C:\\downloads\\Setup.exe';
const firstDirectory = 'C:\\first install';
const secondDirectory = 'C:\\second install';

function parse(args) {
  const context = vm.createContext({
    process: { argv: ['node', 'windows-installer-smoke.mjs', ...args] },
    resolve: win32.resolve,
  });
  vm.runInContext(`${parsing}
    globalThis.configuration = { executablePath, zipSmoke, windowsSessionSmoke,
      windowsSessionSaveSmoke, windowsSessionResumeSmoke, standardUserSmoke };`, context);
  return context.configuration;
}

for (const mode of ['--windows-session-save', '--windows-session-resume']) {
  test(`${mode} needs only the app path and standard-account flag, not installer folders`, () => {
    const configuration = parse([mode, app, '--standard-user']);
    assert.equal(configuration.executablePath, app);
    assert.equal(configuration.windowsSessionSmoke, true);
    assert.equal(configuration.standardUserSmoke, true);
    assert.equal(configuration.windowsSessionSaveSmoke, mode.endsWith('save'));
    assert.equal(configuration.windowsSessionResumeSmoke, mode.endsWith('resume'));
  });
}

for (const mode of ['--zip', '--zip-isolated', '--zip-existing', '--zip-return', '--zip-second-return']) {
  test(`${mode} keeps its standard-account argument contract`, () => {
    const configuration = parse([mode, app, '--standard-user']);
    assert.equal(configuration.executablePath, app);
    assert.equal(configuration.zipSmoke, true);
    assert.equal(configuration.windowsSessionSmoke, false);
  });
}

test('ZIP update accepts distinct old and updated executables', () => {
  assert.equal(parse(['--zip-update', app, updated, '--standard-user']).zipSmoke, true);
});

test('long-path launch keeps its administrator-only test contract', () => {
  const nearLimitApp = `C:\\${'p'.repeat(220)}\\Tischtennis-Turnier.exe`;
  assert.equal(parse(['--zip-long-path', nearLimitApp]).zipSmoke, true);
  assert.throws(() => parse(['--zip-long-path', nearLimitApp, '--standard-user']), /Pass --zip/);
  assert.throws(() => parse(['--zip-long-path', app]), /between 240 and 259/);
});

test('installed-app updates still require two distinct installation directories', () => {
  const configuration = parse([app, installer, firstDirectory, secondDirectory]);
  assert.equal(configuration.windowsSessionSmoke, false);
  assert.equal(configuration.zipSmoke, false);
  assert.throws(() => parse([app, installer, firstDirectory, firstDirectory.toUpperCase()]), /must differ/);
});

for (const args of [
  [], ['--windows-session-save'], ['--windows-session-resume'],
  [app], [app, installer, firstDirectory],
  ['--zip-existing', app], ['--zip-update', app],
]) {
  test(`incomplete arguments fail with usage rather than undefined path access: ${args.join(' ') || 'empty'}`, () => {
    assert.throws(() => parse(args), /Pass --zip/);
  });
}
