import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';

const zipUpdateSmoke = process.argv[2] === '--zip-update';
const zipIsolationSmoke = process.argv[2] === '--zip-isolated';
const zipExistingSmoke = process.argv[2] === '--zip-existing';
const zipReturnSmoke = process.argv[2] === '--zip-return';
const zipSecondReturnSmoke = process.argv[2] === '--zip-second-return';
const zipLongPathSmoke = process.argv[2] === '--zip-long-path';
const windowsSessionSaveSmoke = process.argv[2] === '--windows-session-save';
const windowsSessionResumeSmoke = process.argv[2] === '--windows-session-resume';
const windowsSessionSmoke = windowsSessionSaveSmoke || windowsSessionResumeSmoke;
const zipSmoke =
  process.argv[2] === '--zip' ||
  zipUpdateSmoke ||
  zipIsolationSmoke ||
  zipExistingSmoke ||
  zipReturnSmoke ||
  zipSecondReturnSmoke ||
  zipLongPathSmoke;
const standardUserSmoke = process.argv.includes('--standard-user');
const unicodeProfileSmoke = process.argv.includes('--unicode-profile');
let executablePath = zipSmoke || windowsSessionSmoke ? process.argv[3] : process.argv[2];
const updatedZipExecutablePath = zipUpdateSmoke ? process.argv[4] : undefined;
const installerPath = zipSmoke ? undefined : process.argv[3];
const installDirectory = zipSmoke ? undefined : process.argv[4];
const alternateInstallDirectory = zipSmoke ? undefined : process.argv[5];
if (
  !executablePath ||
  (windowsSessionSaveSmoke && windowsSessionResumeSmoke) ||
  (zipUpdateSmoke && !updatedZipExecutablePath) ||
  (zipLongPathSmoke && (standardUserSmoke || unicodeProfileSmoke)) ||
  ((zipExistingSmoke || zipReturnSmoke || zipSecondReturnSmoke) && !standardUserSmoke) ||
  (standardUserSmoke && !(zipSmoke || windowsSessionSmoke)) ||
  (unicodeProfileSmoke && !zipSmoke) ||
  (unicodeProfileSmoke && !standardUserSmoke) ||
  (!zipSmoke &&
    !windowsSessionSmoke &&
    (!installerPath || !installDirectory || !alternateInstallDirectory))
) {
  throw new Error(
    'Pass --zip, --zip-existing, --zip-return, or --zip-second-return with an extracted ZIP executable path as applicable; --zip-long-path with a near-limit path; --zip-update with old and new ZIP executable paths; --windows-session-save or --windows-session-resume with an installed executable path; or the installed executable path, installer path, and two install directories. Standard-user modes require --standard-user; --unicode-profile also requires --zip.',
  );
}
if (zipLongPathSmoke && (executablePath.length < 240 || executablePath.length > 259)) {
  throw new Error(
    `The near-limit ZIP smoke test requires an executable path between 240 and 259 characters; received ${executablePath.length}.`,
  );
}
if (
  !zipSmoke &&
  !windowsSessionSmoke &&
  resolve(installDirectory).toLowerCase() === resolve(alternateInstallDirectory).toLowerCase()
) {
  throw new Error('The alternate Windows install directory must differ from the initial directory.');
}

const debuggingPort = 9222;
const debuggingUrl = `http://127.0.0.1:${debuggingPort}`;
const startupTimeoutMs = 60_000;
let savedTournamentName = 'Windows restart smoke tournament';
const savedPairs = [
  ['Smoke Herren', 'Smoke Damen'],
  ['Smoke Herren Zwei', 'Smoke Damen Zwei'],
];
const savedPlayerNames = savedPairs.flat();
const savedMatchSets = [{ p1: 11, p2: 7 }, { p1: 11, p2: 8 }];
const firstAccountTournamentName = savedTournamentName;
const firstAccountPlayerNames = [...savedPlayerNames];
const secondAccountTournamentName = 'Second Windows account smoke tournament';
const secondAccountPlayerNames = [
  'Second account Herren',
  'Second account Damen',
  'Second account Herren Zwei',
  'Second account Damen Zwei',
];
let recoveryTournamentName;
let savedMatchSnapshot;
let savedMatchesSnapshot;
let preUpdateBackup;
let preUpdateBackupDirectory;

function activeTournamentExpression() {
  return `(() => {
    const index = JSON.parse(localStorage.getItem('tt-turnier-workspaces-v1') || 'null');
    const activeId = index?.activeId;
    const key = activeId
      ? 'tt-turnier-tournament-v1-' + encodeURIComponent(activeId)
      : 'tt-turnier-state-v2';
    return JSON.parse(localStorage.getItem(key) || 'null');
  })()`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyStandardUserContext() {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not verify the ZIP smoke test user context: ${result.stderr}`);
  }
  const isAdministrator = result.stdout.trim().toLowerCase();
  if (isAdministrator !== 'false') {
    throw new Error(
      `The standalone ZIP smoke test requires a non-administrator user; the current token reports ${JSON.stringify(result.stdout.trim())}.`,
    );
  }
  console.log('The standalone ZIP smoke test is running with a non-administrator token.');
}

async function prepareStandardUserProfile() {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('UserProfile') | ConvertTo-Json -Compress",
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16_384 });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not resolve the actual Windows account profile: ${result.error?.message || result.stderr}`);
  }
  const profile = JSON.parse(result.stdout.trim());
  if (typeof profile !== 'string' || !win32.isAbsolute(profile) || !(await stat(profile)).isDirectory()) {
    throw new Error('Windows did not return an existing absolute profile directory for the test account.');
  }
  // Start-Process -Credential loads the account but can inherit the caller's
  // USERPROFILE and AppData variables. These accounts are fresh CI accounts
  // with default Windows folders, not redirected production user profiles.
  const roaming = win32.join(profile, 'AppData', 'Roaming');
  const local = win32.join(profile, 'AppData', 'Local');
  const temporary = win32.join(local, 'Temp');
  for (const directory of [roaming, local, temporary]) await mkdir(directory, { recursive: true });
  Object.assign(process.env, {
    USERPROFILE: profile, APPDATA: roaming, LOCALAPPDATA: local,
    TEMP: temporary, TMP: temporary, HOME: profile,
  });
  console.log('Prepared app-data and temporary folders in the actual standard Windows account profile.');
}

