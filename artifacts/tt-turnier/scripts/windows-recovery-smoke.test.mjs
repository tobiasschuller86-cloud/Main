import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./windows-installer-smoke.mjs', import.meta.url), 'utf8');
const helpers = source.slice(
  source.indexOf('async function verifyRecoveryCopy('),
  source.indexOf('async function verifyFirstUsersTournamentIsNotVisible('),
);
const activeTournamentHelper = source.slice(
  source.indexOf('function activeTournamentExpression('),
  source.indexOf('function delay('),
);
const backupImportHelper = source.slice(
  source.indexOf('async function importPreUpdateBackup('),
  source.indexOf('async function verifyRecoveryCopy('),
);
const windowsSessionRestartHelper = source.slice(
  source.indexOf('async function verifyTournamentAfterWindowsSessionRestart('),
  source.indexOf('async function verifyFirstUsersTournamentIsNotVisible('),
);

function harness({ missingRecovery = false, rejectRestore = false, loseResults = false } = {}) {
  const names = ['Player One', 'Player Two', 'Player Three', 'Player Four'];
  const match = {
    id: 'match-1', stage: 'group', round: 1, groupId: 'group-1',
    side1: ['p0', 'p1'], side2: ['p2', 'p3'],
    status: 'completed', sets: [{ p1: 11, p2: 7 }, { p1: 11, p2: 8 }], winnerSide: 1,
  };
  const original = {
    name: 'Before update',
    players: names.map((name, i) => ({ id: `p${i}`, name })),
    pairs: [{ id: 'pair-1' }, { id: 'pair-2' }],
    matches: [match],
  };
  let active = { ...original, name: 'Replacement' };
  let recovery = missingRecovery ? null : original;
  let preview = null;
  const actions = [];
  const context = vm.createContext({
    savedTournamentName: active.name,
    recoveryTournamentName: original.name,
    savedPlayerNames: names,
    savedPairs: [names.slice(0, 2), names.slice(2)],
    savedMatchSets: match.sets,
    savedMatchSnapshot: match,
    savedMatchesSnapshot: [match],
    console: { log: (message) => actions.push(message) },
    window: {},
    localStorage: {
      getItem(key) {
        if (key === 'tt-turnier-state-v2') return JSON.stringify(active);
        if (key === 'tt-turnier-recovery-v1') {
          return JSON.stringify(recovery ? [{ raw: JSON.stringify({ tournament: recovery }) }] : []);
        }
        return null;
      },
    },
    document: {
      body: { get innerText() { return active.name; } },
      querySelector(selector) {
        if (selector === '.app-dialog .metric-value') {
          return preview ? { textContent: preview.name } : null;
        }
        if (selector.includes('button-preview-recovery-0')) {
          return recovery ? { click() { preview = recovery; actions.push('preview'); } } : null;
        }
        if (selector.includes('button-confirm-backup-import')) {
          return { click() {
            actions.push('restore');
            assert.equal(context.window.confirm(), true);
            if (rejectRestore) return;
            const replaced = active;
            active = loseResults ? { ...preview, matches: [] } : preview;
            recovery = replaced;
            preview = null;
          } };
        }
        if (selector.includes('button-cancel-backup-preview')) {
          return { click() { preview = null; actions.push('cancel'); } };
        }
        if (selector.includes('match-match-1')) return { innerText: `${names.join(' ')} 11:7 11:8` };
        if (selector.includes('link-settings') || selector.includes('link-groups')) {
          return { click() {} };
        }
        throw new Error(`Unexpected selector: ${selector}`);
      },
    },
  });
  context.evaluatePage = async (_url, expression) => vm.runInContext(expression, context);
  context.waitForPageValue = async (_url, expression, expected, description) => {
    assert.equal(vm.runInContext(expression, context), expected, description);
  };
  vm.runInContext(`${activeTournamentHelper}\n${helpers}`, context);
  return {
    context, actions,
    active: () => active,
    restore: () => context.restoreRecoveryCopyAfterUpdate('test-page'),
  };
}

test('the updated app loads the original recovery copy and checks its tournament data', async () => {
  const smoke = harness();
  await smoke.restore();
  assert.equal(smoke.active().name, 'Before update');
  assert.equal(smoke.context.savedTournamentName, 'Before update');
  assert.equal(smoke.context.recoveryTournamentName, 'Replacement');
  assert.deepEqual(smoke.actions.slice(0, 4), ['preview', 'restore', 'preview', 'cancel']);
});

