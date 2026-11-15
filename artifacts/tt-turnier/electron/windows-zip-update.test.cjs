const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  getZipReleaseVersion,
  pathsOverlap,
  stageAndLaunchWindowsZipUpdate,
  verifyChecksumText,
  verifyZipChecksum,
} = require('./windows-zip-update.cjs');

test('recognizes only supported Windows ZIP filenames', () => {
  assert.equal(getZipReleaseVersion('Tischtennis-Turnier-1.3.0-x64-signed.zip'), '1.3.0');
  assert.equal(getZipReleaseVersion('Tischtennis-Turnier-1.3.0-x64-unsigned.zip'), '1.3.0');
  assert.equal(getZipReleaseVersion('Tischtennis-Turnier-latest-x64-unsigned.zip'), null);
  assert.equal(getZipReleaseVersion('other-app-1.3.0-x64-unsigned.zip'), null);
});

test('requires a matching SHA-256 checksum and filename', () => {
  const fileName = 'Tischtennis-Turnier-1.3.0-x64-unsigned.zip';
  const hash = 'a'.repeat(64);
  assert.equal(verifyChecksumText(`${hash}  ${fileName}\n`, fileName, hash), true);
  assert.equal(verifyChecksumText(`${hash}  another.zip\n`, fileName, hash), false);
  assert.equal(verifyChecksumText(`${hash}  ${fileName}\nextra\n`, fileName, hash), false);
  assert.equal(verifyChecksumText(`${'b'.repeat(64)}  ${fileName}\n`, fileName, hash), false);
});

test('does not stage folders that overlap the running app', () => {
  assert.equal(pathsOverlap('/apps/current', '/apps/current'), true);
  assert.equal(pathsOverlap('/apps/current', '/apps/current/new-version'), true);
  assert.equal(pathsOverlap('/apps/current/new-version', '/apps/current'), true);
  assert.equal(pathsOverlap('/apps/current', '/apps/new-version'), false);
});

test('checks an adjacent checksum file against the ZIP bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-turnier-zip-checksum-'));
  const zipPath = path.join(directory, 'Tischtennis-Turnier-1.3.0-x64-unsigned.zip');
  const bytes = Buffer.from('test zip bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  try {
    await fs.writeFile(zipPath, bytes);
    await fs.writeFile(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);
    assert.equal(await verifyZipChecksum(zipPath), '1.3.0');
    await fs.writeFile(`${zipPath}.sha256`, `${hash}  another.zip\n`);
    await assert.rejects(() => verifyZipChecksum(zipPath), /Prüfsumme fehlt, ist ungültig oder passt nicht/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('validates a staged version before launch while preserving the old app', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-turnier-zip-stage-'));
  const currentDirectory = path.join(directory, 'old-version');
  const targetDirectory = path.join(directory, 'new-versions');
  const zipPath = path.join(targetDirectory, 'Tischtennis-Turnier-1.3.0-x64-unsigned.zip');
  const zipBytes = Buffer.from('test zip bytes');
  const hash = createHash('sha256').update(zipBytes).digest('hex');
  const oldExecutable = path.join(currentDirectory, 'Tischtennis-Turnier.exe');
  let openedPath;
  try {
    await fs.mkdir(currentDirectory, { recursive: true });
    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.writeFile(oldExecutable, 'old app');
    await fs.writeFile(zipPath, zipBytes);
    await fs.writeFile(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);

    const result = await stageAndLaunchWindowsZipUpdate({
      zipPath,
      parentDirectory: targetDirectory,
      currentVersion: '1.2.0',
      currentExecutable: oldExecutable,
      platform: 'win32',
      extractZip: async (_archivePath, destinationPath) => {
        const appRoot = path.join(destinationPath, 'Tischtennis-Turnier-win32-x64');
        const executable = path.join(appRoot, 'Tischtennis-Turnier.exe');
        await fs.mkdir(path.join(appRoot, 'resources', 'app.asar'), { recursive: true });
        await fs.writeFile(executable, 'new app');
        await fs.writeFile(
          path.join(appRoot, 'resources', 'app.asar', 'package.json'),
          JSON.stringify({ version: '1.3.0' }),
        );
      },
      openPath: async (filePath) => { openedPath = filePath; return ''; },
    });

    assert.equal(result.status, 'started');
    assert.equal(result.version, '1.3.0');
    assert.equal(openedPath, path.join(result.folder, 'Tischtennis-Turnier-win32-x64', 'Tischtennis-Turnier.exe'));
    assert.equal(await fs.readFile(oldExecutable, 'utf8'), 'old app');
    assert.equal(await fs.readFile(openedPath, 'utf8'), 'new app');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('rejects an invalid package version and does not launch it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-turnier-zip-invalid-'));
  const currentDirectory = path.join(directory, 'old-version');
  const targetDirectory = path.join(directory, 'new-versions');
  const zipPath = path.join(targetDirectory, 'Tischtennis-Turnier-1.3.0-x64-unsigned.zip');
  const zipBytes = Buffer.from('test zip bytes');
  const hash = createHash('sha256').update(zipBytes).digest('hex');
  let launched = false;
  try {
    await fs.mkdir(currentDirectory, { recursive: true });
    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.writeFile(zipPath, zipBytes);
    await fs.writeFile(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);
    await assert.rejects(() => stageAndLaunchWindowsZipUpdate({
      zipPath,
      parentDirectory: targetDirectory,
      currentVersion: '1.2.0',
      currentExecutable: path.join(currentDirectory, 'Tischtennis-Turnier.exe'),
      platform: 'win32',
      extractZip: async (_archivePath, destinationPath) => {
        const appRoot = path.join(destinationPath, 'App');
        await fs.mkdir(path.join(appRoot, 'resources', 'app.asar'), { recursive: true });
        await fs.writeFile(path.join(appRoot, 'Tischtennis-Turnier.exe'), 'new app');
        await fs.writeFile(
          path.join(appRoot, 'resources', 'app.asar', 'package.json'),
          JSON.stringify({ version: '9.9.9' }),
        );
      },
      openPath: async () => { launched = true; return ''; },
    }), /nennt Version 1\.3\.0, enthält aber App-Version 9\.9\.9/);
    assert.equal(launched, false);
    const remainingEntries = await fs.readdir(targetDirectory);
    assert.deepEqual(remainingEntries.sort(), [
      path.basename(zipPath),
      `${path.basename(zipPath)}.sha256`,
    ].sort());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