async function verifyUnicodeProfileContext() {
  const profilePath = process.env.USERPROFILE;
  if (!profilePath || !/[^\u0000-\u007f]/u.test(profilePath)) {
    throw new Error(
      `The Unicode-profile ZIP smoke test requires a Windows USERPROFILE path containing non-ASCII characters; received ${JSON.stringify(profilePath)}.`,
    );
  }
  const profile = await stat(profilePath);
  if (!profile.isDirectory()) {
    throw new Error('The Unicode Windows user profile path is not a directory.');
  }
  console.log('The standalone ZIP smoke test is running from a Unicode Windows user profile.');
}

function launchApp() {
  const appProcess = spawn(
    executablePath,
    [
      '--headless',
      '--disable-gpu',
      '--enable-logging=stderr',
      `--remote-debugging-port=${debuggingPort}`,
      '--no-first-run',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  appProcess.startupDiagnostics = '';
  for (const stream of [appProcess.stdout, appProcess.stderr]) {
    stream.on('data', (chunk) => {
      appProcess.startupDiagnostics = `${appProcess.startupDiagnostics}${chunk}`.slice(-8_000);
    });
  }
  appProcess.on('error', (error) => {
    appProcess.launchError = error;
  });
  return appProcess;
}

async function findAppPage() {
  const response = await fetch(`${debuggingUrl}/json/list`, {
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) return null;

  const targets = await response.json();
  return targets.find(
    (target) =>
      target.type === 'page' &&
      target.url.startsWith('ttturnier://app/') &&
      target.webSocketDebuggerUrl,
  );
}

const devtoolsConnections = new Map();

function sendDevtoolsCommand(webSocketUrl, method, params = {}) {
  let connection = devtoolsConnections.get(webSocketUrl);
  if (!connection || connection.socket.readyState > 1) {
    const socket = new WebSocket(webSocketUrl);
    connection = { socket, pending: new Map(), nextId: 1 };
    const current = connection;
    current.fail = (error) => {
      if (devtoolsConnections.get(webSocketUrl) === current) devtoolsConnections.delete(webSocketUrl);
      for (const request of current.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      current.pending.clear();
      if (socket.readyState < 2) socket.close();
    };
    current.send = (request) => {
      try {
        socket.send(JSON.stringify(request.command));
      } catch (error) {
        current.fail(error);
      }
    };
    devtoolsConnections.set(webSocketUrl, current);
    socket.addEventListener('open', () => {
      current.send({ command: { id: 0, method: 'Page.enable' } });
      for (const request of current.pending.values()) current.send(request);
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        current.fail(new Error('The installed app sent an invalid debugging response.'));
        return;
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        current.fail(new Error(`Unexpected ${message.params?.type} dialog in the Windows smoke test: ${message.params?.message}`));
        return;
      }
      const request = current.pending.get(message.id);
      if (!request) return;
      current.pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(new Error(`The installed app rejected ${request.command.method}: ${message.error.message}`));
      } else {
        request.resolve(message.result);
      }
    });
    socket.addEventListener('error', () => {
      current.fail(new Error('Could not connect to the installed app page.'));
    });
    socket.addEventListener('close', () => {
      current.fail(new Error('The installed app debugging connection closed.'));
    });
  }
  // DOM node IDs belong to this session. Keep it open across document lookup,
  // file-input lookup, and file selection, until the page or process closes.
  return new Promise((resolve, reject) => {
    const command = { id: connection.nextId++, method, params };
    const request = {
      command, resolve, reject,
      timeout: setTimeout(() => {
        connection.fail(new Error(`Timed out while checking the installed app screen during ${method}.`));
      }, 10_000),
    };
    connection.pending.set(command.id, request);
    if (connection.socket.readyState === 1) connection.send(request);
  });
}

async function evaluatePage(webSocketUrl, expression) {
  const response = await sendDevtoolsCommand(webSocketUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    const description = details.exception?.description || details.text || 'Unknown page exception';
    throw new Error(`Could not inspect or control the installed app page: ${String(description).slice(0, 1500)}`);
  }
  return response.result.value;
}

async function waitForAppPage(appProcess) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastDebuggingError;
  while (Date.now() < deadline) {
    if (appProcess.launchError) {
      throw new Error(
        `Could not launch the Windows app from ${executablePath}: ${appProcess.launchError.message}`,
      );
    }
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error(
        `The Windows app at ${executablePath} exited before opening its main screen (exit code ${appProcess.exitCode}, signal ${appProcess.signalCode}). Startup output: ${appProcess.startupDiagnostics}`,
      );
    }

    try {
      const appPage = await findAppPage();
      if (appPage) return appPage;
    } catch (error) {
      // The debugging endpoint is not ready until Electron has started.
      lastDebuggingError = error.message;
    }
    await delay(1_000);
  }

  throw new Error(`The Windows app at ${executablePath} did not open its page within 60 seconds. Debugging endpoint: ${lastDebuggingError || 'reachable, but no app page found'}. Startup output: ${appProcess.startupDiagnostics}. Windows context: ${describeWindowsStartup(appProcess.pid)}`);
}

