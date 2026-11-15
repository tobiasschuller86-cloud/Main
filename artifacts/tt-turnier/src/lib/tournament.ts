export type Category = 'men' | 'women';
export type MatchSide = [string, string];
export type SetScore = { p1: number; p2: number };

export function playerNameDuplicateKey(name: string): string {
  return name.normalize('NFC').trim().toLocaleLowerCase('de');
}

export function parseSetScoreInput(value: string): SetScore | null | undefined {
  const input = value.trim().replace('−', '-');
  if (!input) return null;

  let score: SetScore | null = null;
  const shorthand = /^([+-]?)\s*(\d{1,2})$/.exec(input);
  if (shorthand) {
    const points = Number(shorthand[2]);
    const winnerPoints = Math.max(11, points + 2);
    score = shorthand[1] !== '-'
      ? { p1: winnerPoints, p2: points }
      : { p1: points, p2: winnerPoints };
  } else {
    const complete = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(input);
    if (!complete) return undefined;
    score = { p1: Number(complete[1]), p2: Number(complete[2]) };
  }

  if (score.p1 === score.p2 || Math.max(score.p1, score.p2) < 11 || Math.abs(score.p1 - score.p2) < 2) {
    return undefined;
  }
  return score;
}

export function resolveBestOfThree(sets: SetScore[]):
  | { ok: true; winnerSide: 1 | 2 }
  | { ok: false; reason: 'extra-sets' | 'not-decided' } {
  let side1Wins = 0;
  let side2Wins = 0;
  for (const set of sets) {
    if (side1Wins === 2 || side2Wins === 2) return { ok: false, reason: 'extra-sets' };
    if (set.p1 > set.p2) side1Wins += 1;
    else side2Wins += 1;
  }
  if (side1Wins === 2) return { ok: true, winnerSide: 1 };
  if (side2Wins === 2) return { ok: true, winnerSide: 2 };
  return { ok: false, reason: 'not-decided' };
}

export type Player = {
  id: string;
  name: string;
  club?: string;
  category: Category;
  groupId: string;
};

export type RegisteredPair = {
  id: string;
  menPlayerId: string;
  womenPlayerId: string;
  groupId: string;
};

export type Group = { id: string; name: string };

export type Match = {
  id: string;
  stage: 'group' | 'knockout';
  round: number;
  groupId: string | null;
  side1: MatchSide;
  side2: MatchSide | null;
  status: 'pending' | 'in_progress' | 'completed';
  sets: SetScore[];
  winnerSide: 1 | 2 | null;
  tableNumber: number | null;
  isBye?: boolean;
  isThirdPlace?: boolean;
};

export function matchResultIsConsistent(match: Match): boolean {
  if (match.isBye || match.side2 === null) {
    return match.isBye === true
      && match.side2 === null
      && match.status === 'completed'
      && match.sets.length === 0
      && match.winnerSide === 1;
  }

  if (match.status !== 'completed') {
    return match.sets.length === 0 && match.winnerSide === null;
  }

  if (match.winnerSide === null || match.sets.length === 0) return false;
  if (match.sets.some((set) => parseSetScoreInput(`${set.p1}:${set.p2}`) === undefined)) return false;

  const resolution = resolveBestOfThree(match.sets);
  return resolution.ok && resolution.winnerSide === match.winnerSide;
}

export type Tournament = {
  name: string;
  date: string;
  venue: string;
  tableCount: number;
  groupRounds: number;
  qualifiersPerGroup: number;
  phase: 'setup' | 'groups' | 'knockout' | 'finished';
  players: Player[];
  pairs: RegisteredPair[];
  groups: Group[];
  matches: Match[];
  qualifiedIds: string[];
  legacyParticipantNames?: string[];
};

export type TournamentWorkspaceSummary = { id: string; name: string };
export type TournamentWorkspaceIndex = {
  activeId: string;
  workspaces: TournamentWorkspaceSummary[];
};

