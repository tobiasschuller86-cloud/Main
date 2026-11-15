import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blankTournament,
  findLikelyPlayerNameMatches,
  findMissingPairPlayers,
  findPairRosterConflicts,
  parseTournamentWorkspaceIndex,
  playerNameDuplicateKey,
  removePairAndOrphanedPlayers,
  selectTournamentWorkspace,
  upsertTournamentWorkspace,
  updateRegisteredPair,
  type Tournament,
} from './tournament';

function savedTournament(): Tournament {
  return {
    ...blankTournament('2026-11-14'),
    players: [
      { id: 'm1', name: 'Max', category: 'men', groupId: '' },
      { id: 'w1', name: 'Mia', category: 'women', groupId: '' },
      { id: 'm2', name: 'Moritz', category: 'men', groupId: '' },
      { id: 'w2', name: 'Wanda', category: 'women', groupId: '' },
    ],
    pairs: [
      { id: 'pair-1', menPlayerId: 'm1', womenPlayerId: 'w1', groupId: '' },
      { id: 'pair-2', menPlayerId: 'm2', womenPlayerId: 'w2', groupId: '' },
    ],
  };
}

test('composed and decomposed accented names share a duplicate key without changing display text', () => {
  const composed = 'José';
  const decomposed = 'Jose\u0301';

  assert.equal(playerNameDuplicateKey(composed), playerNameDuplicateKey(decomposed));
  assert.equal(composed, 'José');
  assert.equal(decomposed, 'Jose\u0301');
});

test('workspace index rejects duplicate IDs and a missing active tournament', () => {
  assert.equal(parseTournamentWorkspaceIndex(JSON.stringify({
    activeId: 'a',
    workspaces: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }],
  })), null);
  assert.equal(parseTournamentWorkspaceIndex(JSON.stringify({
    activeId: 'missing',
    workspaces: [{ id: 'a', name: 'A' }],
  })), null);
});

test('switching active tournament leaves every saved workspace entry unchanged', () => {
  const original = {
    activeId: 'spring',
    workspaces: [
      { id: 'spring', name: 'Spring Cup' },
      { id: 'autumn', name: 'Autumn Cup' },
    ],
  };

  assert.deepEqual(selectTournamentWorkspace(original, 'autumn'), {
    activeId: 'autumn',
    workspaces: original.workspaces,
  });
  assert.equal(selectTournamentWorkspace(original, 'unknown'), original);
});

test('renaming a workspace updates only its summary', () => {
  const original = {
    activeId: 'spring',
    workspaces: [
      { id: 'spring', name: 'Spring Cup' },
      { id: 'autumn', name: 'Autumn Cup' },
    ],
  };

  assert.deepEqual(upsertTournamentWorkspace(original, { id: 'spring', name: 'Spring Open' }), {
    activeId: 'spring',
    workspaces: [
      { id: 'spring', name: 'Spring Open' },
      { id: 'autumn', name: 'Autumn Cup' },
    ],
  });
  assert.equal(upsertTournamentWorkspace(original, { id: 'winter', name: 'Winter Cup' }).workspaces.length, 3);
});

test('a saved tournament with distinct pair rosters has no conflicts', () => {
  assert.deepEqual(findPairRosterConflicts(savedTournament()), []);
});

test('a valid saved roster has no missing player references', () => {
  assert.deepEqual(findMissingPairPlayers(savedTournament()), []);
});

test('a saved player assigned to multiple pairs is reported without changing tournament data', () => {
  const tournament = savedTournament();
  tournament.pairs[1] = { ...tournament.pairs[1], menPlayerId: 'm1' };
  const savedState = structuredClone(tournament);

  assert.deepEqual(findPairRosterConflicts(tournament), [
    { playerId: 'm1', pairIds: ['pair-1', 'pair-2'] },
  ]);
  assert.deepEqual(tournament, savedState);
});

test('missing player references identify every affected pair without changing saved data', () => {
  const tournament = savedTournament();
  tournament.pairs[0] = { ...tournament.pairs[0], menPlayerId: 'missing-man' };
  tournament.pairs[1] = { ...tournament.pairs[1], menPlayerId: 'missing-man', womenPlayerId: 'missing-woman' };
  const savedState = structuredClone(tournament);

  assert.deepEqual(findMissingPairPlayers(tournament), [
    { playerId: 'missing-man', pairIds: ['pair-1', 'pair-2'] },
    { playerId: 'missing-woman', pairIds: ['pair-2'] },
  ]);
  assert.deepEqual(tournament, savedState);
});