function describeWindowsStartup(processId) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(processId)) return 'unavailable';
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $target = Get-Process -Id ${processId}
      $dialogText = @()
      try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        if ($target.MainWindowHandle -ne [IntPtr]::Zero) {
          $root = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
          $dialogText = @($root.FindAll(
            [System.Windows.Automation.TreeScope]::Subtree,
            [System.Windows.Automation.Condition]::TrueCondition
          ) | Select-Object -First 30 | ForEach-Object { $_.Current.Name })
        }
      } catch { $dialogText = @('Window inspection unavailable: ' + $_.Exception.Message) }
      @{
        ProcessId = $target.Id
        Responding = $target.Responding
        WindowTitle = $target.MainWindowTitle
        WindowText = $dialogText
        Profile = [Environment]::GetFolderPath('UserProfile')
        AppData = [Environment]::GetFolderPath('ApplicationData')
        EnvironmentProfile = $env:USERPROFILE
        EnvironmentAppData = $env:APPDATA
      } | ConvertTo-Json -Depth 3 -Compress
    `,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 32_768 });
  if (result.error || result.status !== 0) {
    return `inspection failed: ${result.error?.message || result.stderr?.slice(-2_000)}`;
  }
  return result.stdout.trim().slice(-8_000);
}

async function waitForPageValue(webSocketUrl, expression, expected, description) {
  const deadline = Date.now() + 15_000;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluatePage(webSocketUrl, expression);
    if (lastValue === expected) return;
    await delay(250);
  }
  throw new Error(`${description} (last value: ${JSON.stringify(lastValue)}).`);
}

async function stopApp(appProcess, webSocketUrl) {
  if (appProcess.exitCode !== null || appProcess.signalCode !== null) return;
  if (webSocketUrl) {
    try {
      await sendDevtoolsCommand(webSocketUrl, 'Page.close');
    } catch {
      // Fall back to terminating the process if the page cannot close cleanly.
    }
  }
  const gracefulDeadline = Date.now() + 10_000;
  while (
    appProcess.exitCode === null &&
    appProcess.signalCode === null &&
    Date.now() < gracefulDeadline
  ) {
    await delay(100);
  }
  if (appProcess.exitCode !== null || appProcess.signalCode !== null) return;

  const result = spawnSync('taskkill', ['/PID', String(appProcess.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const forcedDeadline = Date.now() + 5_000;
  while (
    appProcess.exitCode === null &&
    appProcess.signalCode === null &&
    Date.now() < forcedDeadline
  ) {
    await delay(100);
  }
  if (appProcess.exitCode === null && appProcess.signalCode === null) {
    throw new Error('The installed app did not exit after being closed.');
  }
}

async function terminateAppAbruptly(appProcess) {
  if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
    throw new Error('The ZIP app exited before the unexpected-termination check.');
  }

  const result = spawnSync('taskkill', ['/PID', String(appProcess.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not terminate the ZIP app without closing its window (exit code ${result.status}).`);
  }

  const forcedDeadline = Date.now() + 5_000;
  while (
    appProcess.exitCode === null &&
    appProcess.signalCode === null &&
    Date.now() < forcedDeadline
  ) {
    await delay(100);
  }
  if (appProcess.exitCode === null && appProcess.signalCode === null) {
    throw new Error('The ZIP app did not exit after forced termination.');
  }
  console.log('The app was terminated without a normal window-close path.');
}

function runInstaller(filePath, args, description) {
  const result = spawnSync(filePath, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${description}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description} (exit code ${result.status}).`);
  }
}

async function reinstallInstalledApp() {
  const uninstallerNames = (await readdir(installDirectory))
    .filter((name) => /^uninstall.*\.exe$/i.test(name));
  if (uninstallerNames.length !== 1) {
    throw new Error(
      `Expected one Windows app uninstaller in ${installDirectory}, found ${uninstallerNames.length}.`,
    );
  }

  console.log(`Uninstalling the app from ${installDirectory} while preserving tournament data.`);
  runInstaller(
    `${installDirectory}\\${uninstallerNames[0]}`,
    ['/S'],
    'The Windows app uninstaller failed',
  );
  const uninstallDeadline = Date.now() + 30_000;
  while (Date.now() < uninstallDeadline) {
    try {
      await stat(executablePath);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    await delay(250);
  }
  try {
    await stat(executablePath);
    throw new Error('The Windows app executable remained after uninstalling.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    await stat(alternateInstallDirectory);
    throw new Error(
      `The alternate Windows install directory already exists: ${alternateInstallDirectory}.`,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  console.log(`Reinstalling the app into the different folder ${alternateInstallDirectory}.`);
  runInstaller(
    installerPath,
    ['/S', `/D=${alternateInstallDirectory}`],
    'The Windows app installer failed during reinstall',
  );
  executablePath = join(alternateInstallDirectory, basename(executablePath));
  await stat(executablePath);
}

async function updateInstalledAppInPlace() {
  console.log(`Installing the current setup over the existing app in ${installDirectory}.`);
  runInstaller(
    installerPath,
    ['/S', `/D=${installDirectory}`],
    'The Windows app installer failed while updating the existing installation',
  );
  await stat(executablePath);
}

async function simulateInterruptedZipExtraction() {
  const oldAppDirectory = dirname(resolve(executablePath));
  const updatedAppDirectory = dirname(resolve(updatedZipExecutablePath));
  if (oldAppDirectory.toLowerCase() === updatedAppDirectory.toLowerCase()) {
    throw new Error('The old and updated ZIP builds must be extracted into different folders.');
  }

  await stat(executablePath);
  await stat(updatedZipExecutablePath);
  const interruptedDirectory = await mkdtemp(join(tmpdir(), 'tt-turnier-incomplete-zip-update-'));
  await writeFile(join(interruptedDirectory, 'partial-extraction.txt'), 'incomplete ZIP extraction');
  console.log(
    `Simulated an interrupted extraction in ${interruptedDirectory}; the old app remains in ${oldAppDirectory}.`,
  );
  return interruptedDirectory;
}

async function fillInput(webSocketUrl, selector, value) {
  await waitForPageValue(
    webSocketUrl,
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    true,
    `The installed app did not display the input ${selector}`,
  );
  const expression = `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('Missing smoke-test input: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`;
  const actualValue = await evaluatePage(webSocketUrl, expression);
  if (actualValue !== value) {
    throw new Error(`Could not enter the smoke-test value in ${selector}.`);
  }
}

async function verifyInitialOverview(webSocketUrl) {
  const deadline = Date.now() + 15_000;
  let screen;
  while (Date.now() < deadline) {
    screen = await evaluatePage(
      webSocketUrl,
      `({
        ready: document.readyState,
        navigation: Boolean(document.querySelector('#main-navigation')),
        storageError: document.querySelector('[data-testid="desktop-storage-error"]')?.textContent || null,
        overview: document.querySelector('main .page-heading .eyebrow')?.textContent.trim() === 'Turnierübersicht'
          && Boolean(document.querySelector('main [data-testid="button-edit-tournament"]'))
      })`,
    );
    if (screen.storageError) throw new Error(`Desktop storage initialization failed: ${screen.storageError}`);
    if (screen.ready === 'complete' && screen.navigation && screen.overview) return;
    await delay(250);
  }
  throw new Error(
    `The installed app did not reach the overview screen within 15 seconds: ${JSON.stringify(screen)}`,
  );
}

async function verifyReleaseNotesLink(webSocketUrl) {
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('The Windows installer smoke test requires a valid GITHUB_REPOSITORY value.');
  }

  const expectedUrl = `https://github.com/${repository}/releases/latest`;
  const link = await evaluatePage(
    webSocketUrl,
    `(() => {
      const element = document.querySelector('[data-testid="link-release-notes"]');
      const retry = document.querySelector('[data-testid="button-check-desktop-update"]');
      return element && {
        href: element.href,
        target: element.target,
        rel: element.rel,
        hasRepeatCheck: Boolean(retry),
      };
    })()`,
  );
  if (
    link?.href !== expectedUrl ||
    link.target !== '_blank' ||
    !link.rel.split(/\\s+/).includes('noreferrer') ||
    !link.hasRepeatCheck
  ) {
    throw new Error(
      `The installed app did not expose the official release notes link for external browsing: ${JSON.stringify(link)}.`,
    );
  }
  console.log(`The installed app exposes ${expectedUrl} as an external release notes link.`);
}

