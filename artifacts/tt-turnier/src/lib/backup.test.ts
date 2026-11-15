import assert from 'node:assert/strict';
import test from 'node:test';
import { blankTournament, type Tournament } from './tournament';
import {
  compareTournamentContents,
  createTournamentBackup,
  importTournamentBackup,
  loadTournamentRecoveryCopies,
  MAX_RECOVERY_COPIES,
  parseLegacyTournament,
  parseStoredTournament,
  parseTournamentBackup,
  recoveryCopyDownload,
  RECOVERY_STORAGE_KEY,
  saveTournamentRecoveryCopy,
} from './backup';

const exportedAt = '2026-11-14T12:00:00.000Z';

function populatedTournament(): Tournament {
  return {
    ...blankTournament('2026-11-14'),
    name: 'Herbstturnier',
    venue: 'Sporthalle',
    phase: 'groups',
    players: [
      { id: 'm1', name: 'Max', category: 'men', groupId: 'g1' },
      { id: 'w1', name: 'Mia', category: 'women', groupId: 'g1' },
      { id: 'm2', name: 'Moritz', category: 'men', groupId: 'g1' },
      { id: 'w2', name: 'Wanda', category: 'women', groupId: 'g1' },
    ],
    pairs: [
      { id: 'pair-1', menPlayerId: 'm1', womenPlayerId: 'w1', groupId: 'g1' },
      { id: 'pair-2', menPlayerId: 'm2', womenPlayerId: 'w2', groupId: 'g1' },
    ],
    groups: [{ id: 'g1', name: 'Feld 1' }],
    matches: [{
      id: 'match-1',
      stage: 'group',
      round: 1,
      groupId: 'g1',
      side1: ['m1', 'w1'],
      side2: ['m2', 'w2'],
      status: 'completed',
      sets: [{ p1: 11, p2: 7 }, { p1: 8, p2: 11 }, { p1: 11, p2: 9 }],
      winnerSide: 1,
      tableNumber: 2,
    }],
    qualifiedIds: ['m1', 'w1'],
  };
}

function backupFor(tournament: Tournament) {
  return JSON.stringify(createTournamentBackup(tournament, exportedAt));
}

function multiGroupKnockoutTournament(): Tournament {
  const groups = [
    { id: 'g1', name: 'Gruppe Ä' },
    { id: 'g2', name: 'Gruppe Ö' },
  ];
  const players: Tournament['players'] = [
    { id: 'm1', name: 'Jürgen', category: 'men', groupId: 'g1' },
    { id: 'w1', name: 'Zoë', category: 'women', groupId: 'g1' },
    { id: 'm2', name: 'François', category: 'men', groupId: 'g1' },
    { id: 'w2', name: 'Chloë', category: 'women', groupId: 'g1' },
    { id: 'm3', name: 'Søren', category: 'men', groupId: 'g2' },
    { id: 'w3', name: 'Máría', category: 'women', groupId: 'g2' },
    { id: 'm4', name: 'Łukasz', category: 'men', groupId: 'g2' },
    { id: 'w4', name: 'Élodie', category: 'women', groupId: 'g2' },
  ];
  const pairs: Tournament['pairs'] = [
    { id: 'pair-1', menPlayerId: 'm1', womenPlayerId: 'w1', groupId: 'g1' },
    { id: 'pair-2', menPlayerId: 'm2', womenPlayerId: 'w2', groupId: 'g1' },
    { id: 'pair-3', menPlayerId: 'm3', womenPlayerId: 'w3', groupId: 'g2' },
    { id: 'pair-4', menPlayerId: 'm4', womenPlayerId: 'w4', groupId: 'g2' },
  ];
  return {
    ...blankTournament('2026-11-14'),
    phase: 'knockout',
    groups,
    players,
    pairs,
    qualifiedIds: players.map((player) => player.id),
    matches: [
      {
        id: 'group-g1',
        stage: 'group',
        round: 1,
        groupId: 'g1',
        side1: ['m1', 'w1'],
        side2: ['m2', 'w2'],
        status: 'pending',
        sets: [],
        winnerSide: null,
        tableNumber: 1,
      },
      {
        id: 'group-g2',
        stage: 'group',
        round: 1,
        groupId: 'g2',
        side1: ['m3', 'w3'],
        side2: ['m4', 'w4'],
        status: 'pending',
        sets: [],
        winnerSide: null,
        tableNumber: 2,
      },
      {
        id: 'knockout-final',
        stage: 'knockout',
        round: 1,
        groupId: null,
        side1: ['m1', 'w4'],
        side2: ['m3', 'w2'],
        status: 'pending',
        sets: [],
        winnerSide: null,
        tableNumber: 1,
      },
    ],
  };
}