export function parseTournamentWorkspaceIndex(raw: string): TournamentWorkspaceIndex | null {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const candidate = input as { activeId?: unknown; workspaces?: unknown };
  if (typeof candidate.activeId !== 'string' || !Array.isArray(candidate.workspaces)) return null;
  if (candidate.workspaces.some((workspace) =>
    !workspace
    || typeof workspace !== 'object'
    || Array.isArray(workspace)
    || typeof (workspace as { id?: unknown }).id !== 'string'
    || !(workspace as { id: string }).id
    || typeof (workspace as { name?: unknown }).name !== 'string',
  )) return null;

  const workspaces = candidate.workspaces as TournamentWorkspaceSummary[];
  const ids = workspaces.map((workspace) => workspace.id);
  if (new Set(ids).size !== ids.length || !ids.includes(candidate.activeId)) return null;
  return { activeId: candidate.activeId, workspaces };
}

export function selectTournamentWorkspace(
  index: TournamentWorkspaceIndex,
  id: string,
): TournamentWorkspaceIndex {
  return index.workspaces.some((workspace) => workspace.id === id)
    ? { ...index, activeId: id }
    : index;
}

export function upsertTournamentWorkspace(
  index: TournamentWorkspaceIndex,
  workspace: TournamentWorkspaceSummary,
): TournamentWorkspaceIndex {
  const exists = index.workspaces.some((candidate) => candidate.id === workspace.id);
  return {
    ...index,
    workspaces: exists
      ? index.workspaces.map((candidate) => candidate.id === workspace.id ? workspace : candidate)
      : [...index.workspaces, workspace],
  };
}

export type Standing = {
  player: Player;
  wins: number;
  losses: number;
  setsFor: number;
  setsAgainst: number;
  pointsFor: number;
  pointsAgainst: number;
};

export type BracketRound = { round: number; matches: Match[]; byes: Match[] };
export type BracketProgress = {
  rounds: BracketRound[];
  current: BracketRound | undefined;
  currentComplete: boolean;
  championIds: MatchSide | null;
};

export type MixedTeams = { teams: MatchSide[]; byeTeam: MatchSide | null };

type IdFactory = () => string;

export const blankTournament = (date: string): Tournament => ({
  name: '',
  date,
  venue: '',
  tableCount: 4,
  groupRounds: 3,
  qualifiersPerGroup: 2,
  phase: 'setup',
  players: [],
  pairs: [],
  groups: [],
  matches: [],
  qualifiedIds: [],
});

export const playerById = (tournament: Tournament, id: string | null | undefined) =>
  tournament.players.find((player) => player.id === id);

export type PairRosterConflict = {
  playerId: string;
  pairIds: string[];
};

export function findPairRosterConflicts(tournament: Pick<Tournament, 'pairs'>): PairRosterConflict[] {
  const pairIdsByPlayer = new Map<string, Set<string>>();
  tournament.pairs.forEach((pair) => {
    [pair.menPlayerId, pair.womenPlayerId].forEach((playerId) => {
      const pairIds = pairIdsByPlayer.get(playerId) ?? new Set<string>();
      pairIds.add(pair.id);
      pairIdsByPlayer.set(playerId, pairIds);
    });
  });
  return [...pairIdsByPlayer]
    .filter(([, pairIds]) => pairIds.size > 1)
    .map(([playerId, pairIds]) => ({ playerId, pairIds: [...pairIds] }));
}

export function findMissingPairPlayers(
  tournament: Pick<Tournament, 'players' | 'pairs'>,
): PairRosterConflict[] {
  const registeredPlayerIds = new Set(tournament.players.map((player) => player.id));
  const pairIdsByMissingPlayer = new Map<string, Set<string>>();
  tournament.pairs.forEach((pair) => {
    [pair.menPlayerId, pair.womenPlayerId].forEach((playerId) => {
      if (registeredPlayerIds.has(playerId)) return;
      const pairIds = pairIdsByMissingPlayer.get(playerId) ?? new Set<string>();
      pairIds.add(pair.id);
      pairIdsByMissingPlayer.set(playerId, pairIds);
    });
  });
  return [...pairIdsByMissingPlayer]
    .map(([playerId, pairIds]) => ({ playerId, pairIds: [...pairIds] }));
}

function normalizedPlayerName(name: string): string {
  return name.normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLocaleLowerCase('de')
    .replace(/[^\p{Letter}\p{Number} ]/gu, '')
    .replace(/\s+/g, ' ');
}