async function prepareSmokeTournament(webSocketUrl) {
  const hasExistingTournament = await evaluatePage(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return Boolean(saved && (saved.name || saved.players?.length || saved.pairs?.length || saved.matches?.length));
    })()`,
  );
  if (!hasExistingTournament) return;
  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"button-new-tournament\"]')?.click()");
  await fillInput(webSocketUrl, '[data-testid="input-new-tournament-name"]', savedTournamentName);
  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"button-create-tournament\"]')?.click()");
  await waitForPageValue(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return saved?.name === ${JSON.stringify(savedTournamentName)}
        && saved.players.length === 0 && saved.pairs.length === 0 && saved.matches.length === 0
        && Boolean(document.querySelector('[data-testid="button-add-first-pair"]'));
    })()`,
    true,
    'The installed app did not create an independent empty smoke tournament',
  );
  console.log('Created a separate smoke tournament without deleting the existing account data.');
}

async function createSmokeTournament(webSocketUrl) {
  await prepareSmokeTournament(webSocketUrl);
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-add-first-pair\"]')?.click()",
  );
  await fillInput(webSocketUrl, '[data-testid="input-pair-man"]', savedPlayerNames[0]);
  await fillInput(webSocketUrl, '[data-testid="input-pair-woman"]', savedPlayerNames[1]);
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-save-pair\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return Boolean(saved?.players?.some((player) => player.name === ${JSON.stringify(savedPlayerNames[0])})
        && saved?.players?.some((player) => player.name === ${JSON.stringify(savedPlayerNames[1])}));
    })()`,
    true,
    'The installed app did not save the registered players',
  );

  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"link-participants\"]')?.click()");
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"button-add-pair\"]'))",
    true,
    'The installed app did not open the pair registration screen',
  );
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-add-pair\"]')?.click()",
  );
  await fillInput(webSocketUrl, '[data-testid="input-pair-man"]', savedPairs[1][0]);
  await fillInput(webSocketUrl, '[data-testid="input-pair-woman"]', savedPairs[1][1]);
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-save-pair\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return saved?.pairs?.length === 2
        && ${JSON.stringify(savedPlayerNames)}.every((name) => saved?.players?.some((player) => player.name === name));
    })()`,
    true,
    'The installed app did not save both registered pairs',
  );

  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"link-groups\"]')?.click()");
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"button-generate-groups\"]'))",
    true,
    'The installed app did not open the group schedule screen',
  );
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-generate-groups\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return Boolean(saved?.matches?.some((match) => match.stage === 'group' && match.round === 1 && !match.isBye));
    })()`,
    true,
    'The installed app did not save a generated group schedule',
  );
  const pendingMatch = await evaluatePage(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      const match = saved?.matches?.find((candidate) =>
        candidate.stage === 'group' && candidate.round === 1 && !candidate.isBye && candidate.status === 'pending');
      if (!match) return null;
      const names = new Map(saved.players.map((player) => [player.id, player.name]));
      return {
        id: match.id,
        side1: match.side1.map((id) => names.get(id)),
        side2: match.side2?.map((id) => names.get(id)) ?? null,
      };
    })()`,
  );
  if (!pendingMatch?.id || pendingMatch.side1.some((name) => !name) || pendingMatch.side2?.some((name) => !name)) {
    throw new Error(`The installed app did not create a playable first-round match: ${JSON.stringify(pendingMatch)}`);
  }
  await evaluatePage(
    webSocketUrl,
    `document.querySelector('[data-testid="button-score-${pendingMatch.id}"]')?.click()`,
  );
  await waitForPageValue(
    webSocketUrl,
    `document.querySelector('[data-testid="score-match-teams"]')?.innerText.includes(${JSON.stringify(pendingMatch.side1.join(' + '))})
      && document.querySelector('[data-testid="score-match-teams"]')?.innerText.includes(${JSON.stringify(pendingMatch.side2.join(' + '))})`,
    true,
    'The installed app did not open the selected scheduled match',
  );
  await fillInput(webSocketUrl, '[data-testid="input-score-set-1"]', '11:7');
  await fillInput(webSocketUrl, '[data-testid="input-score-set-2"]', '11:8');
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-save-score\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      const match = saved?.matches?.find((candidate) => candidate.id === ${JSON.stringify(pendingMatch.id)});
      return match?.status === 'completed'
        && match?.winnerSide === 1
        && JSON.stringify(match?.sets) === ${JSON.stringify(JSON.stringify(savedMatchSets))};
    })()`,
    true,
    'The installed app did not save the completed match result',
  );
  savedMatchSnapshot = await evaluatePage(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      const match = saved?.matches?.find((candidate) => candidate.id === ${JSON.stringify(pendingMatch.id)});
      return match && {
        id: match.id,
        stage: match.stage,
        round: match.round,
        groupId: match.groupId,
        side1: match.side1,
        side2: match.side2,
        status: match.status,
        sets: match.sets,
        winnerSide: match.winnerSide,
      };
    })()`,
  );
  savedMatchesSnapshot = await evaluatePage(
    webSocketUrl,
    `${activeTournamentExpression()}?.matches || null`,
  );
  if (!savedMatchSnapshot || !Array.isArray(savedMatchesSnapshot)) {
    throw new Error('The installed app did not retain the saved schedule and match result.');
  }

  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"link-settings\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"input-tournament-name\"]'))",
    true,
    'The installed app did not open tournament settings',
  );
  await verifyReleaseNotesLink(webSocketUrl);
  await fillInput(
    webSocketUrl,
    '[data-testid="input-tournament-name"]',
    savedTournamentName,
  );
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-save-settings\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    `${activeTournamentExpression()}?.name === ${JSON.stringify(savedTournamentName)}`,
    true,
    'The installed app did not save the tournament name',
  );
}