test('an empty tournament export can be imported', () => {
  const tournament = blankTournament('2026-11-14');
  const backup = createTournamentBackup(tournament, exportedAt);

  assert.equal(backup.format, 'tt-turnier-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.exportedAt, exportedAt);
  assert.deepEqual(parseTournamentBackup(JSON.stringify(backup)), {
    success: true,
    tournament,
  });
});

test('stored tournament data is parsed separately from missing data', () => {
  const tournament = blankTournament('2026-11-14');

  assert.deepEqual(parseStoredTournament(JSON.stringify(tournament)), {
    success: true,
    tournament,
  });
  assert.deepEqual(parseStoredTournament('{'), { success: false });
  assert.deepEqual(parseStoredTournament(JSON.stringify({ players: 'not-an-array', groups: [], matches: [] })), {
    success: false,
  });
});

test('failed legacy migration leaves the original saved value available for recovery', () => {
  const raw = JSON.stringify({ name: 'Altbestand', players: [{ name: 42 }] });
  const storage = new Map([['legacy-save', raw]]);

  assert.deepEqual(parseLegacyTournament(raw, '2026-11-14'), { success: false });
  assert.equal(storage.get('legacy-save'), raw);
  const migrated = parseLegacyTournament(JSON.stringify({ name: 'Altes Turnier', players: [{ name: 'Max' }] }), '2026-11-14');
  assert.equal(migrated.success, true);
  if (migrated.success) {
    assert.equal(migrated.tournament.name, 'Altes Turnier');
    assert.deepEqual(migrated.tournament.legacyParticipantNames, ['Max']);
  }
});

test('backup comparison reports additions, removals, edits, and result changes', () => {
  const current = populatedTournament();
  const backup = {
    ...current,
    players: current.players.map((player) => player.id === 'm1'
      ? { ...player, name: 'Max Neu' }
      : player).filter((player) => player.id !== 'w2'),
    pairs: current.pairs.slice(0, 1),
    groups: [{ ...current.groups[0], name: 'Finalfeld' }],
    matches: [{
      ...current.matches[0],
      round: 2,
      sets: [{ p1: 11, p2: 5 }, { p1: 11, p2: 7 }],
    }],
  };
  const differences = compareTournamentContents(current, backup);

  assert.deepEqual(differences.map(({ label, added, removed, changed }) => ({ label, added, removed, changed })), [
    { label: 'Spieler', added: 0, removed: 1, changed: 1 },
    { label: 'Paare', added: 0, removed: 1, changed: 0 },
    { label: 'Gruppen', added: 0, removed: 0, changed: 1 },
    { label: 'Spiele', added: 0, removed: 0, changed: 1 },
    { label: 'Ergebnisse', added: 0, removed: 0, changed: 1 },
  ]);
  const pendingMatch = {
    ...current.matches[0],
    id: 'pending-match',
    status: 'pending' as const,
    sets: [],
    winnerSide: null,
  };
  assert.deepEqual(
    compareTournamentContents(current, { ...current, matches: [...current.matches, pendingMatch] })[4],
    { label: 'Ergebnisse', currentCount: 1, backupCount: 1, added: 0, removed: 0, changed: 0 },
    'adding an unfinished match should not appear as a changed result',
  );
});

test('backup comparison distinguishes added, removed, and changed results without mutating either tournament', () => {
  const current = populatedTournament();
  const removedResult = { ...current.matches[0], id: 'removed-result' };
  current.matches = [current.matches[0], removedResult];
  const backup = {
    ...current,
    matches: [
      { ...current.matches[0], sets: [{ p1: 11, p2: 5 }, { p1: 11, p2: 7 }] },
      {
        ...current.matches[0],
        id: 'new-result',
        round: 2,
      },
    ],
  };
  const currentSnapshot = structuredClone(current);
  const backupSnapshot = structuredClone(backup);

  const resultsDifference = compareTournamentContents(current, backup).find(({ label }) => label === 'Ergebnisse');

  assert.deepEqual(resultsDifference, {
    label: 'Ergebnisse',
    currentCount: 2,
    backupCount: 2,
    added: 1,
    removed: 1,
    changed: 1,
  });
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual(backup, backupSnapshot);
});

test('export and import preserve pairs, matches, and match results', () => {
  const tournament = populatedTournament();
  const parsed = parseTournamentBackup(backupFor(tournament));

  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.tournament, tournament);
  assert.deepEqual(parsed.tournament.pairs, tournament.pairs);
  assert.deepEqual(parsed.tournament.matches[0].sets, [
    { p1: 11, p2: 7 },
    { p1: 8, p2: 11 },
    { p1: 11, p2: 9 },
  ]);
  assert.equal(parsed.tournament.matches[0].winnerSide, 1);
});

test('backup round trips preserve decomposed accented player names exactly', () => {
  const enteredName = 'Jose\u0301';
  const baseTournament = populatedTournament();
  const tournament = {
    ...baseTournament,
    players: baseTournament.players.map((player) =>
      player.id === 'm1' ? { ...player, name: enteredName } : player,
    ),
  };
  let importedTournament: Tournament | undefined;

  const result = importTournamentBackup(
    backupFor(tournament),
    blankTournament('2026-11-14'),
    (imported) => {
      importedTournament = imported;
    },
    () => true,
  );

  assert.deepEqual(result, { success: true, imported: true });
  const importedName = importedTournament?.players.find((player) => player.id === 'm1')?.name;
  assert.equal(importedName, enteredName);
  assert.deepEqual(Buffer.from(importedName ?? '', 'utf8'), Buffer.from(enteredName, 'utf8'));
});

test('setup backups keep pairs whose group assignment has not started', () => {
  const tournament = populatedTournament();
  const setupTournament: Tournament = {
    ...tournament,
    phase: 'setup',
    groups: [],
    matches: [],
    qualifiedIds: [],
    players: tournament.players.map((player) => ({ ...player, groupId: '' })),
    pairs: tournament.pairs.map((pair) => ({ ...pair, groupId: '' })),
  };

  const parsed = parseTournamentBackup(backupFor(setupTournament));

  assert.deepEqual(parsed, { success: true, tournament: setupTournament });
});

test('multi-group backups preserve knockout pairings and accented names', () => {
  const tournament = multiGroupKnockoutTournament();
  const parsed = parseTournamentBackup(backupFor(tournament));

  assert.deepEqual(parsed, { success: true, tournament });
  if (!parsed.success) return;
  assert.deepEqual(parseTournamentBackup(backupFor(parsed.tournament)), parsed);
  assert.equal(parsed.tournament.players.find((player) => player.id === 'm1')?.name, 'Jürgen');
  assert.deepEqual(parsed.tournament.matches[2].side1, ['m1', 'w4']);
  assert.equal(parsed.tournament.matches[2].stage, 'knockout');
});

test('export and import preserve player and pair assignments across groups', () => {
  const tournament = multiGroupKnockoutTournament();
  let importedTournament: Tournament | undefined;

  const result = importTournamentBackup(
    backupFor(tournament),
    blankTournament('2026-11-14'),
    (imported) => {
      importedTournament = imported;
    },
    () => true,
  );

  assert.deepEqual(result, { success: true, imported: true });
  assert.ok(importedTournament);
  assert.deepEqual(
    importedTournament.players.map(({ id, groupId }) => [id, groupId]),
    [
      ['m1', 'g1'],
      ['w1', 'g1'],
      ['m2', 'g1'],
      ['w2', 'g1'],
      ['m3', 'g2'],
      ['w3', 'g2'],
      ['m4', 'g2'],
      ['w4', 'g2'],
    ],
  );
  assert.deepEqual(
    importedTournament.pairs.map(({ id, menPlayerId, womenPlayerId, groupId }) => [
      id,
      menPlayerId,
      womenPlayerId,
      groupId,
    ]),
    [
      ['pair-1', 'm1', 'w1', 'g1'],
      ['pair-2', 'm2', 'w2', 'g1'],
      ['pair-3', 'm3', 'w3', 'g2'],
      ['pair-4', 'm4', 'w4', 'g2'],
    ],
  );
});