function editDistance(first: string, second: string): number {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    let diagonal = previous[0];
    previous[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      const above = previous[secondIndex];
      previous[secondIndex] = Math.min(
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + 1,
        diagonal + Number(first[firstIndex - 1] !== second[secondIndex - 1]),
      );
      diagonal = above;
    }
  }
  return previous[second.length];
}

export function findLikelyPlayerNameMatches(name: string, otherNames: string[]): string[] {
  const normalizedName = normalizedPlayerName(name);
  if (normalizedName.length < 4) return [];
  const allowedDistance = normalizedName.length >= 8 ? 2 : 1;
  return [...new Set(otherNames.filter((otherName) => {
    const normalizedOther = normalizedPlayerName(otherName);
    return normalizedOther !== normalizedName
      && normalizedOther.length >= 4
      && Math.abs(normalizedOther.length - normalizedName.length) <= allowedDistance
      && editDistance(normalizedName, normalizedOther) <= allowedDistance;
  }))];
}

export function updateRegisteredPair(
  tournament: Pick<Tournament, 'players' | 'pairs'>,
  pairId: string,
  names: { men: string; women: string },
  club: string | undefined,
  createId: IdFactory,
): Pick<Tournament, 'players' | 'pairs'> {
  const pair = tournament.pairs.find((candidate) => candidate.id === pairId);
  if (!pair) return { players: tournament.players, pairs: tournament.pairs };

  const sharedPlayerIds = new Set(
    tournament.pairs
      .filter((candidate) => candidate.id !== pairId)
      .flatMap((candidate) => [candidate.menPlayerId, candidate.womenPlayerId]),
  );
  const updatedPlayerIds = {
    men: pair.menPlayerId,
    women: pair.womenPlayerId,
  };
  const replacementPlayers: Player[] = [];
  const players = tournament.players.map((player) => {
    const slot = player.id === pair.menPlayerId
      ? 'men'
      : player.id === pair.womenPlayerId
        ? 'women'
        : null;
    if (!slot) return player;

     const name = names[slot].trim();
    if (sharedPlayerIds.has(player.id)) {
      if (player.name === name) return player;
      const id = createId();
      updatedPlayerIds[slot] = id;
      replacementPlayers.push({ ...player, id, name, club });
      return player;
    }
    return { ...player, name, club };
  });
  for (const slot of ['men', 'women'] as const) {
    if (
      players.some((player) => player.id === updatedPlayerIds[slot])
      || replacementPlayers.some((player) => player.id === updatedPlayerIds[slot])
    ) continue;
    const id = createId();
    updatedPlayerIds[slot] = id;
    replacementPlayers.push({
      id,
      name: names[slot].trim(),
      club,
      category: slot,
      groupId: '',
    });
  }
  const pairs = tournament.pairs.map((candidate) => {
    if (candidate.id !== pairId) return candidate;
    return {
      ...candidate,
      menPlayerId: updatedPlayerIds.men,
      womenPlayerId: updatedPlayerIds.women,
      groupId: '',
    };
  });
  return { players: [...players, ...replacementPlayers], pairs };
}

export function removePairAndOrphanedPlayers(
  tournament: Pick<Tournament, 'players' | 'pairs'>,
  pairId: string,
): Pick<Tournament, 'players' | 'pairs'> {
  const removedPair = tournament.pairs.find((pair) => pair.id === pairId);
  const pairs = tournament.pairs.filter((pair) => pair.id !== pairId);
  if (!removedPair) return { players: tournament.players, pairs };

  const removedPlayerIds = new Set([removedPair.menPlayerId, removedPair.womenPlayerId]);
  const retainedPlayerIds = new Set(pairs.flatMap((pair) => [pair.menPlayerId, pair.womenPlayerId]));
  const players = tournament.players.filter((player) =>
    !removedPlayerIds.has(player.id) || retainedPlayerIds.has(player.id),
  );
  return { players, pairs };
}

export const teamLabel = (tournament: Tournament, side: MatchSide | null) =>
  side?.map((id) => playerById(tournament, id)?.name ?? 'Offen').join(' + ') ?? 'Freilos';