async function createRecoveryCopyThroughImport(webSocketUrl) {
  recoveryTournamentName = savedTournamentName;
  const currentTournament = await evaluatePage(
    webSocketUrl,
    activeTournamentExpression(),
  );
  if (!currentTournament || currentTournament.name !== recoveryTournamentName) {
    throw new Error('Could not read the saved tournament before testing recovery-copy persistence.');
  }

  const replacementTournamentName = `${recoveryTournamentName} replacement`;
  const backupPath = join(
    await mkdtemp(join(tmpdir(), 'tt-turnier-recovery-smoke-')),
    'replacement-tournament.json',
  );
  await writeFile(
    backupPath,
    JSON.stringify({
      format: 'tt-turnier-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      tournament: { ...currentTournament, name: replacementTournamentName },
    }),
    'utf8',
  );

  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"link-settings\"]')?.click()");
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"button-import-backup\"]'))",
    true,
    'The settings screen did not open before testing recovery-copy persistence',
  );

  const documentResult = await sendDevtoolsCommand(webSocketUrl, 'DOM.getDocument');
  const inputResult = await sendDevtoolsCommand(webSocketUrl, 'DOM.querySelector', {
    nodeId: documentResult.root.nodeId,
    selector: 'input[accept=".json,application/json"]',
  });
  if (!inputResult.nodeId) {
    throw new Error('The backup file input was missing while testing recovery-copy persistence.');
  }
  await sendDevtoolsCommand(webSocketUrl, 'DOM.setFileInputFiles', {
    files: [backupPath],
    nodeId: inputResult.nodeId,
  });
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"button-confirm-backup-import\"]'))",
    true,
    'The replacement backup did not open for confirmation',
  );
  await evaluatePage(
    webSocketUrl,
    `(() => {
      window.confirm = () => true;
      document.querySelector('[data-testid="button-confirm-backup-import"]')?.click();
      return true;
    })()`,
  );
  await waitForPageValue(
    webSocketUrl,
    `${activeTournamentExpression()}?.name === ${JSON.stringify(replacementTournamentName)}`,
    true,
    'The replacement backup was not imported for the recovery-copy check',
  );

  const recoveryContainsOriginal = await evaluatePage(
    webSocketUrl,
    `(() => {
      const stored = JSON.parse(localStorage.getItem('tt-turnier-recovery-v1') || 'null');
      return Array.isArray(stored) && stored.some((copy) => {
        try {
          return JSON.parse(copy.raw)?.tournament?.name === ${JSON.stringify(recoveryTournamentName)};
        } catch {
          return false;
        }
      });
    })()`,
  );
  if (!recoveryContainsOriginal) {
    throw new Error('Replacing a tournament did not save its recovery copy.');
  }
  savedTournamentName = replacementTournamentName;
  await verifyRecoveryCopy(webSocketUrl);
  console.log('The app saved a recovery copy before replacing the tournament.');
}

async function createPreUpdateBackup(webSocketUrl) {
  const tournament = await evaluatePage(webSocketUrl, activeTournamentExpression());
  if (
    !tournament ||
    tournament.name !== savedTournamentName ||
    !savedPlayerNames.every((name) => tournament.players?.some((player) => player.name === name))
  ) {
    throw new Error('Could not verify the tournament and players before exporting the pre-update backup.');
  }

  preUpdateBackupDirectory = await mkdtemp(join(tmpdir(), 'tt-turnier-pre-update-backup-'));
  await sendDevtoolsCommand(webSocketUrl, 'Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: preUpdateBackupDirectory,
  });
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"link-settings\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"button-export-backup\"]'))",
    true,
    'The older app did not show its tournament backup export button',
  );
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-export-backup\"]')?.click()",
  );

  const deadline = Date.now() + 15_000;
  let backupFiles = [];
  while (Date.now() < deadline) {
    backupFiles = (await readdir(preUpdateBackupDirectory)).filter((name) => /\.json$/i.test(name));
    if (backupFiles.length) break;
    await delay(250);
  }
  if (backupFiles.length !== 1) {
    throw new Error(
      `The older app did not download exactly one tournament backup (found ${backupFiles.length}).`,
    );
  }

  const backupPath = join(preUpdateBackupDirectory, backupFiles[0]);
  let backup;
  try {
    backup = JSON.parse(await readFile(backupPath, 'utf8'));
  } catch (error) {
    throw new Error(`The older app's downloaded tournament backup could not be read: ${error.message}`);
  }
  const expected = {
    name: tournament.name,
    playerNames: tournament.players.map((player) => player.name),
  };
  if (
    backup?.format !== 'tt-turnier-backup' ||
    backup?.tournament?.name !== expected.name ||
    !expected.playerNames.every((name) =>
      backup.tournament.players?.some((player) => player.name === name),
    )
  ) {
    throw new Error('The older app exported a backup with a missing tournament or player.');
  }

  console.log(
    `The older app exported ${backupFiles[0]} with tournament "${expected.name}" and ${expected.playerNames.length} players.`,
  );
  return { path: backupPath, expected };
}

async function importPreUpdateBackup(webSocketUrl, backup) {
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"link-settings\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"button-import-backup\"]'))",
    true,
    'The updated app did not show its tournament backup import button',
  );

  const documentResult = await sendDevtoolsCommand(webSocketUrl, 'DOM.getDocument');
  const inputResult = await sendDevtoolsCommand(webSocketUrl, 'DOM.querySelector', {
    nodeId: documentResult.root.nodeId,
    selector: 'input[accept=".json,application/json"]',
  });
  if (!inputResult.nodeId) {
    throw new Error('The updated app did not provide a file input for the pre-update backup.');
  }
  await sendDevtoolsCommand(webSocketUrl, 'DOM.setFileInputFiles', {
    files: [backup.path],
    nodeId: inputResult.nodeId,
  });
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"button-confirm-backup-import\"]'))",
    true,
    'The updated app rejected the pre-update backup or did not open it for confirmation',
  );
  await evaluatePage(
    webSocketUrl,
    `(() => {
      window.confirm = () => true;
      document.querySelector('[data-testid="button-confirm-backup-import"]')?.click();
      return true;
    })()`,
  );

  await waitForPageValue(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      const names = saved?.players?.map((player) => player.name) || [];
      return saved?.name === ${JSON.stringify(backup.expected.name)}
        && ${JSON.stringify(backup.expected.playerNames)}.every((name) => names.includes(name));
    })()`,
    true,
    'The updated app did not import the pre-update tournament and all its players',
  );
  const imported = await evaluatePage(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return { name: saved?.name, playerNames: saved?.players?.map((player) => player.name) || [] };
    })()`,
  );
  if (
    imported.name !== backup.expected.name ||
    !backup.expected.playerNames.every((name) => imported.playerNames.includes(name))
  ) {
    throw new Error(
      `The updated app did not retain the imported tournament and all its players: ${JSON.stringify(imported)}.`,
    );
  }
  savedTournamentName = backup.expected.name;
  await waitForPageValue(
    webSocketUrl,
    `document.body.innerText.includes(${JSON.stringify(backup.expected.name)})`,
    true,
    'The updated app did not display the tournament imported from the pre-update backup',
  );
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"link-participants\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    `${JSON.stringify(backup.expected.playerNames)}.every((name) => document.body.innerText.includes(name))`,
    true,
    'The updated app did not display all players imported from the pre-update backup',
  );
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"link-overview\"]')?.click()",
  );
  console.log('The updated app imported and displayed the older backup tournament and all its players.');
}