test('knockout matches without a group import and retain all match data', () => {
  const tournament = multiGroupKnockoutTournament();
  const knockoutMatch = tournament.matches[2];
  const importedFromCallback: Tournament[] = [];
  const result = importTournamentBackup(
    backupFor(tournament),
    blankTournament('2026-11-14'),
    (imported) => importedFromCallback.push(imported),
    () => true,
  );

  assert.deepEqual(result, { success: true, imported: true });
  assert.equal(importedFromCallback.length, 1);
  assert.deepEqual(importedFromCallback[0].matches[2], knockoutMatch);
  assert.equal(importedFromCallback[0].matches[2].groupId, null);
  assert.deepEqual(importedFromCallback[0].matches, tournament.matches);
});

test('supported older version-one backups may omit newer optional match flags', () => {
  const currentTournament = populatedTournament();
  const tournament: Tournament = {
    ...currentTournament,
    matches: [
      ...currentTournament.matches,
      {
        id: 'legacy-bye',
        stage: 'knockout',
        round: 1,
        groupId: null,
        side1: ['m1', 'w1'],
        side2: null,
        status: 'completed',
        sets: [],
        winnerSide: 1,
        tableNumber: null,
      },
    ],
  };
  const currentBackup = createTournamentBackup(tournament, exportedAt);
  const olderBackup = {
    ...currentBackup,
    tournament: {
      ...currentBackup.tournament,
      legacyParticipantNames: undefined,
      matches: currentBackup.tournament.matches.map(({ isBye: _isBye, isThirdPlace: _isThirdPlace, ...match }) => match),
    },
  };

  const expectedTournament = {
    ...tournament,
    matches: tournament.matches.map((match) =>
      match.id === 'legacy-bye' ? { ...match, isBye: true } : match,
    ),
  };
  assert.deepEqual(parseTournamentBackup(JSON.stringify(olderBackup)), {
    success: true,
    tournament: expectedTournament,
  });
});

test('consistent pending and completed matches remain importable', () => {
  const tournament = populatedTournament();
  tournament.matches = [
    tournament.matches[0],
    {
      ...tournament.matches[0],
      id: 'match-2',
      round: 2,
      status: 'pending',
      sets: [],
      winnerSide: null,
    },
    {
      ...tournament.matches[0],
      id: 'match-3',
      round: 3,
      status: 'in_progress',
      sets: [],
      winnerSide: null,
    },
    {
      ...tournament.matches[0],
      id: 'bye',
      round: 4,
      side2: null,
      status: 'completed',
      sets: [],
      winnerSide: 1,
      isBye: true,
      tableNumber: null,
    },
  ];

  assert.equal(parseTournamentBackup(backupFor(tournament)).success, true);
});

test('contradictory completed match results are rejected', async (t) => {
  const tournament = populatedTournament();
  const invalidMatches = [
    {
      name: 'winner disagrees with set results',
      expectedIssue: 'Der eingetragene Sieger stimmt nicht mit den Satzergebnissen überein.',
      match: { ...tournament.matches[0], winnerSide: 2 as const },
    },
    {
      name: 'set is tied',
      expectedIssue: 'Mindestens ein Satz hat ein ungültiges Ergebnis.',
      match: { ...tournament.matches[0], sets: [{ p1: 11, p2: 11 }] },
    },
    {
      name: 'set has an invalid score',
      expectedIssue: 'Mindestens ein Satz hat ein ungültiges Ergebnis.',
      match: { ...tournament.matches[0], sets: [{ p1: 10, p2: 9 }] },
    },
    {
      name: 'match was not decided',
      expectedIssue: 'Die Satzergebnisse entscheiden das Spiel noch nicht.',
      match: {
        ...tournament.matches[0],
        sets: [{ p1: 11, p2: 7 }],
      },
    },
    {
      name: 'sets continue after the winner was decided',
      expectedIssue: 'Nach dem feststehenden Spielentscheid wurden weitere Sätze eingetragen.',
      match: {
        ...tournament.matches[0],
        sets: [
          { p1: 11, p2: 7 },
          { p1: 11, p2: 8 },
          { p1: 11, p2: 9 },
        ],
      },
    },
  ];

  for (const { name, expectedIssue, match } of invalidMatches) {
    await t.test(name, () => {
      const result = parseTournamentBackup(backupFor({ ...tournament, matches: [match] }));
      assert.equal(result.success, false);
      if (!result.success) {
        assert.match(result.message, /Spiel „match-1“ \(Feld 1, Runde 1, Tisch 2\)/);
        assert.ok(result.message.includes(expectedIssue), result.message);
      }
    });
  }
});

test('inconsistent match errors name both teams from the backup roster', () => {
  const tournament = populatedTournament();
  const backupTournament = {
    ...tournament,
    players: tournament.players.map((player) => ({
      ...player,
      name: `Backup ${player.name}`,
    })),
    matches: [{ ...tournament.matches[0], winnerSide: 2 as const }],
  };

  const result = parseTournamentBackup(backupFor(backupTournament));

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.message, /Spiel „match-1“ \(Feld 1, Runde 1, Tisch 2\)/);
    assert.ok(result.message.includes('zwischen Backup Max + Backup Mia und Backup Moritz + Backup Wanda'));
    assert.ok(result.message.includes('Der eingetragene Sieger stimmt nicht mit den Satzergebnissen überein.'));
  }
});

test('inconsistent knockout errors name both teams from the backup roster', () => {
  const tournament = multiGroupKnockoutTournament();
  const backupTournament = {
    ...tournament,
    players: tournament.players.map((player) => ({
      ...player,
      name: `Backup ${player.name}`,
    })),
    matches: [{
      ...tournament.matches[2],
      status: 'completed' as const,
      sets: [{ p1: 11, p2: 7 }, { p1: 11, p2: 8 }],
      winnerSide: 2 as const,
    }],
  };

  const result = parseTournamentBackup(backupFor(backupTournament));

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.message, /Spiel „knockout-final“ \(KO-Runde, Runde 1, Tisch 1\)/);
    assert.ok(result.message.includes(
      'zwischen Backup Jürgen + Backup Élodie und Backup Søren + Backup Chloë',
    ));
    assert.ok(result.message.includes('Der eingetragene Sieger stimmt nicht mit den Satzergebnissen überein.'));
  }
});