test('ordinary recovery checks only preview and leave the active tournament untouched', async () => {
  const smoke = harness();
  await smoke.context.verifyRecoveryCopy('test-page');
  assert.equal(smoke.active().name, 'Replacement');
  assert.deepEqual(smoke.actions, ['preview', 'cancel']);
});

test('the upgrade check fails if the recovery copy disappears', async () => {
  await assert.rejects(harness({ missingRecovery: true }).restore(), /recovery copy was missing/);
});

test('the upgrade check fails if a preview works but restoring does not', async () => {
  await assert.rejects(harness({ rejectRestore: true }).restore(), /could preview but not load/);
});

test('the upgrade check fails if restoring loses the saved match result', async () => {
  await assert.rejects(harness({ loseResults: true }).restore(), /Tournament or completed match data was missing/);
});

test('both Windows update paths run the restore check after checking active data', () => {
  const zipSwitch = source.indexOf('executablePath = updatedZipExecutablePath;');
  const zipRestore = source.indexOf('await restoreRecoveryCopyAfterUpdate(appPage.webSocketDebuggerUrl);');
  assert.ok(zipSwitch > 0 && zipRestore > zipSwitch, 'ZIP recovery must be loaded by the updated executable, not the old app');
  assert.match(source.slice(zipSwitch, zipRestore), /await verifyTournamentAfterRestart\(appPage\.webSocketDebuggerUrl\);/);
  assert.match(source.slice(zipSwitch), /if \(zipUpdateSmoke\) \{\s*await restoreRecoveryCopyAfterUpdate\(appPage\.webSocketDebuggerUrl\);\s*await importPreUpdateBackup\(appPage\.webSocketDebuggerUrl, preUpdateBackup\);\s*\}/);
  assert.match(source, /await updateInstalledAppInPlace\(\);[\s\S]*?await verifyTournamentAfterRestart\(appPage\.webSocketDebuggerUrl\);\s*await restoreRecoveryCopyAfterUpdate\(appPage\.webSocketDebuggerUrl\);/);
});

function backupImportHarness({ rejectBackup = false, missingPlayer = false } = {}) {
  const expected = { name: 'Older build tournament', playerNames: ['Player One', 'Player Two'] };
  const importedTournament = {
    name: expected.name,
    players: expected.playerNames
      .filter((_, index) => !(missingPlayer && index === expected.playerNames.length - 1))
      .map((name, index) => ({ id: `p${index}`, name })),
  };
  let active = { name: 'Current tournament', players: [] };
  let route = 'overview';
  let previewReady = false;
  let selectedFile;
  const context = vm.createContext({
    console: { log() {} },
    window: {},
    localStorage: {
      getItem(key) {
        return key === 'tt-turnier-state-v2' ? JSON.stringify(active) : null;
      },
    },
    document: {
      get body() {
        const visibleText = route === 'participants'
          ? active.players.map((player) => player.name).join(' ')
          : route === 'overview' ? active.name : '';
        return { innerText: visibleText };
      },
      querySelector(selector) {
        if (selector.includes('link-settings')) return { click() { route = 'settings'; } };
        if (selector.includes('link-participants')) return { click() { route = 'participants'; } };
        if (selector.includes('link-overview')) return { click() { route = 'overview'; } };
        if (selector.includes('button-import-backup')) return {};
        if (selector.includes('button-confirm-backup-import')) {
          return previewReady ? {
            click() {
              active = importedTournament;
              route = 'overview';
              previewReady = false;
            },
          } : null;
        }
        return null;
      },
    },
  });
  context.sendDevtoolsCommand = async (_url, method, params = {}) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 2 };
    if (method === 'DOM.setFileInputFiles') {
      selectedFile = params.files[0];
      previewReady = !rejectBackup;
      return {};
    }
    throw new Error(`Unexpected DevTools method: ${method}`);
  };
  context.evaluatePage = async (_url, expression) => vm.runInContext(expression, context);
  context.waitForPageValue = async (_url, expression, expectedValue, description) => {
    const actual = vm.runInContext(expression, context);
    if (actual !== expectedValue) {
      throw new Error(`${description} (last value: ${JSON.stringify(actual)}).`);
    }
  };
  vm.runInContext(`${activeTournamentHelper}\n${backupImportHelper}`, context);
  return {
    context,
    expected,
    selectedFile: () => selectedFile,
    import: () => context.importPreUpdateBackup('test-page', {
      path: 'C:\\old-build\\turnier-sicherung.json',
      expected,
    }),
    route: () => route,
  };
}

