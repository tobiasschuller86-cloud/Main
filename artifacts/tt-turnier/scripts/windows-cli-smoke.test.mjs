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
      windowsSessionSaveSmoke, windowsSessionResumeSmoke, standardUserSmoke,
      installerPath, installDirectory, alternateInstallDirectory, updatedZipExecutablePath };`, context);
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

test('native installer paths are canonical even when the script runner doubles backslashes', () => {
  const doubled = (value) => value.replaceAll('\\', '\\\\');
  const configuration = parse([app, installer, firstDirectory, secondDirectory].map(doubled));
  assert.equal(configuration.executablePath, app);
  assert.equal(configuration.installerPath, installer);
  assert.equal(configuration.installDirectory, firstDirectory);
  assert.equal(configuration.alternateInstallDirectory, secondDirectory);
  assert.equal(parse(['--zip-update', doubled(app), doubled(updated), '--standard-user']).updatedZipExecutablePath, updated);
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

const uninstallHelpers = source.slice(source.indexOf('function runInstaller('), source.indexOf('async function reinstallInstalledApp('));

for (const fail of [false, true]) {
  test(`temporary NSIS uninstaller ${fail ? 'cleans up after failure' : 'waits for the explicit target without deleting account data'}`, async () => {
    const calls = [];
    const directory = 'C:\\old install with spaces';
    const temporary = 'C:\\temporary tools\\uninstall helper';
    const filename = 'Uninstall Tischtennis-Turnier.exe';
    const context = vm.createContext({
      installDirectory: directory, join: win32.join, resolve: win32.resolve, tmpdir: () => 'C:\\temporary tools',
      mkdtemp: async () => temporary,
      copyFile: async (from, to) => {
        assert.equal(from, win32.join(directory, filename));
        assert.equal(to, win32.join(temporary, filename));
        calls.push('copy');
      },
      spawnSync: (file, args, options) => {
        assert.equal(file, win32.join(temporary, filename));
        assert.deepEqual(Array.from(args), ['/S', '/KEEP_APP_DATA', `_?=${directory}`]);
        assert.equal(options.windowsVerbatimArguments, true);
        assert.equal(options.argv0, `"${file}"`);
        assert.equal(options.timeout, 120000);
        calls.push('execute');
        return { status: fail ? 5 : 0 };
      },
      rm: async (path, options) => {
        assert.equal(path, temporary);
        assert.equal(options.recursive, true);
        assert.equal(options.maxRetries, 10);
        calls.push('cleanup');
      },
    });
    vm.runInContext(`${uninstallHelpers}\nglobalThis.uninstall = uninstallInstalledFiles;`, context);
    if (fail) await assert.rejects(context.uninstall(filename), /exit code 5/);
    else await context.uninstall(filename);
    assert.deepEqual(calls, ['copy', 'execute', 'cleanup']);
  });
}

test('ordinary installers retain standard Windows quoting and bounded execution', () => {
  const context = vm.createContext({
    spawnSync: (file, args, options) => {
      assert.equal(file, installer);
      assert.deepEqual(Array.from(args), ['/S', `/D=${firstDirectory}`]);
      assert.equal(options.windowsVerbatimArguments, undefined);
      assert.equal(options.argv0, undefined);
      assert.equal(options.timeout, 120000);
      return { status: 0 };
    },
  });
  vm.runInContext(`${uninstallHelpers}\nglobalThis.run = runInstaller;`, context);
  context.run(installer, ['/S', `/D=${firstDirectory}`], 'Installer failed');
});

test('a successful uninstaller exit cannot bypass the executable-removal check', async () => {
  let clock = 0;
  const context = vm.createContext({
    console: { log() {} }, Date: { now: () => clock },
    installDirectory: firstDirectory, executablePath: app,
    readdir: async () => ['Uninstall Tischtennis-Turnier.exe'],
    uninstallInstalledFiles: async () => {},
    stat: async () => ({}),
    delay: async (milliseconds) => { clock += milliseconds; },
    describeInstalledAppUninstallState: () => '[{"Id":123}]',
    runInstaller: () => assert.fail('Must not reinstall while the old executable remains'),
  });
  const reinstall = source.slice(source.indexOf('async function reinstallInstalledApp('), source.indexOf('async function updateInstalledAppInPlace('));
  vm.runInContext(`${reinstall}\nglobalThis.reinstall = reinstallInstalledApp;`, context);
  await assert.rejects(context.reinstall(), /executable remained after uninstalling.*123/);
  assert.equal(clock, 30000);
});

test('uninstall inspection queries only this app, uses UTF-8, and reports inspection failures', () => {
  let fail = false;
  const context = vm.createContext({
    spawnSync: (_file, args, options) => {
      const command = args.at(-1);
      assert.ok(command.includes("'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'"));
      assert.ok(command.includes("Where-Object { $_.DisplayName -eq 'Tischtennis-Turnier' }"));
      assert.ok(command.includes('[Console]::OutputEncoding'));
      assert.ok(command.includes('Select-Object InstallLocation,PSPath'));
      assert.equal(options.timeout, 10000);
      return fail ? { status: 1, stderr: 'Inspection denied' } : { status: 0, stdout: '{"Registrations":[]}' };
    },
  });
  vm.runInContext(`${uninstallHelpers}\nglobalThis.inspect = describeInstalledAppUninstallState;`, context);
  assert.equal(context.inspect(), '{"Registrations":[]}');
  fail = true;
  assert.match(context.inspect(), /Uninstall inspection failed: Inspection denied/);
});