test('inconsistent match errors identify players with blank backup names by ID', () => {
  const tournament = populatedTournament();
  const backupTournament = {
    ...tournament,
    players: tournament.players.map((player) => ({
      ...player,
      name: player.id === 'm1' ? '' : `Backup ${player.name}`,
    })),
    matches: [{ ...tournament.matches[0], winnerSide: 2 as const }],
  };

  const result = parseTournamentBackup(backupFor(backupTournament));

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.message, /Spiel „match-1“ \(Feld 1, Runde 1, Tisch 2\)/);
    assert.ok(result.message.includes('zwischen m1 + Backup Mia und Backup Moritz + Backup Wanda'));
    assert.ok(result.message.includes('Der eingetragene Sieger stimmt nicht mit den Satzergebnissen überein.'));
  }
});

test('invalid JSON, format names, and versions are rejected', () => {
  const validBackup = createTournamentBackup(blankTournament('2026-11-14'), exportedAt);

  assert.equal(parseTournamentBackup('{').success, false);
  assert.equal(
    parseTournamentBackup(JSON.stringify({ ...validBackup, format: 'other-backup' })).success,
    false,
  );
  assert.equal(
    parseTournamentBackup(JSON.stringify({ ...validBackup, version: 2 })).success,
    false,
  );
  assert.equal(
    parseTournamentBackup(JSON.stringify({ ...validBackup, tournament: undefined })).success,
    false,
  );
});

test('backup references to missing qualification players are rejected', () => {
  const tournament = populatedTournament();
  const invalidTournament = { ...tournament, qualifiedIds: ['missing'] };
  assert.equal(parseTournamentBackup(backupFor(invalidTournament)).success, false);
});