async function verifyRecoveryCopy(webSocketUrl, { restore = false } = {}) {
  const hasRecovery = await evaluatePage(
    webSocketUrl,
    `(() => {
      const stored = JSON.parse(localStorage.getItem('tt-turnier-recovery-v1') || 'null');
      return Array.isArray(stored) && stored.some((copy) => {
        try {
          return JSON.parse(copy.raw)?.tournament?.name === ${JSON.stringify(recoveryTournamentName)};
        } catch {
          return false;
        }
      });
    })()`,
  );
  if (!hasRecovery) {
    throw new Error('The tournament recovery copy was missing after restarting or replacing the app.');
  }

  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"link-settings\"]')?.click()");
  await waitForPageValue(
    webSocketUrl,
    "Boolean(document.querySelector('[data-testid=\"recovery-history\"] [data-testid=\"button-preview-recovery-0\"]'))",
    true,
    'The saved recovery copy was not available in the recovery history',
  );
  await evaluatePage(
    webSocketUrl,
    "document.querySelector('[data-testid=\"button-preview-recovery-0\"]')?.click()",
  );
  await waitForPageValue(
    webSocketUrl,
    `document.querySelector('.app-dialog .metric-value')?.textContent.trim() === ${JSON.stringify(recoveryTournamentName)}`,
    true,
    'The saved recovery copy could not be previewed after restarting or replacing the app',
  );
  if (restore) {
    const replacedTournamentName = savedTournamentName;
    await evaluatePage(
      webSocketUrl,
      `(() => {
        window.confirm = () => true;
        document.querySelector('[data-testid="button-confirm-backup-import"]')?.click();
      })()`,
    );
    await waitForPageValue(
      webSocketUrl,
      `${activeTournamentExpression()}?.name === ${JSON.stringify(recoveryTournamentName)}`,
      true,
      'The updated app could preview but not load the saved recovery copy',
    );
    savedTournamentName = recoveryTournamentName;
    // Restoring saves the replaced active tournament as the newest recovery copy.
    recoveryTournamentName = replacedTournamentName;
  } else {
    await evaluatePage(
      webSocketUrl,
      "document.querySelector('[data-testid=\"button-cancel-backup-preview\"]')?.click()",
    );
  }
}

async function restoreRecoveryCopyAfterUpdate(webSocketUrl) {
  await verifyRecoveryCopy(webSocketUrl, { restore: true });
  await verifyTournamentAfterRestart(webSocketUrl);
  console.log('The updated app loaded the pre-update recovery copy with its players, schedule, and completed match result.');
}