export function currentRoundNumber(tournament: Tournament, stage: Match['stage']): number {
  const matches = tournament.matches.filter((match) => match.stage === stage && !match.isBye);
  const unfinishedRounds = matches
    .filter((match) => match.status !== 'completed')
    .map((match) => match.round);
  return unfinishedRounds.length
    ? Math.min(...unfinishedRounds)
    : Math.max(0, ...matches.map((match) => match.round));
}

const shuffled = <T,>(items: T[]) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

const addPartnerHistory = (history: Map<string, Set<string>>, side: MatchSide) => {
  const [first, second] = side;
  if (!history.has(first)) history.set(first, new Set());
  if (!history.has(second)) history.set(second, new Set());
  history.get(first)?.add(second);
  history.get(second)?.add(first);
};

export function partnerHistoryFor(tournament: Tournament): Map<string, Set<string>> {
  const history = new Map<string, Set<string>>();
  tournament.pairs.forEach((pair) => addPartnerHistory(history, [pair.menPlayerId, pair.womenPlayerId]));
  tournament.matches.forEach((match) => {
    if (!match.isBye) {
      addPartnerHistory(history, match.side1);
      if (match.side2) addPartnerHistory(history, match.side2);
    }
  });
  return history;
}

type TeamMatchup = [MatchSide, MatchSide];

function opponentMatchupKey(team1: MatchSide, team2: MatchSide): string {
  const sides = [
    [...team1].sort(),
    [...team2].sort(),
  ].sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
  return JSON.stringify(sides);
}

function addOpponentHistory(history: Set<string>, matches: Match[]) {
  matches.forEach((match) => {
    if (match.stage === 'group' && !match.isBye && match.side2) {
      history.add(opponentMatchupKey(match.side1, match.side2));
    }
  });
}

function opponentHistoryFor(matches: Match[]): Set<string> {
  const history = new Set<string>();
  addOpponentHistory(history, matches);
  return history;
}

function findUnrepeatedOpponentMatchups(
  teams: MatchSide[],
  history: ReadonlySet<string>,
  extraBye: MatchSide | null,
): { pairings: TeamMatchup[]; byeTeams: MatchSide[] } | null {
  const byeOptions: Array<MatchSide | null> = teams.length % 2 ? shuffled(teams) : [null];
  const pairings: TeamMatchup[] = [];
  let searchedNodes = 0;
  // Keep an unusually large or impossible search from blocking the interface.
  const searchLimit = 20_000;

  const search = (remaining: MatchSide[]): boolean => {
    if (!remaining.length) return true;
    if (searchedNodes >= searchLimit) return false;
    searchedNodes += 1;

    const [first, ...rest] = remaining;
    const possibleOpponents = shuffled(rest).filter(
      (candidate) => !history.has(opponentMatchupKey(first, candidate)),
    );
    for (const opponent of possibleOpponents) {
      pairings.push([first, opponent]);
      if (search(rest.filter((candidate) => candidate !== opponent))) return true;
      pairings.pop();
    }
    return false;
  };

  for (const byeTeam of byeOptions) {
    const availableTeams = byeTeam ? teams.filter((team) => team !== byeTeam) : teams;
    if (search(availableTeams)) {
      return {
        pairings: pairings.map(([team1, team2]) => [team1, team2]),
        byeTeams: [...(extraBye ? [extraBye] : []), ...(byeTeam ? [byeTeam] : [])],
      };
    }
    pairings.length = 0;
  }
  return null;
}