test('missing pair players identify every pair and player ID without changing the current tournament', () => {
  const tournament = populatedTournament();
  const invalidTournament = {
    ...tournament,
    pairs: [
      { ...tournament.pairs[0], menPlayerId: 'missing-men', womenPlayerId: 'missing-women' },
      { ...tournament.pairs[1], womenPlayerId: 'missing-second-women' },
    ],
  };
  const currentTournament = populatedTournament();
  let displayedTournament = currentTournament;
  let importCalls = 0;
  let confirmationCalls = 0;
  const expectedMessage =
    'Die Sicherung enthält fehlende Spielerdaten: Paar „pair-1“ verweist auf fehlende Spieler-ID(s): „missing-men“, „missing-women“; Paar „pair-2“ verweist auf fehlende Spieler-ID(s): „missing-second-women“.';

  const parsed = parseTournamentBackup(backupFor(invalidTournament));
  assert.deepEqual(parsed, { success: false, message: expectedMessage });

  const result = importTournamentBackup(
    backupFor(invalidTournament),
    currentTournament,
    (importedTournament) => {
      importCalls += 1;
      displayedTournament = importedTournament;
    },
    () => {
      confirmationCalls += 1;
      return true;
    },
  );

  assert.deepEqual(result, { success: false, message: expectedMessage });
  assert.equal(importCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.equal(displayedTournament, currentTournament);
  assert.deepEqual(displayedTournament, currentTournament);
});

test('missing match players identify the match and side without changing the current tournament', async (t) => {
  const tournament = populatedTournament();
  const invalidMatches = [
    {
      name: 'side one',
      missingPlayerId: 'missing-side1',
      missingSide: 1,
      match: { ...tournament.matches[0], side1: ['missing-side1', 'w1'] as [string, string] },
    },
    {
      name: 'side two',
      missingPlayerId: 'missing-side2',
      missingSide: 2,
      match: { ...tournament.matches[0], side2: ['missing-side2', 'w2'] as [string, string] },
    },
  ];

  for (const { name, missingPlayerId, missingSide, match } of invalidMatches) {
    await t.test(name, () => {
      const currentTournament = populatedTournament();
      const invalidTournament = { ...tournament, matches: [match] };
      let displayedTournament = currentTournament;
      let importCalls = 0;
      let confirmationCalls = 0;
      const expectedMessage =
        `Die Sicherung enthält fehlende Spielerdaten: Spiel „match-1“ (Feld 1, Runde 1, Tisch 2): fehlende Spieler-ID(s) auf Seite ${missingSide}: „${missingPlayerId}“.`;

      const parsed = parseTournamentBackup(backupFor(invalidTournament));
      assert.deepEqual(parsed, { success: false, message: expectedMessage });

      const result = importTournamentBackup(
        backupFor(invalidTournament),
        currentTournament,
        (importedTournament) => {
          importCalls += 1;
          displayedTournament = importedTournament;
        },
        () => {
          confirmationCalls += 1;
          return true;
        },
      );

      assert.deepEqual(result, { success: false, message: expectedMessage });
      assert.equal(importCalls, 0);
      assert.equal(confirmationCalls, 0);
      assert.equal(displayedTournament, currentTournament);
      assert.deepEqual(displayedTournament, currentTournament);
    });
  }
});

test('backup references to missing groups are rejected without changing current tournament', async (t) => {
  const tournament = populatedTournament();
  const invalidBackups = [
    {
      name: 'player',
      expectedMessage: 'Spieler „Max“ (ID „m1“) verweist auf die nicht vorhandene Gruppe „missing“.',
      tournament: {
        ...tournament,
        players: [{ ...tournament.players[0], groupId: 'missing' }, ...tournament.players.slice(1)],
      },
    },
    {
      name: 'pair',
      expectedMessage: 'Paar „pair-1“ verweist auf die nicht vorhandene Gruppe „missing“.',
      tournament: {
        ...tournament,
        pairs: [{ ...tournament.pairs[0], groupId: 'missing' }],
      },
    },
    {
      name: 'match',
      expectedMessage: 'Spiel „match-1“ (Gruppe missing, Runde 1, Tisch 2) verweist auf eine ungültige Gruppe „missing“ für die Gruppenphase.',
      tournament: {
        ...tournament,
        matches: [{ ...tournament.matches[0], groupId: 'missing' }],
      },
    },
  ];

  for (const { name, expectedMessage, tournament: invalidTournament } of invalidBackups) {
    await t.test(name, () => {
      const currentTournament = populatedTournament();
      let displayedTournament = currentTournament;
      let importCalls = 0;
      let confirmationCalls = 0;

      const parsed = parseTournamentBackup(backupFor(invalidTournament));
      assert.deepEqual(parsed, { success: false, message: expectedMessage });

      const result = importTournamentBackup(
        backupFor(invalidTournament),
        currentTournament,
        (importedTournament) => {
          importCalls += 1;
          displayedTournament = importedTournament;
        },
        () => {
          confirmationCalls += 1;
          return true;
        },
      );

      assert.deepEqual(result, { success: false, message: expectedMessage });
      assert.equal(importCalls, 0);
      assert.equal(confirmationCalls, 0);
      assert.equal(displayedTournament, currentTournament);
      assert.deepEqual(displayedTournament, currentTournament);
    });
  }
});

test('pairs with mismatched player categories are rejected without changing current tournament', async (t) => {
  const tournament = populatedTournament();
  const invalidBackups = [
    {
      name: 'pair player roles are swapped',
      tournament: {
        ...tournament,
        pairs: [{
          ...tournament.pairs[0],
          menPlayerId: 'w1',
          womenPlayerId: 'm1',
        }],
      },
    },
    {
      name: 'men role references a woman player',
      tournament: {
        ...tournament,
        pairs: [{ ...tournament.pairs[0], menPlayerId: 'w1' }],
      },
    },
    {
      name: 'women role references a man player',
      tournament: {
        ...tournament,
        pairs: [{ ...tournament.pairs[0], womenPlayerId: 'm1' }],
      },
    },
  ];

  for (const { name, tournament: invalidTournament } of invalidBackups) {
    await t.test(name, () => {
      const currentTournament = populatedTournament();
      let displayedTournament = currentTournament;
      let importCalls = 0;
      let confirmationCalls = 0;

      const result = importTournamentBackup(
        backupFor(invalidTournament),
        currentTournament,
        (importedTournament) => {
          importCalls += 1;
          displayedTournament = importedTournament;
        },
        () => {
          confirmationCalls += 1;
          return true;
        },
      );

      assert.equal(result.success, false);
      if (!result.success) {
        assert.match(result.message, /Paar „pair-1“ hat unpassende Spielerrollen/);
        assert.match(result.message, /Männer-ID/);
        assert.match(result.message, /Frauen-ID/);
      }
      assert.equal(importCalls, 0);
      assert.equal(confirmationCalls, 0);
      assert.equal(displayedTournament, currentTournament);
      assert.deepEqual(displayedTournament, currentTournament);
    });
  }
});

test('pairs assigned to a different group than either player are rejected without changing current tournament', async (t) => {
  const tournament = populatedTournament();
  const invalidBackups = [
    {
      name: 'pair group differs from the man player group',
      mismatchedPlayer: 'Max (ID „m1“, Gruppe „g1“)',
      matchingPlayerName: 'Mia',
      tournament: {
        ...tournament,
        players: tournament.players.map((player) =>
          player.id === 'w1' ? { ...player, groupId: 'g2' } : player,
        ),
        pairs: [{ ...tournament.pairs[0], groupId: 'g2' }],
        groups: [...tournament.groups, { id: 'g2', name: 'Feld 2' }],
      },
    },
    {
      name: 'pair group differs from the woman player group',
      mismatchedPlayer: 'Mia (ID „w1“, Gruppe „g1“)',
      matchingPlayerName: 'Max',
      tournament: {
        ...tournament,
        players: tournament.players.map((player) =>
          player.id === 'm1' ? { ...player, groupId: 'g2' } : player,
        ),
        pairs: [{ ...tournament.pairs[0], groupId: 'g2' }],
        groups: [...tournament.groups, { id: 'g2', name: 'Feld 2' }],
      },
    },
  ];

  for (const { name, mismatchedPlayer, matchingPlayerName, tournament: invalidTournament } of invalidBackups) {
    await t.test(name, () => {
      const currentTournament = populatedTournament();
      let displayedTournament = currentTournament;
      let importCalls = 0;
      let confirmationCalls = 0;

      const result = importTournamentBackup(
        backupFor(invalidTournament),
        currentTournament,
        (importedTournament) => {
          importCalls += 1;
          displayedTournament = importedTournament;
        },
        () => {
          confirmationCalls += 1;
          return true;
        },
      );

      assert.equal(result.success, false);
      if (!result.success) {
        assert.match(result.message, /Paar „pair-1“ \(Max \+ Mia\)/);
        assert.match(result.message, /Gruppe „g2“/);
        const mismatchDetails = result.message.split('aber ')[1];
        assert.ok(mismatchDetails.includes(mismatchedPlayer));
        assert.ok(!mismatchDetails.includes(matchingPlayerName));
      }
      assert.equal(importCalls, 0);
      assert.equal(confirmationCalls, 0);
      assert.equal(displayedTournament, currentTournament);
      assert.deepEqual(displayedTournament, currentTournament);
    });
  }
});

test('players assigned to multiple pairs are rejected without changing current tournament', async (t) => {
  const tournament = populatedTournament();
  const manConflictPartner: Tournament['players'][number] = {
    id: 'w3',
    name: 'Wiebke',
    category: 'women',
    groupId: 'g1',
  };
  const womanConflictPartner: Tournament['players'][number] = {
    id: 'm3',
    name: 'Markus',
    category: 'men',
    groupId: 'g1',
  };
  const invalidBackups = [
    {
      name: 'a man is assigned to two pairs',
      expectedMessage: 'Spieler ist mehreren Paaren zugeordnet: Max (Spieler-ID „m1“) in Paar „pair-1“ (Max + Mia) und Paar „pair-3“ (Max + Wiebke).',
      extraPlayer: manConflictPartner,
      pairs: [...tournament.pairs, { id: 'pair-3', menPlayerId: 'm1', womenPlayerId: 'w3', groupId: 'g1' }],
    },
    {
      name: 'a woman is assigned to two pairs',
      expectedMessage: 'Spieler ist mehreren Paaren zugeordnet: Mia (Spieler-ID „w1“) in Paar „pair-1“ (Max + Mia) und Paar „pair-3“ (Markus + Mia).',
      extraPlayer: womanConflictPartner,
      pairs: [...tournament.pairs, { id: 'pair-3', menPlayerId: 'm3', womenPlayerId: 'w1', groupId: 'g1' }],
    },
  ];

  for (const { name, expectedMessage, extraPlayer, pairs } of invalidBackups) {
    await t.test(name, () => {
      const currentTournament = populatedTournament();
      const invalidTournament = { ...tournament, players: [...tournament.players, extraPlayer], pairs };
      let displayedTournament = currentTournament;
      let importCalls = 0;
      let confirmationCalls = 0;

      const result = importTournamentBackup(
        backupFor(invalidTournament),
        currentTournament,
        (importedTournament) => {
          importCalls += 1;
          displayedTournament = importedTournament;
        },
        () => {
          confirmationCalls += 1;
          return true;
        },
      );

      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(result.message, expectedMessage);
      }
      assert.equal(importCalls, 0);
      assert.equal(confirmationCalls, 0);
      assert.equal(displayedTournament, currentTournament);
      assert.deepEqual(displayedTournament, currentTournament);
    });
  }
});