test('likely name typos are suggested but exact duplicates and short names are ignored', () => {
  assert.deepEqual(findLikelyPlayerNameMatches('Moritz', ['Moritz', 'Moriz', 'Mia']), ['Moriz']);
  assert.deepEqual(findLikelyPlayerNameMatches('Jose\u0301', ['José']), []);
  assert.deepEqual(findLikelyPlayerNameMatches('Tom', ['Tim']), []);
});

test('removing one conflicting pair keeps its shared player registered to the remaining pair', () => {
  const tournament = savedTournament();
  tournament.pairs[1] = { ...tournament.pairs[1], menPlayerId: 'm1' };

  const repaired = removePairAndOrphanedPlayers(tournament, 'pair-1');
  const remainingPair = repaired.pairs[0];

  assert.deepEqual(repaired.pairs.map((pair) => pair.id), ['pair-2']);
  assert.ok(repaired.players.some((player) => player.id === 'm1'));
  assert.ok(repaired.players.some((player) => player.id === remainingPair.menPlayerId));
  assert.ok(repaired.players.some((player) => player.id === remainingPair.womenPlayerId));
  assert.deepEqual(
    repaired.pairs.flatMap((pair) => [pair.menPlayerId, pair.womenPlayerId])
      .filter((playerId) => !repaired.players.some((player) => player.id === playerId)),
    [],
  );
  assert.deepEqual(findPairRosterConflicts({ pairs: repaired.pairs }), []);
});

test('editing a conflicting pair replaces only its duplicate player record', () => {
  const tournament = savedTournament();
  tournament.pairs[1] = { ...tournament.pairs[1], menPlayerId: 'm1' };

  const repaired = updateRegisteredPair(
    tournament,
    'pair-2',
    { men: 'Marek', women: 'Wanda' },
    undefined,
    () => 'm3',
  );
  const originalPair = repaired.pairs.find((pair) => pair.id === 'pair-1');
  const editedPair = repaired.pairs.find((pair) => pair.id === 'pair-2');
  const replacement = repaired.players.find((player) => player.id === editedPair?.menPlayerId);

  assert.equal(originalPair?.menPlayerId, 'm1');
  assert.equal(repaired.players.find((player) => player.id === 'm1')?.name, 'Max');
  assert.equal(replacement?.id, 'm3');
  assert.equal(replacement?.name, 'Marek');
  assert.equal(new Set(repaired.players.map((player) => player.id)).size, repaired.players.length);
  assert.deepEqual(findPairRosterConflicts({ pairs: repaired.pairs }), []);
  assert.deepEqual(
    repaired.pairs.flatMap((pair) => [pair.menPlayerId, pair.womenPlayerId])
      .filter((playerId) => !repaired.players.some((player) => player.id === playerId)),
    [],
  );
});

test('editing one unshared player changes only that name and retains pair and player IDs', () => {
  const tournament = savedTournament();
  tournament.players[0].club = 'TTC Nord';
  tournament.players[1].club = 'TTC Nord';
  const repaired = updateRegisteredPair(
    tournament,
    'pair-1',
    { men: '  Max Neu  ', women: 'Mia' },
    'TTC Nord',
    () => 'unused',
  );

  const expectedPlayers = structuredClone(tournament.players);
  expectedPlayers.find((player) => player.id === 'm1')!.name = 'Max Neu';
  assert.deepEqual(repaired, {
    players: expectedPlayers,
    pairs: tournament.pairs,
  });
  assert.deepEqual(repaired.pairs.map((pair) => pair.id), ['pair-1', 'pair-2']);
  assert.deepEqual(
    repaired.pairs.flatMap((pair) => [pair.menPlayerId, pair.womenPlayerId]),
    ['m1', 'w1', 'm2', 'w2'],
  );
});

test('editing a pair replaces a missing player reference with a registered player', () => {
  const tournament = savedTournament();
  tournament.pairs[0] = { ...tournament.pairs[0], womenPlayerId: 'missing-woman' };
  const repaired = updateRegisteredPair(
    tournament,
    'pair-1',
    { men: 'Max', women: 'Wiebke' },
    'TTC Nord',
    () => 'replacement-w1',
  );
  const pair = repaired.pairs.find((candidate) => candidate.id === 'pair-1');
  const replacement = repaired.players.find((player) => player.id === pair?.womenPlayerId);

  assert.equal(pair?.id, 'pair-1');
  assert.equal(pair?.menPlayerId, 'm1');
  assert.equal(pair?.womenPlayerId, 'replacement-w1');
  assert.deepEqual(replacement, {
    id: 'replacement-w1',
    name: 'Wiebke',
    club: 'TTC Nord',
    category: 'women',
    groupId: '',
  });
  assert.deepEqual(findMissingPairPlayers(repaired), []);
});