export function pairMixedPlayers(
  players: Player[],
  history: Map<string, Set<string>> = new Map(),
): MixedTeams {
  const men = shuffled(players.filter((player) => player.category === 'men'));
  const women = shuffled(players.filter((player) => player.category === 'women'));
  if (men.length !== women.length || men.length < 1) return { teams: [], byeTeam: null };

  let bestTeams: MatchSide[] = [];
  let bestBye: MatchSide | null = null;
  let lowestRepeatCount = Number.POSITIVE_INFINITY;
  const attempts = Math.min(250, Math.max(40, men.length * men.length * 2));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const shuffledMen = shuffled(men);
    const shuffledWomen = shuffled(women);
    const byeMan = shuffledMen.length % 2 ? shuffledMen.pop() : undefined;
    const byeWoman = shuffledWomen.length % 2 ? shuffledWomen.pop() : undefined;
    const teams = shuffledMen.map((player, index): MatchSide => [player.id, shuffledWomen[index].id]);
    const repeats = teams.reduce(
      (count, [manId, womanId]) => count + (history.get(manId)?.has(womanId) ? 1 : 0),
      0,
    );
    if (repeats < lowestRepeatCount) {
      bestTeams = teams;
      bestBye = byeMan && byeWoman ? [byeMan.id, byeWoman.id] : null;
      lowestRepeatCount = repeats;
      if (repeats === 0) break;
    }
  }

  return { teams: bestTeams, byeTeam: bestBye };
}

function createMatch(
  id: string,
  stage: Match['stage'],
  round: number,
  groupId: string | null,
  side1: MatchSide,
  side2: MatchSide | null,
  tableNumber: number | null,
): Match {
  const isBye = side2 === null;
  return {
    id,
    stage,
    round,
    groupId,
    side1,
    side2,
    status: isBye ? 'completed' : 'pending',
    sets: [],
    winnerSide: isBye ? 1 : null,
    tableNumber: isBye ? null : tableNumber,
    ...(isBye ? { isBye: true } : {}),
  };
}

function matchesForTeams(
  teams: MatchSide[],
  round: number,
  tableCount: number,
  createId: IdFactory,
  stage: Match['stage'],
  groupId: string | null,
  extraBye: MatchSide | null = null,
  opponentHistory: ReadonlySet<string> = new Set(),
): Match[] {
  const randomSchedule = (): { pairings: TeamMatchup[]; byeTeams: MatchSide[]; repeatCount: number } => {
    const availableTeams = shuffled(teams);
    const byeTeams = extraBye ? [extraBye] : [];
    if (availableTeams.length % 2) byeTeams.push(availableTeams.pop() as MatchSide);
    const pairings: TeamMatchup[] = [];
    for (let index = 0; index + 1 < availableTeams.length; index += 2) {
      pairings.push([availableTeams[index], availableTeams[index + 1]]);
    }
    return {
      pairings,
      byeTeams,
      repeatCount: pairings.reduce(
        (count, [team1, team2]) => count + Number(opponentHistory.has(opponentMatchupKey(team1, team2))),
        0,
      ),
    };
  };

  let bestSchedule = opponentHistory.size
    ? findUnrepeatedOpponentMatchups(teams, opponentHistory, extraBye)
    : null;
  if (!bestSchedule) {
    // If no repeat-free arrangement is found, keep the sampled arrangement with the fewest repeats.
    let lowestRepeatCount = Number.POSITIVE_INFINITY;
    const attempts = opponentHistory.size ? Math.min(250, Math.max(40, teams.length * teams.length * 2)) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const candidate = randomSchedule();
      if (candidate.repeatCount < lowestRepeatCount) {
        bestSchedule = candidate;
        lowestRepeatCount = candidate.repeatCount;
        if (lowestRepeatCount === 0) break;
      }
    }
  }

  const schedule = bestSchedule ?? { pairings: [], byeTeams: extraBye ? [extraBye] : [] };
  const matches = schedule.pairings.map(([team1, team2], index) => createMatch(
      createId(),
      stage,
      round,
      groupId,
      team1,
      team2,
      (index % Math.max(1, tableCount)) + 1,
    ));
  schedule.byeTeams.forEach((team) => matches.push(createMatch(createId(), stage, round, groupId, team, null, null)));
  return matches;
}