test('backup with duplicate player IDs is rejected without changing current tournament', () => {
  const currentTournament = populatedTournament();
  const importedTournament = populatedTournament();
  const invalidTournament = {
    ...importedTournament,
    players: [
      ...importedTournament.players.slice(0, 1),
      { ...importedTournament.players[1], id: 'm1' },
      ...importedTournament.players.slice(2),
    ],
  };
  let displayedTournament = currentTournament;
  let importCalls = 0;
  let confirmationCalls = 0;

  const result = importTournamentBackup(
    backupFor(invalidTournament),
    currentTournament,
    (tournament) => {
      importCalls += 1;
      displayedTournament = tournament;
    },
    () => {
      confirmationCalls += 1;
      return true;
    },
  );

  assert.deepEqual(result, {
    success: false,
    message: 'Die Sicherung enthält doppelte Spieler-IDs.',
  });
  assert.equal(importCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.equal(displayedTournament, currentTournament);
  assert.deepEqual(displayedTournament, currentTournament);
});

test('matches with repeated player IDs are rejected without changing current tournament', async (t) => {
  const tournament = populatedTournament();
  const invalidMatches = [
    {
      name: 'the same player appears twice on side one',
      match: { ...tournament.matches[0], side1: ['m1', 'm1'] as [string, string] },
    },
    {
      name: 'the same player appears twice on side two',
      match: { ...tournament.matches[0], side2: ['m2', 'm2'] as [string, string] },
    },
    {
      name: 'the same player appears on both sides',
      match: { ...tournament.matches[0], side2: ['m1', 'w2'] as [string, string] },
    },
    {
      name: 'a bye repeats a player on side one',
      match: {
        ...tournament.matches[0],
        side1: ['m1', 'm1'] as [string, string],
        side2: null,
        isBye: true,
        sets: [],
        winnerSide: null,
        tableNumber: null,
      },
    },
  ];

  for (const { name, match } of invalidMatches) {
    await t.test(name, () => {
      const currentTournament = populatedTournament();
      const invalidTournament = { ...tournament, matches: [match] };
      let displayedTournament = currentTournament;
      let importCalls = 0;
      let confirmationCalls = 0;

      const result = importTournamentBackup(
        backupFor(invalidTournament),
        currentTournament,
        (importedTournament) => {
          importCalls += 1;
          displayedTournament = importedTournament;
        },
        () => {
          confirmationCalls += 1;
          return true;
        },
      );

      assert.equal(result.success, false);
      if (!result.success) {
        assert.match(result.message, /Spiel „match-1“/);
        assert.match(result.message, /enthält Spieler mehrfach/);
        const ids = [...match.side1, ...(match.side2 ?? [])];
        const duplicated = ids.find((id, index) => ids.indexOf(id) !== index);
        assert.ok(duplicated);
        assert.ok(result.message.includes(`„${duplicated}“`), result.message);
      }
      assert.equal(importCalls, 0);
      assert.equal(confirmationCalls, 0);
      assert.equal(displayedTournament, currentTournament);
      assert.deepEqual(displayedTournament, currentTournament);
    });
  }
});

test('all matches report missing player IDs across both sides without changing the current tournament', () => {
  const tournament = populatedTournament();
  const invalidTournament = {
    ...tournament,
    matches: [
      {
        ...tournament.matches[0],
        side1: ['missing-match-1-m1', 'missing-match-1-w1'] as [string, string],
        side2: ['missing-match-1-m2', 'missing-match-1-w2'] as [string, string],
      },
      {
        ...tournament.matches[0],
        id: 'match-2',
        round: 2,
        side1: ['missing-match-2-m1', 'missing-match-2-w1'] as [string, string],
        side2: ['missing-match-2-m2', 'missing-match-2-w2'] as [string, string],
      },
    ],
  };
  const currentTournament = populatedTournament();
  let importCalls = 0;
  let confirmationCalls = 0;
  const expectedMessage =
    'Die Sicherung enthält fehlende Spielerdaten: Spiel „match-1“ (Feld 1, Runde 1, Tisch 2): fehlende Spieler-ID(s) auf Seite 1: „missing-match-1-m1“, „missing-match-1-w1“; fehlende Spieler-ID(s) auf Seite 2: „missing-match-1-m2“, „missing-match-1-w2“; Spiel „match-2“ (Feld 1, Runde 2, Tisch 2): fehlende Spieler-ID(s) auf Seite 1: „missing-match-2-m1“, „missing-match-2-w1“; fehlende Spieler-ID(s) auf Seite 2: „missing-match-2-m2“, „missing-match-2-w2“.';

  const parsed = parseTournamentBackup(backupFor(invalidTournament));
  assert.deepEqual(parsed, { success: false, message: expectedMessage });

  const result = importTournamentBackup(
    backupFor(invalidTournament),
    currentTournament,
    () => { importCalls += 1; },
    () => { confirmationCalls += 1; return true; },
  );

  assert.deepEqual(result, { success: false, message: expectedMessage });
  assert.equal(importCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(currentTournament, populatedTournament());
});

test('group match sides must match pairs registered in that group', () => {
  const tournament = populatedTournament();
  const currentTournament = populatedTournament();
  const invalidTournament = {
    ...tournament,
    matches: [{
      ...tournament.matches[0],
      side1: ['m1', 'w2'] as [string, string],
      side2: ['m2', 'w1'] as [string, string],
    }],
  };
  let imported: Tournament | null = null;

  const result = importTournamentBackup(
    backupFor(invalidTournament),
    currentTournament,
    (replacement) => { imported = replacement; },
    () => true,
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.message, /Spiel „match-1“/);
    assert.match(result.message, /Seite 1/);
    assert.match(result.message, /Max \+ Wanda/);
    assert.match(result.message, /angemeldeten Paar/);
  }
  assert.equal(imported, null);
  assert.deepEqual(currentTournament, populatedTournament());
});

test('group matches are rejected when the backup has no registered pairs', () => {
  const tournament = populatedTournament();
  const invalidTournament = { ...tournament, pairs: [] };
  const currentTournament = populatedTournament();
  let importCalls = 0;
  let confirmationCalls = 0;

  const result = importTournamentBackup(
    backupFor(invalidTournament),
    currentTournament,
    () => { importCalls += 1; },
    () => { confirmationCalls += 1; return true; },
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.message, /Spiel „match-1“/);
    assert.match(result.message, /Seite 1/);
    assert.match(result.message, /Max \+ Mia/);
    assert.match(result.message, /angemeldeten Paar/);
  }
  assert.equal(importCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(currentTournament, populatedTournament());
});

test('a player cannot be scheduled in two matches in the same stage and round', () => {
  const tournament = populatedTournament();
  const currentTournament = populatedTournament();
  const invalidTournament = {
    ...tournament,
    matches: [
      tournament.matches[0],
      { ...tournament.matches[0], id: 'match-2' },
    ],
  };
  let imported = false;

  const result = importTournamentBackup(
    backupFor(invalidTournament),
    currentTournament,
    () => { imported = true; },
    () => true,
  );

  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.message, /Spieler-ID „m1“/);
    assert.match(result.message, /Spiel „match-1“/);
    assert.match(result.message, /Spiel „match-2“/);
    assert.match(result.message, /Runde 1/);
  }
  assert.equal(imported, false);
  assert.deepEqual(currentTournament, populatedTournament());
});