async function verifyTournamentAfterRestart(webSocketUrl) {
  if (!savedMatchSnapshot) {
    const savedTournament = await evaluatePage(webSocketUrl, activeTournamentExpression());
    const completedMatch = savedTournament?.matches?.find(
      (match) => match.stage === 'group' && match.status === 'completed' && !match.isBye,
    );
    if (
      !completedMatch ||
      JSON.stringify(completedMatch.sets) !== JSON.stringify(savedMatchSets) ||
      completedMatch.winnerSide !== 1
    ) {
      throw new Error('The saved tournament was missing its completed group match result.');
    }
    savedMatchSnapshot = {
      id: completedMatch.id,
      stage: completedMatch.stage,
      round: completedMatch.round,
      groupId: completedMatch.groupId,
      side1: completedMatch.side1,
      side2: completedMatch.side2,
      status: completedMatch.status,
      sets: completedMatch.sets,
      winnerSide: completedMatch.winnerSide,
    };
    savedMatchesSnapshot = savedTournament.matches;
  }

  const savedState = await evaluatePage(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return {
        name: saved?.name,
        players: saved?.players?.map((player) => player.name) || [],
        pairs: saved?.pairs?.length || 0,
        matches: saved?.matches || null,
        match: saved?.matches?.find((candidate) => candidate.id === ${JSON.stringify(savedMatchSnapshot?.id)}) && (() => {
          const match = saved.matches.find((candidate) => candidate.id === ${JSON.stringify(savedMatchSnapshot?.id)});
          return {
            id: match.id,
            stage: match.stage,
            round: match.round,
            groupId: match.groupId,
            side1: match.side1,
            side2: match.side2,
            status: match.status,
            sets: match.sets,
            winnerSide: match.winnerSide,
          };
        })(),
        matchPlayerNames: saved?.matches?.find((candidate) => candidate.id === ${JSON.stringify(savedMatchSnapshot?.id)}) && (() => {
          const match = saved.matches.find((candidate) => candidate.id === ${JSON.stringify(savedMatchSnapshot?.id)});
          const names = new Map(saved.players.map((player) => [player.id, player.name]));
          return {
            side1: match.side1.map((id) => names.get(id)),
            side2: match.side2?.map((id) => names.get(id)) ?? null,
          };
        })(),
      };
    })()`,
  );
  if (
    savedState.name !== savedTournamentName ||
    !savedPlayerNames.every((name) => savedState.players.includes(name)) ||
    savedState.pairs !== savedPairs.length ||
    JSON.stringify(savedState.matches) !== JSON.stringify(savedMatchesSnapshot) ||
    !savedMatchSnapshot ||
    JSON.stringify(savedState.match) !== JSON.stringify(savedMatchSnapshot)
  ) {
    throw new Error(
      `Tournament or completed match data was missing after restarting the installed app: ${JSON.stringify(savedState)}`,
    );
  }

  await waitForPageValue(
    webSocketUrl,
    `document.body.innerText.includes(${JSON.stringify(savedTournamentName)})`,
    true,
    'The reopened app did not display the saved tournament',
  );
  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"link-groups\"]')?.click()");
  await waitForPageValue(
    webSocketUrl,
    `(() => {
      const row = document.querySelector('[data-testid="match-${savedMatchSnapshot.id}"]');
      return Boolean(row
        && ${JSON.stringify(savedState.matchPlayerNames.side1)}.every((name) => row.innerText.includes(name))
        && ${JSON.stringify(savedState.matchPlayerNames.side2)}.every((name) => row.innerText.includes(name))
        && row.innerText.includes('11:7')
        && row.innerText.includes('11:8'));
    })()`,
    true,
    'The reopened app did not display the saved match and its result',
  );
  await verifyRecoveryCopy(webSocketUrl);
}

async function verifyTournamentAfterWindowsSessionRestart(webSocketUrl) {
  const savedState = await evaluatePage(
    webSocketUrl,
    `(() => {
      const saved = ${activeTournamentExpression()};
      return {
        name: saved?.name,
        players: saved?.players?.map((player) => player.name) || [],
      };
    })()`,
  );
  if (
    savedState.name !== savedTournamentName ||
    !savedPlayerNames.every((name) => savedState.players.includes(name))
  ) {
    throw new Error(
      `The tournament or its players were missing after the Windows profile session restarted: ${JSON.stringify(savedState)}.`,
    );
  }

  await waitForPageValue(
    webSocketUrl,
    `document.body.innerText.includes(${JSON.stringify(savedTournamentName)})`,
    true,
    'The reopened app did not display the tournament after the Windows profile session restarted',
  );
  await evaluatePage(webSocketUrl, "document.querySelector('[data-testid=\"link-participants\"]')?.click()");
  await waitForPageValue(
    webSocketUrl,
    `${JSON.stringify(savedPlayerNames)}.every((name) => document.body.innerText.includes(name))`,
    true,
    'The reopened app did not display every saved player after the Windows profile session restarted',
  );
  console.log('The reopened app displayed the saved tournament and all players after the Windows profile session restarted.');
}

async function verifyFirstUsersTournamentIsNotVisible(webSocketUrl) {
  const result = await evaluatePage(
    webSocketUrl,
    `(() => {
      const privateValues = [${JSON.stringify(firstAccountTournamentName)}, ...${JSON.stringify(firstAccountPlayerNames)}];
      const storedValues = Object.entries(localStorage)
        .filter(([key]) => key === 'tt-turnier-state-v2'
          || key === 'tt-turnier-state-v1'
          || key === 'tt-turnier-recovery-v1'
          || key === 'tt-turnier-workspaces-v1'
          || key.startsWith('tt-turnier-tournament-v1-'))
        .map(([, value]) => value);
      const visibleText = document.body.innerText;
      return {
        storedMatches: privateValues.filter((value) => storedValues.some((stored) => stored.includes(value))),
        visibleMatches: privateValues.filter((value) => visibleText.includes(value)),
      };
    })()`,
  );
  if (result.storedMatches.length || result.visibleMatches.length) {
    throw new Error(
      `A second Windows account can see the first account's tournament data: ${JSON.stringify(result)}.`,
    );
  }
  console.log('The second standard Windows account cannot see the first account’s saved tournament or players.');
}

async function verifySecondUsersTournamentIsNotVisible(webSocketUrl) {
  const result = await evaluatePage(
    webSocketUrl,
    `(() => {
      const privateValues = [${JSON.stringify(secondAccountTournamentName)}, ...${JSON.stringify(secondAccountPlayerNames)}];
      const storedValues = Object.entries(localStorage)
        .filter(([key]) => key === 'tt-turnier-state-v2'
          || key === 'tt-turnier-state-v1'
          || key === 'tt-turnier-recovery-v1'
          || key === 'tt-turnier-workspaces-v1'
          || key.startsWith('tt-turnier-tournament-v1-'))
        .map(([, value]) => value);
      const visibleText = document.body.innerText;
      return {
        storedMatches: privateValues.filter((value) => storedValues.some((stored) => stored.includes(value))),
        visibleMatches: privateValues.filter((value) => visibleText.includes(value)),
      };
    })()`,
  );
  if (result.storedMatches.length || result.visibleMatches.length) {
    throw new Error(
      `The first Windows account can see the second account's tournament data: ${JSON.stringify(result)}.`,
    );
  }
}