export function createGroupSchedule(
  tournament: Tournament,
  assignedPairs: RegisteredPair[],
  players: Player[],
  groups: Group[],
  createId: IdFactory,
): Match[] {
  const matches: Match[] = [];
  groups.forEach((group) => {
    const groupPairs = assignedPairs.filter((pair) => pair.groupId === group.id);
    const groupPlayers = players.filter((player) => player.groupId === group.id);
    const history = new Map<string, Set<string>>();
    const opponentHistory = new Set<string>();
    groupPairs.forEach((pair) => addPartnerHistory(history, [pair.menPlayerId, pair.womenPlayerId]));

    for (let round = 1; round <= tournament.groupRounds; round += 1) {
      if (round === 1) {
        const roundMatches = matchesForTeams(
          groupPairs.map((pair) => [pair.menPlayerId, pair.womenPlayerId]),
          round,
          tournament.tableCount,
          createId,
          'group',
          group.id,
          null,
          opponentHistory,
        );
        addOpponentHistory(opponentHistory, roundMatches);
        matches.push(...roundMatches);
        continue;
      }

      const mixed = pairMixedPlayers(groupPlayers, history);
      mixed.teams.forEach((team) => addPartnerHistory(history, team));
      const roundMatches = matchesForTeams(
        mixed.teams,
        round,
        tournament.tableCount,
        createId,
        'group',
        group.id,
        mixed.byeTeam,
        opponentHistory,
      );
      addOpponentHistory(opponentHistory, roundMatches);
      matches.push(...roundMatches);
    }
  });
  const assignedTables = new Map<number, number>();
  return matches.map((match) => {
    if (match.isBye) return match;
    const used = assignedTables.get(match.round) ?? 0;
    assignedTables.set(match.round, used + 1);
    return { ...match, tableNumber: (used % Math.max(1, tournament.tableCount)) + 1 };
  });
}

export function createSampleGroupPhase(date: string, createId: IdFactory): Tournament {
  const group: Group = { id: 'sample-group', name: 'Gesamtgruppe' };
  const names = [
    ['Alex Bauer', 'Anna Meier'],
    ['Ben Fischer', 'Clara Hoffmann'],
    ['Chris Weber', 'Eva Schneider'],
    ['David Neumann', 'Jana Schulz'],
    ['Emil Hartmann', 'Laura Klein'],
    ['Felix Wagner', 'Nina Berger'],
  ];
  const players: Player[] = names.flatMap(([menName, womenName]) => {
    const menId = createId();
    const womenId = createId();
    return [
      { id: menId, name: menName, category: 'men', groupId: group.id },
      { id: womenId, name: womenName, category: 'women', groupId: group.id },
    ];
  });
  const pairs: RegisteredPair[] = names.map((_, index) => ({
    id: createId(),
    menPlayerId: players[index * 2].id,
    womenPlayerId: players[index * 2 + 1].id,
    groupId: group.id,
  }));
  const tournament: Tournament = {
    ...blankTournament(date),
    name: 'Beispielturnier',
    phase: 'groups',
    groups: [group],
    players,
    pairs,
  };
  const sampleSets: SetScore[][] = [
    [{ p1: 11, p2: 7 }, { p1: 11, p2: 8 }],
    [{ p1: 8, p2: 11 }, { p1: 9, p2: 11 }],
    [{ p1: 11, p2: 9 }, { p1: 9, p2: 11 }, { p1: 11, p2: 7 }],
    [{ p1: 11, p2: 4 }, { p1: 11, p2: 6 }],
    [{ p1: 6, p2: 11 }, { p1: 8, p2: 11 }],
    [{ p1: 11, p2: 8 }, { p1: 10, p2: 12 }, { p1: 11, p2: 9 }],
  ];
  const matches = createGroupSchedule(tournament, pairs, players, [group], createId).map((match, index) => {
    if (match.isBye) return match;
    const sets = sampleSets[index % sampleSets.length];
    let side1Wins = 0;
    let side2Wins = 0;
    sets.forEach((set) => (set.p1 > set.p2 ? side1Wins++ : side2Wins++));
    return {
      ...match,
      sets,
      status: 'completed' as const,
      winnerSide: (side1Wins > side2Wins ? 1 : 2) as 1 | 2,
    };
  });
  return { ...tournament, matches };
}