test('a player can be scheduled in matches across separate rounds', () => {
  const tournament = populatedTournament();
  const secondRoundMatch = {
    ...tournament.matches[0],
    id: 'match-2',
    round: tournament.matches[0].round + 1,
  };
  const backupTournament = {
    ...tournament,
    matches: [tournament.matches[0], secondRoundMatch],
  };
  const currentTournament = populatedTournament();
  let importedTournament: Tournament | null = null;

  const result = importTournamentBackup(
    backupFor(backupTournament),
    currentTournament,
    (imported) => { importedTournament = imported; },
    () => true,
  );

  assert.deepEqual(result, { success: true, imported: true });
  assert.deepEqual(importedTournament?.matches, backupTournament.matches);
  assert.deepEqual(currentTournament, populatedTournament());
});

test('backups with duplicate pair, group, or match IDs are rejected without changing current tournament', async (t) => {
  const tournament = populatedTournament();
  const invalidBackups = [
    {
      name: 'pair IDs',
      expectedMessage: 'Die Sicherung enthält doppelte Paar-IDs.',
      tournament: {
        ...tournament,
        pairs: [...tournament.pairs, { ...tournament.pairs[0] }],
      },
    },
    {
      name: 'group IDs',
      expectedMessage: 'Die Sicherung enthält doppelte Gruppen-IDs.',
      tournament: {
        ...tournament,
        groups: [...tournament.groups, { ...tournament.groups[0] }],
      },
    },
    {
      name: 'match IDs',
      expectedMessage: 'Die Sicherung enthält doppelte Spiel-IDs.',
      tournament: {
        ...tournament,
        matches: [...tournament.matches, { ...tournament.matches[0] }],
      },
    },
  ];

  for (const { name, expectedMessage, tournament: invalidTournament } of invalidBackups) {
    await t.test(name, () => {
      const currentTournament = populatedTournament();
      let displayedTournament = currentTournament;
      let importCalls = 0;
      let confirmationCalls = 0;

      const result = importTournamentBackup(
        backupFor(invalidTournament),
        currentTournament,
        (importedTournament) => {
          importCalls += 1;
          displayedTournament = importedTournament;
        },
        () => {
          confirmationCalls += 1;
          return true;
        },
      );

      assert.deepEqual(result, { success: false, message: expectedMessage });
      assert.equal(importCalls, 0);
      assert.equal(confirmationCalls, 0);
      assert.equal(displayedTournament, currentTournament);
      assert.deepEqual(displayedTournament, currentTournament);
    });
  }
});