let appProcess;
let appPage;
let incompleteUpdateDirectory;
try {
  if (zipLongPathSmoke) {
    try {
      await stat(executablePath);
    } catch (error) {
      throw new Error(
        `The near-limit ZIP executable could not be accessed at ${executablePath}: ${error.message}`,
      );
    }
    console.log(
      `Testing a standalone ZIP executable path ${executablePath.length} characters long (traditional Windows limit: 260).`,
    );
  }
  if (standardUserSmoke) {
    verifyStandardUserContext();
    await prepareStandardUserProfile();
  }
  if (unicodeProfileSmoke) await verifyUnicodeProfileContext();
  appProcess = launchApp();
  appPage = await waitForAppPage(appProcess);
  await verifyInitialOverview(appPage.webSocketDebuggerUrl);

  if (zipSmoke) {
    console.log(
      `The standalone ZIP app launched from ${executablePath} and displayed the initial tournament overview.`,
    );
    if (zipIsolationSmoke) {
      if (!standardUserSmoke) {
        throw new Error('The ZIP account-isolation smoke test requires a standard Windows user.');
      }
      await verifyFirstUsersTournamentIsNotVisible(appPage.webSocketDebuggerUrl);
      savedTournamentName = secondAccountTournamentName;
      savedPairs[0] = [secondAccountPlayerNames[0], secondAccountPlayerNames[1]];
      savedPairs[1] = [secondAccountPlayerNames[2], secondAccountPlayerNames[3]];
      savedPlayerNames.splice(0, savedPlayerNames.length, ...savedPairs.flat());
      await createSmokeTournament(appPage.webSocketDebuggerUrl);
      await createRecoveryCopyThroughImport(appPage.webSocketDebuggerUrl);
      await terminateAppAbruptly(appProcess);
      appProcess = undefined;
      appProcess = launchApp();
      appPage = await waitForAppPage(appProcess);
      await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
      console.log('The second standard Windows account saved and reopened its own tournament and recovery copy.');
    } else if (zipExistingSmoke || zipReturnSmoke || zipSecondReturnSmoke) {
      if (zipSecondReturnSmoke) {
        savedTournamentName = `${secondAccountTournamentName} replacement`;
        recoveryTournamentName = secondAccountTournamentName;
        savedPairs[0] = [secondAccountPlayerNames[0], secondAccountPlayerNames[1]];
        savedPairs[1] = [secondAccountPlayerNames[2], secondAccountPlayerNames[3]];
        savedPlayerNames.splice(0, savedPlayerNames.length, ...savedPairs.flat());
      } else {
        savedTournamentName = `${firstAccountTournamentName} replacement`;
        recoveryTournamentName = firstAccountTournamentName;
      }
      await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
      if (zipReturnSmoke) await verifySecondUsersTournamentIsNotVisible(appPage.webSocketDebuggerUrl);
      if (zipSecondReturnSmoke) await verifyFirstUsersTournamentIsNotVisible(appPage.webSocketDebuggerUrl);
      console.log(
        zipReturnSmoke
          ? 'After a fresh sign-in, the first account retained its tournament and could not see the second account’s data.'
          : zipSecondReturnSmoke
            ? 'After a fresh sign-in, the second account retained its tournament and could not see the first account’s data.'
            : 'After a fresh sign-in, the ZIP app retained the saved tournament and recovery copy.',
      );
    } else if (standardUserSmoke) {
      await createSmokeTournament(appPage.webSocketDebuggerUrl);
      console.log('The standard user saved a tournament, schedule, and completed match result from the ZIP app.');

      await createRecoveryCopyThroughImport(appPage.webSocketDebuggerUrl);
      await terminateAppAbruptly(appProcess);
      appProcess = undefined;

      appProcess = launchApp();
      appPage = await waitForAppPage(appProcess);
      await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
      console.log(
        'The standard user reopened the ZIP app after unexpected termination with the saved tournament, result, and recovery copy.',
      );

      if (zipUpdateSmoke) {
        preUpdateBackup = await createPreUpdateBackup(appPage.webSocketDebuggerUrl);
      }
      await stopApp(appProcess, appPage.webSocketDebuggerUrl);
      appProcess = undefined;

      if (zipUpdateSmoke) {
        incompleteUpdateDirectory = await simulateInterruptedZipExtraction();

        appProcess = launchApp();
        appPage = await waitForAppPage(appProcess);
        await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
        console.log(
          'The original ZIP app remained launchable after an interrupted update extraction, with tournament data intact.',
        );

        await stopApp(appProcess, appPage.webSocketDebuggerUrl);
        appProcess = undefined;
        await rm(incompleteUpdateDirectory, { recursive: true, force: true });
        incompleteUpdateDirectory = undefined;
        await stat(executablePath);
        executablePath = updatedZipExecutablePath;
      }

      appProcess = launchApp();
      appPage = await waitForAppPage(appProcess);
      await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
      if (zipUpdateSmoke) {
        await restoreRecoveryCopyAfterUpdate(appPage.webSocketDebuggerUrl);
        await importPreUpdateBackup(appPage.webSocketDebuggerUrl, preUpdateBackup);
      }
      console.log(
        zipUpdateSmoke
          ? 'The standard user launched the separately extracted ZIP app with the saved tournament and completed match result; the old app folder was left untouched.'
          : 'The standard user reopened the ZIP app with the saved tournament and completed match result.',
      );
    }
  } else if (windowsSessionSaveSmoke) {
    await createSmokeTournament(appPage.webSocketDebuggerUrl);
    console.log('The standard Windows account saved the tournament and players before its profile session ended.');
    await stopApp(appProcess, appPage.webSocketDebuggerUrl);
    appProcess = undefined;
  } else if (windowsSessionResumeSmoke) {
    await verifyTournamentAfterWindowsSessionRestart(appPage.webSocketDebuggerUrl);
  } else {
    await createSmokeTournament(appPage.webSocketDebuggerUrl);
    console.log('The installed app saved the tournament, schedule, and completed match result.');

    await createRecoveryCopyThroughImport(appPage.webSocketDebuggerUrl);
    await terminateAppAbruptly(appProcess);
    appProcess = undefined;

    appProcess = launchApp();
    appPage = await waitForAppPage(appProcess);
    await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
    console.log('The installed app reopened after unexpected termination with the saved tournament, result, and recovery copy.');

    preUpdateBackup = await createPreUpdateBackup(appPage.webSocketDebuggerUrl);
    await stopApp(appProcess, appPage.webSocketDebuggerUrl);
    appProcess = undefined;

    await updateInstalledAppInPlace();
    appProcess = launchApp();
    appPage = await waitForAppPage(appProcess);
    await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
    await restoreRecoveryCopyAfterUpdate(appPage.webSocketDebuggerUrl);
    console.log('The installed app update preserved the tournament, result, and recovery copy.');

    await stopApp(appProcess, appPage.webSocketDebuggerUrl);
    appProcess = undefined;

    await reinstallInstalledApp();
    appProcess = launchApp();
    appPage = await waitForAppPage(appProcess);
    await verifyTournamentAfterRestart(appPage.webSocketDebuggerUrl);
    console.log('The tournament, scheduled match, and result remained available after uninstall and reinstall.');
    await importPreUpdateBackup(appPage.webSocketDebuggerUrl, preUpdateBackup);
  }
} catch (error) {
  console.error(`Windows smoke application output (last 8000 characters): ${appProcess?.startupDiagnostics || 'No application output was captured.'}`);
  console.error(`Windows smoke process context: ${appProcess ? describeWindowsStartup(appProcess.pid) : 'No active app process.'}`);
  throw error;
} finally {
  try {
    if (appProcess) await stopApp(appProcess, appPage?.webSocketDebuggerUrl);
  } finally {
    if (incompleteUpdateDirectory) {
      await rm(incompleteUpdateDirectory, { recursive: true, force: true });
    }
    if (preUpdateBackupDirectory) {
      await rm(preUpdateBackupDirectory, { recursive: true, force: true });
    }
  }
}