export function resizeGroupSchedule(
  tournament: Tournament,
  requestedRounds: number,
  createId: IdFactory,
): { groupRounds: number; matches: Match[]; protectedRound: number | null } {
  const groupMatches = tournament.matches.filter((match) => match.stage === 'group');
  const highestPlayedRound = Math.max(
    0,
    ...groupMatches
      .filter((match) => !match.isBye && match.status !== 'pending')
      .map((match) => match.round),
  );
  const groupRounds = Math.max(requestedRounds, highestPlayedRound);
  const protectedRound = groupRounds > requestedRounds ? groupRounds : null;
  const retainedMatches = tournament.matches.filter(
    (match) => match.stage !== 'group' || match.round <= groupRounds,
  );

  if (groupRounds <= tournament.groupRounds || !tournament.groups.length) {
    return { groupRounds, matches: retainedMatches, protectedRound };
  }

  const history = partnerHistoryFor({ ...tournament, matches: retainedMatches });
  const opponentHistory = opponentHistoryFor(retainedMatches);
  const addedMatches: Match[] = [];
  for (let round = tournament.groupRounds + 1; round <= groupRounds; round += 1) {
    tournament.groups.forEach((group) => {
      const groupPlayers = tournament.players.filter((player) => player.groupId === group.id);
      const mixed = pairMixedPlayers(groupPlayers, history);
      mixed.teams.forEach((team) => addPartnerHistory(history, team));
      const roundMatches = matchesForTeams(
        mixed.teams,
        round,
        tournament.tableCount,
        createId,
        'group',
        group.id,
        mixed.byeTeam,
        opponentHistory,
      );
      addOpponentHistory(opponentHistory, roundMatches);
      addedMatches.push(...roundMatches);
    });
  }

  const tableNumbersByRound = new Map<number, number>();
  retainedMatches
    .filter((match) => match.stage === 'group' && !match.isBye)
    .forEach((match) => tableNumbersByRound.set(match.round, (tableNumbersByRound.get(match.round) ?? 0) + 1));
  const scheduledMatches = addedMatches.map((match) => {
    if (match.isBye) return match;
    const usedTables = tableNumbersByRound.get(match.round) ?? 0;
    tableNumbersByRound.set(match.round, usedTables + 1);
    return { ...match, tableNumber: (usedTables % Math.max(1, tournament.tableCount)) + 1 };
  });

  return { groupRounds, matches: [...retainedMatches, ...scheduledMatches], protectedRound };
}

export function reassignPendingGroupTables(matches: Match[], tableCount: number): Match[] {
  const availableTables = Math.max(1, Math.floor(tableCount) || 1);
  const occupiedByRound = new Map<number, Set<number>>();
  const nextTableByRound = new Map<number, number>();

  matches.forEach((match) => {
    if (match.stage !== 'group' || match.isBye || match.status !== 'in_progress' || !match.tableNumber) return;
    const occupied = occupiedByRound.get(match.round) ?? new Set<number>();
    occupied.add(match.tableNumber);
    occupiedByRound.set(match.round, occupied);
  });

  return matches.map((match) => {
    if (match.stage !== 'group' || match.isBye || match.status !== 'pending') return match;
    const occupied = occupiedByRound.get(match.round) ?? new Set<number>();
    let tableNumber = nextTableByRound.get(match.round) ?? 1;
    for (let attempt = 0; attempt < availableTables && occupied.has(tableNumber); attempt += 1) {
      tableNumber = (tableNumber % availableTables) + 1;
    }
    nextTableByRound.set(match.round, (tableNumber % availableTables) + 1);
    return { ...match, tableNumber };
  });
}