test('the updated app imports and displays the tournament and players from the older backup', async () => {
  const smoke = backupImportHarness();
  await smoke.import();
  assert.equal(smoke.selectedFile(), 'C:\\old-build\\turnier-sicherung.json');
  assert.equal(smoke.route(), 'overview');
  assert.equal(smoke.context.savedTournamentName, smoke.expected.name);
});

test('the backup compatibility check fails when the updated app rejects the backup', async () => {
  await assert.rejects(
    backupImportHarness({ rejectBackup: true }).import(),
    /rejected the pre-update backup/,
  );
});

test('the backup compatibility check fails when an imported player is missing', async () => {
  await assert.rejects(
    backupImportHarness({ missingPlayer: true }).import(),
    /did not import the pre-update tournament and all its players/,
  );
});

test('the installed-app smoke exports before updating and imports after the updated reinstall', () => {
  const exportCall = source.indexOf('preUpdateBackup = await createPreUpdateBackup(appPage.webSocketDebuggerUrl);');
  const updateCall = source.indexOf('await updateInstalledAppInPlace();');
  const reinstallCall = source.indexOf('await reinstallInstalledApp();');
  const importCall = source.indexOf('await importPreUpdateBackup(appPage.webSocketDebuggerUrl, preUpdateBackup);', reinstallCall);
  assert.ok(exportCall > 0 && updateCall > exportCall, 'the backup must come from the older installed app');
  assert.ok(reinstallCall > updateCall && importCall > reinstallCall, 'the updated app must import the old backup');
});

function windowsSessionRestartHarness({ missingPlayer = false, missingTournament = false } = {}) {
  const names = ['Smoke Herren', 'Smoke Damen', 'Smoke Herren Zwei', 'Smoke Damen Zwei'];
  const savedState = {
    name: missingTournament ? 'Different tournament' : 'Windows restart smoke tournament',
    players: names.slice(missingPlayer ? 1 : 0),
  };
  const pageChecks = [];
  const context = vm.createContext({
    savedTournamentName: 'Windows restart smoke tournament',
    savedPlayerNames: names,
    activeTournamentExpression: () => 'savedTournamentExpression',
    evaluatePage: async (_url, expression) => {
      if (expression.includes('const saved =')) return savedState;
    },
    waitForPageValue: async (_url, expression, expected, description) => {
      pageChecks.push({ expression, description });
      assert.equal(expected, true);
      assert.match(expression, /document\.body\.innerText/);
    },
    console: { log() {} },
  });
  vm.runInContext(windowsSessionRestartHelper, context);
  return {
    context,
    pageChecks,
    verify: () => context.verifyTournamentAfterWindowsSessionRestart('test-page'),
  };
}

test('the Windows profile restart check confirms the tournament and every player are displayed', async () => {
  const smoke = windowsSessionRestartHarness();
  await smoke.verify();
  assert.equal(smoke.pageChecks.length, 2);
  assert.match(smoke.pageChecks[0].expression, /Windows restart smoke tournament/);
  assert.ok(
    smoke.pageChecks[1].expression.includes(
      JSON.stringify(['Smoke Herren', 'Smoke Damen', 'Smoke Herren Zwei', 'Smoke Damen Zwei']),
    ),
  );
});

test('the Windows profile restart check fails if the tournament is missing', async () => {
  await assert.rejects(
    windowsSessionRestartHarness({ missingTournament: true }).verify(),
    /tournament or its players were missing after the Windows profile session restarted/,
  );
});

test('the Windows profile restart check fails if any saved player is missing', async () => {
  await assert.rejects(
    windowsSessionRestartHarness({ missingPlayer: true }).verify(),
    /tournament or its players were missing after the Windows profile session restarted/,
  );
});

test('the Windows workflow unloads the account profile before reopening saved tournament data', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/windows-installer.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Verify tournament data survives a Windows profile restart/);
  assert.match(workflow, /--windows-session-save/);
  assert.match(workflow, /if \(\$profile -and -not \$profile\.Loaded\)/);
  assert.match(workflow, /--windows-session-resume/);
});