test('a contradictory result is rejected without changing current tournament', () => {
  const currentTournament = populatedTournament();
  const invalidTournament = populatedTournament();
  invalidTournament.matches[0] = { ...invalidTournament.matches[0], winnerSide: 2 };
  let displayedTournament = currentTournament;
  let importCalls = 0;
  let confirmationCalls = 0;

  const result = importTournamentBackup(
    backupFor(invalidTournament),
    currentTournament,
    (tournament) => {
      importCalls += 1;
      displayedTournament = tournament;
    },
    () => {
      confirmationCalls += 1;
      return true;
    },
  );

  assert.deepEqual(result, {
    success: false,
    message: 'Die Sicherung enthält ein widersprüchliches Spielergebnis bei Spiel „match-1“ (Feld 1, Runde 1, Tisch 2) zwischen Max + Mia und Moritz + Wanda: Der eingetragene Sieger stimmt nicht mit den Satzergebnissen überein.',
  });
  assert.equal(importCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.equal(displayedTournament, currentTournament);
  assert.deepEqual(displayedTournament, currentTournament);
});

test('rejected or cancelled imports leave current tournament data untouched', () => {
  const currentTournament = populatedTournament();
  let displayedTournament = currentTournament;
  let importCalls = 0;
  let recoveryCalls = 0;
  const onImport = (tournament: Tournament) => {
    importCalls += 1;
    displayedTournament = tournament;
  };

  const invalid = importTournamentBackup(
    '{',
    displayedTournament,
    onImport,
    () => true,
    () => { recoveryCalls += 1; },
  );
  const cancelled = importTournamentBackup(
    backupFor(blankTournament('2026-11-14')),
    displayedTournament,
    onImport,
    () => false,
    () => { recoveryCalls += 1; },
  );

  assert.equal(invalid.success, false);
  assert.deepEqual(cancelled, { success: true, imported: false });
  assert.equal(importCalls, 0);
  assert.equal(recoveryCalls, 0);
  assert.equal(displayedTournament, currentTournament);
});

test('a valid import saves the current tournament first and the recovery copy can be restored', () => {
  const currentTournament = populatedTournament();
  const replacement = blankTournament('2026-11-15');
  let displayedTournament = currentTournament;
  let confirmationMessage = '';
  const storage = new Map<string, string>();
  const operationOrder: string[] = [];

  const result = importTournamentBackup(
    backupFor(replacement),
    displayedTournament,
    (tournament) => { operationOrder.push('import'); displayedTournament = tournament; },
    (message) => { confirmationMessage = message; return true; },
    (current) => {
      operationOrder.push('recovery');
      const saved = saveTournamentRecoveryCopy(current, {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => { storage.set(key, value); },
      });
      if (!saved.success) throw new Error(saved.message);
    },
  );

  assert.deepEqual(result, { success: true, imported: true });
  assert.match(confirmationMessage, /wird durch die Sicherung ersetzt/);
  assert.deepEqual(displayedTournament, replacement);
  assert.deepEqual(operationOrder, ['recovery', 'import']);

  const copies = loadTournamentRecoveryCopies({ getItem: (key) => storage.get(key) ?? null });
  assert.equal(copies.length, 1);
  const recoveryRaw = copies[0]?.raw;
  assert.ok(recoveryRaw);
  const recovery = parseTournamentBackup(recoveryRaw);
  assert.equal(recovery.success, true);
  if (!recovery.success) return;
  assert.deepEqual(recovery.tournament, currentTournament);

  let restoredTournament = replacement;
  const restoreResult = importTournamentBackup(
    recoveryRaw,
    replacement,
    (tournament) => { restoredTournament = tournament; },
    () => true,
  );
  assert.deepEqual(restoreResult, { success: true, imported: true });
  assert.deepEqual(restoredTournament, currentTournament);
});

test('an import is not applied if the recovery copy cannot be saved', () => {
  const currentTournament = populatedTournament();
  let displayedTournament = currentTournament;

  const result = importTournamentBackup(
    backupFor(blankTournament('2026-11-15')),
    currentTournament,
    (tournament) => { displayedTournament = tournament; },
    () => true,
    (current) => {
      const saved = saveTournamentRecoveryCopy(current, {
        getItem: () => null,
        setItem: () => { throw new Error('storage unavailable'); },
      });
      if (!saved.success) throw new Error(saved.message);
    },
  );

  assert.equal(result.success, false);
  if (!result.success) assert.match(result.message, /Wiederherstellungskopie konnte nicht gespeichert werden/);
  assert.deepEqual(displayedTournament, currentTournament);
});

test('each repeated replacement records a separately dated recovery copy', () => {
  const storage = new Map<string, string>();
  const tournament = populatedTournament();
  const storageAdapter = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };

  const first = saveTournamentRecoveryCopy(tournament, storageAdapter);
  const second = saveTournamentRecoveryCopy(tournament, storageAdapter);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  if (!first.success || !second.success) return;
  assert.notEqual(first.raw, second.raw);
  const copies = loadTournamentRecoveryCopies(storageAdapter);
  assert.equal(copies.length, 2);
  assert.ok(Date.parse(copies[0].savedAt) > Date.parse(copies[1].savedAt));
  assert.deepEqual(parseTournamentBackup(copies[0].raw), {
    success: true,
    tournament,
  });
  assert.deepEqual(parseTournamentBackup(copies[1].raw), {
    success: true,
    tournament,
  });
});

test('recovery copy download preserves the exact importable backup content', () => {
  const tournament = populatedTournament();
  const storage = new Map<string, string>();
  const saved = saveTournamentRecoveryCopy(tournament, {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
  });
  assert.equal(saved.success, true);
  if (!saved.success) return;

  const copy = loadTournamentRecoveryCopies({ getItem: (key) => storage.get(key) ?? null })[0];
  assert.ok(copy);
  const download = recoveryCopyDownload(copy);
  assert.ok(download);
  if (!download) return;

  assert.equal(download.raw, copy.raw);
  assert.equal(download.fileName, `turnier-wiederherstellung-${copy.savedAt.slice(0, 10)}.json`);
  const imported = importTournamentBackup(download.raw, blankTournament('2026-11-15'), () => {}, () => true);
  assert.deepEqual(imported, { success: true, imported: true });
});

test('recovery history keeps the newest copies within its storage limit and reads old single-copy data', () => {
  const storage = new Map<string, string>();
  for (let index = 0; index < MAX_RECOVERY_COPIES + 2; index += 1) {
    const tournament = { ...populatedTournament(), name: `Turnier ${index}` };
    const result = saveTournamentRecoveryCopy(tournament, {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
    });
    assert.equal(result.success, true);
  }

  const copies = loadTournamentRecoveryCopies({ getItem: (key) => storage.get(key) ?? null });
  assert.equal(copies.length, MAX_RECOVERY_COPIES);
  assert.equal(parseTournamentBackup(copies[0].raw).success, true);
  const newest = parseTournamentBackup(copies[0].raw);
  assert.equal(newest.success && newest.tournament.name, `Turnier ${MAX_RECOVERY_COPIES + 1}`);

  const legacyRaw = backupFor(populatedTournament());
  assert.equal(
    loadTournamentRecoveryCopies({ getItem: () => legacyRaw }).length,
    1,
    'a previously stored single recovery backup should remain available',
  );
});