export function standingsFor(tournament: Tournament, groupId: string): Standing[] {
  const standings = tournament.players
    .filter((player) => player.groupId === groupId)
    .map((player) => ({
      player,
      wins: 0,
      losses: 0,
      setsFor: 0,
      setsAgainst: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    }));
  const byId = new Map(standings.map((standing) => [standing.player.id, standing]));

  tournament.matches
    .filter((match) => match.stage === 'group' && match.groupId === groupId && match.status === 'completed' && !match.isBye && match.side2)
    .forEach((match) => {
      const side1 = match.side1.map((id) => byId.get(id)).filter((value): value is Standing => Boolean(value));
      const side2 = (match.side2 ?? []).map((id) => byId.get(id)).filter((value): value is Standing => Boolean(value));
      if (side1.length !== 2 || side2.length !== 2) return;

      let side1Sets = 0;
      let side2Sets = 0;
      match.sets.forEach((set) => {
        side1Sets += set.p1 > set.p2 ? 1 : 0;
        side2Sets += set.p2 > set.p1 ? 1 : 0;
        side1.forEach((standing) => {
          standing.pointsFor += set.p1;
          standing.pointsAgainst += set.p2;
        });
        side2.forEach((standing) => {
          standing.pointsFor += set.p2;
          standing.pointsAgainst += set.p1;
        });
      });
      side1.forEach((standing) => {
        standing.setsFor += side1Sets;
        standing.setsAgainst += side2Sets;
        if (match.winnerSide === 1) standing.wins += 1;
        else if (match.winnerSide === 2) standing.losses += 1;
      });
      side2.forEach((standing) => {
        standing.setsFor += side2Sets;
        standing.setsAgainst += side1Sets;
        if (match.winnerSide === 2) standing.wins += 1;
        else if (match.winnerSide === 1) standing.losses += 1;
      });
    });

  return standings.sort((a, b) =>
    b.wins - a.wins
    || (b.setsFor - b.setsAgainst) - (a.setsFor - a.setsAgainst)
    || (b.pointsFor - b.pointsAgainst) - (a.pointsFor - a.pointsAgainst)
    || a.player.name.localeCompare(b.player.name, 'de'),
  );
}

export function schleiferlFor(tournament: Tournament): Map<string, number> {
  const counts = new Map(tournament.players.map((player) => [player.id, 0]));
  tournament.matches
    .filter((match) => match.status === 'completed' && !match.isBye && match.winnerSide !== null)
    .forEach((match) => {
      const winners = match.winnerSide === 1 ? match.side1 : match.side2;
      winners?.forEach((playerId) => counts.set(playerId, (counts.get(playerId) ?? 0) + 1));
    });
  return counts;
}

export function qualifiedMixedTeams(tournament: Tournament): MatchSide[] {
  const qualifiedMen: Player[] = [];
  const qualifiedWomen: Player[] = [];
  tournament.groups.forEach((group) => {
    const ranked = standingsFor(tournament, group.id);
    const men = ranked.filter((standing) => standing.player.category === 'men');
    const women = ranked.filter((standing) => standing.player.category === 'women');
    const availablePlaces = Math.min(tournament.qualifiersPerGroup, men.length, women.length);
    for (let place = 0; place < availablePlaces; place += 1) {
      qualifiedMen.push(men[place].player);
      qualifiedWomen.push(women[place].player);
    }
  });
  const newlyMixed = pairMixedPlayers([...qualifiedMen, ...qualifiedWomen], partnerHistoryFor(tournament));
  return newlyMixed.byeTeam ? [...newlyMixed.teams, newlyMixed.byeTeam] : newlyMixed.teams;
}

export function createKnockoutMatches(
  teams: MatchSide[],
  round: number,
  tableCount: number,
  createId: IdFactory,
  extraBye: MatchSide | null = null,
): Match[] {
  return matchesForTeams(teams, round, tableCount, createId, 'knockout', null, extraBye);
}

export function bracketProgress(tournament: Tournament): BracketProgress {
  const rounds = [...new Set(
    tournament.matches.filter((match) => match.stage === 'knockout').map((match) => match.round),
  )]
    .sort((a, b) => a - b)
    .map((round) => {
      const matches = tournament.matches
        .filter((match) => match.stage === 'knockout' && match.round === round)
        .sort((a, b) => Number(Boolean(a.isBye)) - Number(Boolean(b.isBye)));
      return { round, matches, byes: matches.filter((match) => match.isBye) };
    });
  const current = rounds[rounds.length - 1];
  const currentComplete = Boolean(current?.matches.length && current.matches.every((match) => match.status === 'completed'));
  let championIds: MatchSide | null = null;
  const titleMatches = current?.matches.filter((match) => !match.isThirdPlace) ?? [];
  if (titleMatches.length === 1 && titleMatches[0].status === 'completed' && !titleMatches[0].isBye) {
    const finalMatch = titleMatches[0];
    championIds = finalMatch.winnerSide === 1 ? finalMatch.side1 : finalMatch.winnerSide === 2 ? finalMatch.side2 : null;
  }
  return { rounds, current, currentComplete, championIds };
}
