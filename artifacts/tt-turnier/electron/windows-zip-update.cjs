const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { isNewerVersion, parseVersion } = require('./update-check.cjs');

const execFileAsync = promisify(execFile);
const ZIP_RELEASE = /^Tischtennis-Turnier-(\d+\.\d+\.\d+)-x64-(?:signed|unsigned)\.zip$/;

function getZipReleaseVersion(fileName) {
  const match = typeof fileName === 'string' ? fileName.match(ZIP_RELEASE) : null;
  return match && parseVersion(match[1]) ? match[1] : null;
}

function verifyChecksumText(checksumText, fileName, actualHash) {
  if (typeof checksumText !== 'string') return false;
  const normalizedChecksum = checksumText.endsWith('\r\n')
    ? checksumText.slice(0, -2)
    : checksumText.endsWith('\n')
      ? checksumText.slice(0, -1)
      : checksumText;
  if (/[\r\n]/.test(normalizedChecksum)) return false;
  const match = normalizedChecksum.match(/^([0-9a-fA-F]{64})  ([^\r\n]+)$/);
  return Boolean(
    match
    && match[2] === fileName
    && match[1].toLowerCase() === actualHash.toLowerCase(),
  );
}

async function verifyZipChecksum(zipPath) {
  const checksumPath = `${zipPath}.sha256`;
  let checksumText;
  try {
    await fs.access(zipPath);
  } catch {
    throw new Error('Die ausgewählte Windows-ZIP konnte nicht gelesen werden.');
  }
  try {
    checksumText = await fs.readFile(checksumPath, 'utf8');
  } catch {
    throw new Error('Die passende .sha256-Datei fehlt. Lege ZIP und Prüfsumme in denselben Ordner.');
  }
  const fileName = path.basename(zipPath);
  const hasher = createHash('sha256');
  try {
    for await (const chunk of createReadStream(zipPath)) hasher.update(chunk);
  } catch {
    throw new Error('Die ausgewählte Windows-ZIP konnte nicht vollständig gelesen werden.');
  }
  const actualHash = hasher.digest('hex');
  if (!verifyChecksumText(checksumText, fileName, actualHash)) {
    throw new Error('Die ZIP-Prüfsumme fehlt, ist ungültig oder passt nicht zur ausgewählten ZIP-Datei.');
  }
  return getZipReleaseVersion(fileName);
}

function pathsOverlap(firstPath, secondPath) {
  const first = path.resolve(firstPath).toLowerCase();
  const second = path.resolve(secondPath).toLowerCase();
  const isWithin = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  return isWithin(first, second) || isWithin(second, first);
}

async function extractWindowsZip(zipPath, destinationPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression',
    '$archive = [System.IO.Compression.ZipFile]::OpenRead($env:TT_TURNIER_UPDATE_ZIP)',
    'try {',
    '  $root = [IO.Path]::GetFullPath($env:TT_TURNIER_UPDATE_DESTINATION).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar',
    '  foreach ($entry in $archive.Entries) {',
    "    $relative = $entry.FullName.Replace('/', '\\')",
    '    if ([IO.Path]::IsPathRooted($relative) -or $relative -match "(^|\\\\)\\.\\.(\\\\|$)") { throw "The ZIP contains an unsafe path." }',
    '    if (($entry.ExternalAttributes -band 0xF000) -eq 0xA000) { throw "The ZIP contains a symbolic link." }',
    '    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relative))',
    '    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "The ZIP contains an unsafe path." }',
    '  }',
    '} finally { $archive.Dispose() }',
    'Expand-Archive -LiteralPath $env:TT_TURNIER_UPDATE_ZIP -DestinationPath $env:TT_TURNIER_UPDATE_DESTINATION',
  ].join('\n');
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      TT_TURNIER_UPDATE_ZIP: zipPath,
      TT_TURNIER_UPDATE_DESTINATION: destinationPath,
    },
  });
}

async function stageAndLaunchWindowsZipUpdate({
  zipPath,
  parentDirectory,
  currentVersion,
  currentExecutable,
  openPath,
  platform = process.platform,
  extractZip = extractWindowsZip,
}) {
  if (platform !== 'win32') return { status: 'unsupported' };
  const latestVersion = await verifyZipChecksum(zipPath);
  if (!latestVersion) {
    throw new Error('Der Dateiname gehört nicht zu einer unterstützten Tischtennis-Turnier-Windows-ZIP.');
  }
  if (!isNewerVersion(latestVersion, currentVersion)) {
    throw new Error(`Die ausgewählte ZIP-Version ${latestVersion} ist nicht neuer als Version ${currentVersion}.`);
  }

  const appDirectory = path.dirname(currentExecutable);
  const destinationPath = path.join(parentDirectory, `Tischtennis-Turnier-${latestVersion}`);
  if (pathsOverlap(appDirectory, destinationPath)) {
    throw new Error('Bitte wähle einen Zielordner außerhalb des Ordners der aktuell gestarteten App.');
  }
  try {
    await fs.access(destinationPath);
    throw new Error(`Der Zielordner für Version ${latestVersion} ist bereits vorhanden. Wähle einen anderen Zielordner.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const stagingPath = await fs.mkdtemp(path.join(parentDirectory, `.tt-turnier-update-${latestVersion}-`));
  try {
    try {
      await extractZip(zipPath, stagingPath);
    } catch {
      throw new Error('Die ZIP konnte nicht sicher und vollständig entpackt werden. Die bisherige App bleibt unverändert.');
    }
    const executablePaths = [];
    async function findExecutables(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await findExecutables(entryPath);
        else if (entry.isFile() && entry.name === 'Tischtennis-Turnier.exe') executablePaths.push(entryPath);
      }
    }
    await findExecutables(stagingPath);
    if (executablePaths.length !== 1) {
      throw new Error('Die ZIP muss genau eine Tischtennis-Turnier.exe enthalten. Die bisherige App bleibt unverändert.');
    }

    const executablePath = executablePaths[0];
    const packagePath = path.join(path.dirname(executablePath), 'resources', 'app.asar', 'package.json');
    let packagedApplication;
    try {
      packagedApplication = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    } catch {
      throw new Error('Die App-Dateien in der ZIP sind unvollständig oder beschädigt. Die bisherige App bleibt verfügbar.');
    }
    if (packagedApplication.version !== latestVersion) {
      throw new Error(`Die ZIP nennt Version ${latestVersion}, enthält aber App-Version ${packagedApplication.version ?? 'unbekannt'}.`);
    }

    await fs.rename(stagingPath, destinationPath);
    const relativeExecutablePath = path.relative(stagingPath, executablePath);
    const stagedExecutable = path.join(destinationPath, relativeExecutablePath);
    const launchError = await openPath(stagedExecutable);
    if (launchError) {
      return {
        status: 'launch-failed',
        version: latestVersion,
        folder: destinationPath,
        message: launchError,
      };
    }
    return { status: 'started', version: latestVersion, folder: destinationPath };
  } finally {
    await fs.rm(stagingPath, { recursive: true, force: true });
  }
}

module.exports = {
  extractWindowsZip,
  getZipReleaseVersion,
  pathsOverlap,
  stageAndLaunchWindowsZipUpdate,
  verifyChecksumText,
  verifyZipChecksum,
};
