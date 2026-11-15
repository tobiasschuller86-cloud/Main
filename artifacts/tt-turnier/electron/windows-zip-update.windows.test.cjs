const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { extractWindowsZip } = require('./windows-zip-update.cjs');

const windowsOnly = { skip: process.platform !== 'win32' };

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-turnier-zip-extract-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('extracts an intact archive using the Windows update extractor', windowsOnly, async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const zipPath = path.join(directory, 'valid.zip');
    const destination = path.join(directory, 'destination');
    await fs.mkdir(sourceDirectory);
    await fs.mkdir(destination);
    await fs.writeFile(path.join(sourceDirectory, 'update-marker.txt'), 'complete update');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Compress-Archive -Path (Join-Path $env:TT_TEST_SOURCE '*') -DestinationPath $env:TT_TEST_ZIP",
    ], {
      windowsHide: true,
      env: { ...process.env, TT_TEST_SOURCE: sourceDirectory, TT_TEST_ZIP: zipPath },
    });

    await extractWindowsZip(zipPath, destination);
    assert.equal(await fs.readFile(path.join(destination, 'update-marker.txt'), 'utf8'), 'complete update');
  });
});

test('rejects archives containing paths outside the selected update folder', windowsOnly, async () => {
  await withTemporaryDirectory(async (directory) => {
    const zipPath = path.join(directory, 'unsafe.zip');
    const destination = path.join(directory, 'destination');
    const outsideFile = path.join(directory, 'escaped.txt');
    await fs.mkdir(destination);
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "Add-Type -AssemblyName System.IO.Compression",
        "$archive = [System.IO.Compression.ZipFile]::Open($env:TT_TEST_ZIP, [System.IO.Compression.ZipArchiveMode]::Create)",
        "try { $entry = $archive.CreateEntry('..\\escaped.txt'); $writer = [IO.StreamWriter]::new($entry.Open()); $writer.Write('outside'); $writer.Dispose() } finally { $archive.Dispose() }",
      ].join('; '),
    ], {
      windowsHide: true,
      env: { ...process.env, TT_TEST_ZIP: zipPath },
    });

    await assert.rejects(() => extractWindowsZip(zipPath, destination));
    await assert.rejects(() => fs.access(outsideFile), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(destination), []);
  });
});
