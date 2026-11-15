import { z } from 'zod';
import {
  blankTournament,
  matchResultIsConsistent,
  parseSetScoreInput,
  resolveBestOfThree,
  findPairRosterConflicts,
  type Match,
  type Tournament,
} from '@/lib/tournament';

const playerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  club: z.string().optional(),
  category: z.enum(['men', 'women']),
  groupId: z.string(),
});

const matchSideSchema = z.tuple([z.string().min(1), z.string().min(1)]);

const matchSchema = z.object({
  id: z.string().min(1),
  stage: z.enum(['group', 'knockout']),
  round: z.number().int().positive(),
  groupId: z.string().nullable(),
  side1: matchSideSchema,
  side2: matchSideSchema.nullable(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  sets: z.array(z.object({
    p1: z.number().int().nonnegative(),
    p2: z.number().int().nonnegative(),
  })),
  winnerSide: z.union([z.literal(1), z.literal(2)]).nullable(),
  tableNumber: z.number().int().positive().nullable(),
  isBye: z.boolean().optional(),
  isThirdPlace: z.boolean().optional(),
});

const tournamentSchema = z.object({
  name: z.string(),
  date: z.string(),
  venue: z.string(),
  tableCount: z.number().int().positive(),
  groupRounds: z.number().int().positive(),
  qualifiersPerGroup: z.number().int().positive(),
  phase: z.enum(['setup', 'groups', 'knockout', 'finished']),
  players: z.array(playerSchema),
  pairs: z.array(z.object({
    id: z.string().min(1),
    menPlayerId: z.string().min(1),
    womenPlayerId: z.string().min(1),
    groupId: z.string(),
  })),
  groups: z.array(z.object({ id: z.string().min(1), name: z.string() })),
  matches: z.array(matchSchema),
  qualifiedIds: z.array(z.string()),
  legacyParticipantNames: z.array(z.string()).optional(),
});

const backupSchema = z.object({
  format: z.literal('tt-turnier-backup'),
  version: z.literal(1),
  exportedAt: z.string(),
  tournament: tournamentSchema,
});

type BackupResult =
  | { success: true; tournament: Tournament }
  | { success: false; message: string };

export type StoredTournamentResult =
  | { success: true; tournament: Partial<Tournament> }
  | { success: false };

export type LegacyTournamentResult =
  | { success: true; tournament: Tournament }
  | { success: false };

export function parseLegacyTournament(raw: string, today: string): LegacyTournamentResult {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return { success: false };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { success: false };
  const parsed = input as {
    name?: unknown;
    date?: unknown;
    venue?: unknown;
    tableCount?: unknown;
    qualifiersPerGroup?: unknown;
    players?: unknown;
  };
  if (
    (parsed.name !== undefined && typeof parsed.name !== 'string')
    || (parsed.date !== undefined && typeof parsed.date !== 'string')
    || (parsed.venue !== undefined && typeof parsed.venue !== 'string')
    || (parsed.tableCount !== undefined && (typeof parsed.tableCount !== 'number' || !Number.isInteger(parsed.tableCount) || parsed.tableCount < 1))
    || (parsed.qualifiersPerGroup !== undefined && (typeof parsed.qualifiersPerGroup !== 'number' || !Number.isInteger(parsed.qualifiersPerGroup) || parsed.qualifiersPerGroup < 1))
    || (parsed.players !== undefined && (!Array.isArray(parsed.players) || parsed.players.some((player) => !player || typeof player.name !== 'string')))
  ) {
    return { success: false };
  }

  const tournament = blankTournament(today);
  tournament.name = typeof parsed.name === 'string' ? parsed.name : '';
  tournament.date = typeof parsed.date === 'string' ? parsed.date : today;
  tournament.venue = typeof parsed.venue === 'string' ? parsed.venue : '';
  tournament.tableCount = typeof parsed.tableCount === 'number' ? parsed.tableCount : 4;
  tournament.qualifiersPerGroup = typeof parsed.qualifiersPerGroup === 'number' ? parsed.qualifiersPerGroup : 2;
  tournament.legacyParticipantNames = Array.isArray(parsed.players)
    ? parsed.players.map((player: { name: string }) => player.name).filter(Boolean)
    : [];
  return { success: true, tournament };
}

export function parseStoredTournament(raw: string): StoredTournamentResult {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return { success: false };
  }

  const result = tournamentSchema.partial().safeParse(input);
  if (
    !result.success
    || !Array.isArray(result.data.players)
    || !Array.isArray(result.data.groups)
    || !Array.isArray(result.data.matches)
  ) {
    return { success: false };
  }

  return { success: true, tournament: result.data };
}

export function createTournamentBackup(tournament: Tournament, exportedAt = new Date().toISOString()) {
  return {
    format: 'tt-turnier-backup',
    version: 1,
    exportedAt,
    tournament,
  } as const;
}

export type BackupDifference = {
  label: string;
  currentCount: number;
  backupCount: number;
  added: number;
  removed: number;
  changed: number;
};

function differenceById<T extends { id: string }>(
  label: string,
  current: T[],
  backup: T[],
  projection: (item: T) => unknown = (item) => item,
): BackupDifference {
  const currentById = new Map(current.map((item) => [item.id, JSON.stringify(projection(item))]));
  const backupById = new Map(backup.map((item) => [item.id, JSON.stringify(projection(item))]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  backupById.forEach((value, id) => {
    if (!currentById.has(id)) added += 1;
    else if (currentById.get(id) !== value) changed += 1;
  });
  currentById.forEach((_value, id) => {
    if (!backupById.has(id)) removed += 1;
  });
  return { label, currentCount: current.length, backupCount: backup.length, added, removed, changed };
}

export function compareTournamentContents(current: Tournament, backup: Tournament): BackupDifference[] {
  const currentResults = current.matches.filter((match) => match.status === 'completed' && !match.isBye);
  const backupResults = backup.matches.filter((match) => match.status === 'completed' && !match.isBye);
  return [
    differenceById('Spieler', current.players, backup.players),
    differenceById('Paare', current.pairs, backup.pairs),
    differenceById('Gruppen', current.groups, backup.groups),
    differenceById('Spiele', current.matches, backup.matches, (match) => ({
      stage: match.stage,
      round: match.round,
      groupId: match.groupId,
      side1: match.side1,
      side2: match.side2,
      status: match.status,
      tableNumber: match.tableNumber,
      isBye: match.isBye,
      isThirdPlace: match.isThirdPlace,
    })),
    differenceById(
      'Ergebnisse',
      currentResults,
      backupResults,
      (match) => ({ sets: match.sets, winnerSide: match.winnerSide }),
    ),
  ];
}

export function backupExportedAt(raw: string): string | null {
  try {
    const result = backupSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data.exportedAt : null;
  } catch {
    return null;
  }
}

function hasDuplicateIds(items: { id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size !== items.length;
}

function matchResultInconsistency(match: Match): string {
  if (match.isBye || match.side2 === null) {
    return 'Das Freilos muss ohne zweites Paar und Satzergebnis eingetragen sein.';
  }

  if (match.status !== 'completed') {
    return 'Ein offenes oder laufendes Spiel darf noch kein Satzergebnis oder Sieger enthalten.';
  }

  if (match.winnerSide === null || match.sets.length === 0) {
    return 'Das beendete Spiel benötigt Satzergebnisse und einen eingetragenen Sieger.';
  }

  if (match.sets.some((set) => parseSetScoreInput(`${set.p1}:${set.p2}`) === undefined)) {
    return 'Mindestens ein Satz hat ein ungültiges Ergebnis.';
  }

  const resolution = resolveBestOfThree(match.sets);
  if (!resolution.ok) {
    return resolution.reason === 'extra-sets'
      ? 'Nach dem feststehenden Spielentscheid wurden weitere Sätze eingetragen.'
      : 'Die Satzergebnisse entscheiden das Spiel noch nicht.';
  }

  return 'Der eingetragene Sieger stimmt nicht mit den Satzergebnissen überein.';
}

function matchLocation(match: Match, tournament: Tournament): string {
  const groupName = match.groupId
    ? tournament.groups.find((group) => group.id === match.groupId)?.name ?? `Gruppe ${match.groupId}`
    : 'KO-Runde';
  const table = match.tableNumber ? `, Tisch ${match.tableNumber}` : '';
  return `Spiel „${match.id}“ (${groupName}, Runde ${match.round}${table})`;
}

function matchSideNames(side: Match['side1'], playersById: Map<string, Tournament['players'][number]>): string {
  return side
    .map((playerId) => playersById.get(playerId)?.name || playerId)
    .join(' + ');
}

function quotedIds(ids: string[]): string {
  return ids.map((id) => `„${id}“`).join(', ');
}

export function parseTournamentBackup(raw: string): BackupResult {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return { success: false, message: 'Die Datei enthält kein gültiges JSON.' };
  }

  const result = backupSchema.safeParse(input);
  if (!result.success) {
    return {
      success: false,
      message: 'Die Datei ist keine gültige Tischtennis-Turniersicherung oder hat ein nicht unterstütztes Format.',
    };
  }

  const tournament: Tournament = {
    ...result.data.tournament,
    matches: result.data.tournament.matches.map((match) =>
      match.side2 === null && match.isBye === undefined
        ? { ...match, isBye: true }
        : match,
    ),
  };
  const playerIds = new Set(tournament.players.map((player) => player.id));
  const playersById = new Map(tournament.players.map((player) => [player.id, player]));
  if (playerIds.size !== tournament.players.length) {
    return { success: false, message: 'Die Sicherung enthält doppelte Spieler-IDs.' };
  }
  if (hasDuplicateIds(tournament.pairs)) {
    return { success: false, message: 'Die Sicherung enthält doppelte Paar-IDs.' };
  }
  if (hasDuplicateIds(tournament.groups)) {
    return { success: false, message: 'Die Sicherung enthält doppelte Gruppen-IDs.' };
  }
  if (hasDuplicateIds(tournament.matches)) {
    return { success: false, message: 'Die Sicherung enthält doppelte Spiel-IDs.' };
  }
  const groupIds = new Set(tournament.groups.map((group) => group.id));
  const isUnassignedSetup = tournament.phase === 'setup'
    && tournament.groups.length === 0
    && tournament.matches.length === 0;
  const invalidPlayerGroup = tournament.players.find((player) =>
    !(isUnassignedSetup && player.groupId === '') && !groupIds.has(player.groupId),
  );
  if (invalidPlayerGroup) {
    return {
      success: false,
      message: `Spieler „${invalidPlayerGroup.name || invalidPlayerGroup.id}“ (ID „${invalidPlayerGroup.id}“) verweist auf die nicht vorhandene Gruppe „${invalidPlayerGroup.groupId}“.`,
    };
  }
  const invalidPairGroup = tournament.pairs.find((pair) =>
    !(isUnassignedSetup && pair.groupId === '') && !groupIds.has(pair.groupId),
  );
  if (invalidPairGroup) {
    return {
      success: false,
      message: `Paar „${invalidPairGroup.id}“ verweist auf die nicht vorhandene Gruppe „${invalidPairGroup.groupId}“.`,
    };
  }
  const invalidMatchGroup = tournament.matches.find((match) =>
    (match.stage === 'group' && (match.groupId === null || !groupIds.has(match.groupId)))
    || (match.stage === 'knockout' && match.groupId !== null),
  );
  if (invalidMatchGroup) {
    const missingGroup = invalidMatchGroup.groupId ?? 'keine Gruppe';
    return {
      success: false,
      message: `${matchLocation(invalidMatchGroup, tournament)} verweist auf eine ungültige Gruppe „${missingGroup}“ für die ${invalidMatchGroup.stage === 'group' ? 'Gruppenphase' : 'KO-Runde'}.`,
    };
  }
  const pairsWithMissingPlayers = tournament.pairs.flatMap((pair) => {
    const missingIds = [pair.menPlayerId, pair.womenPlayerId]
      .filter((id) => !playerIds.has(id));
    return missingIds.length
      ? [`Paar „${pair.id}“ verweist auf fehlende Spieler-ID(s): ${quotedIds(missingIds)}`]
      : [];
  });
  if (pairsWithMissingPlayers.length) {
    return {
      success: false,
      message: `Die Sicherung enthält fehlende Spielerdaten: ${pairsWithMissingPlayers.join('; ')}.`,
    };
  }
  const pairWithMismatchedGroup = tournament.pairs.find((pair) =>
    playersById.get(pair.menPlayerId)?.groupId !== pair.groupId
    || playersById.get(pair.womenPlayerId)?.groupId !== pair.groupId,
  );
  if (pairWithMismatchedGroup) {
    const pairPlayers = [pairWithMismatchedGroup.menPlayerId, pairWithMismatchedGroup.womenPlayerId]
      .map((id) => ({ id, player: playersById.get(id)! }));
    const pairNames = pairPlayers.map(({ id, player }) => player.name || id);
    const mismatchedPlayers = pairPlayers
      .filter(({ player }) => player.groupId !== pairWithMismatchedGroup.groupId)
      .map(({ id, player }) => `${player.name || id} (ID „${id}“, Gruppe „${player.groupId}“)`);
    return {
      success: false,
      message: `Paar „${pairWithMismatchedGroup.id}“ (${pairNames.join(' + ')}) ist der Gruppe „${pairWithMismatchedGroup.groupId}“ zugeordnet, aber ${mismatchedPlayers.length === 1 ? 'Spieler' : 'seine Spieler'} ${mismatchedPlayers.join(' und ')}.`,
    };
  }
  const pairWithMismatchedCategory = tournament.pairs.find((pair) =>
    playersById.get(pair.menPlayerId)?.category !== 'men'
    || playersById.get(pair.womenPlayerId)?.category !== 'women',
  );
  if (pairWithMismatchedCategory) {
    return {
      success: false,
      message: `Paar „${pairWithMismatchedCategory.id}“ hat unpassende Spielerrollen: Männer-ID „${pairWithMismatchedCategory.menPlayerId}“, Frauen-ID „${pairWithMismatchedCategory.womenPlayerId}“.`,
    };
  }
  const pairConflicts = findPairRosterConflicts(tournament);
  if (pairConflicts.length) {
    const pairsById = new Map(tournament.pairs.map((pair) => [pair.id, pair]));
    const details = pairConflicts.map(({ playerId, pairIds }) => {
      const conflictingPairs = pairIds.map((pairId) => {
        const pair = pairsById.get(pairId);
        const playerNames = pair
          ? [pair.menPlayerId, pair.womenPlayerId]
            .map((id) => playersById.get(id)?.name || id)
          : [];
        return `Paar „${pairId}“${playerNames.length ? ` (${playerNames.join(' + ')})` : ''}`;
      });
      return `${playersById.get(playerId)?.name || playerId} (Spieler-ID „${playerId}“) in ${conflictingPairs.join(' und ')}`;
    });
    return {
      success: false,
      message: `Spieler ist mehreren Paaren zugeordnet: ${details.join('; ')}.`,
    };
  }
  const matchesWithMissingPlayers = tournament.matches.flatMap((match) => {
    const sides = [match.side1, match.side2];
    const missingBySide = sides.flatMap((side, index) => {
      const ids = side?.filter((id) => !playerIds.has(id)) ?? [];
      return ids.length ? [`fehlende Spieler-ID(s) auf Seite ${index + 1}: ${quotedIds(ids)}`] : [];
    });
    return missingBySide.length
      ? [`${matchLocation(match, tournament)}: ${missingBySide.join('; ')}`]
      : [];
  });
  if (matchesWithMissingPlayers.length) {
    return {
      success: false,
      message: `Die Sicherung enthält fehlende Spielerdaten: ${matchesWithMissingPlayers.join('; ')}.`,
    };
  }
  const repeatedPlayersInMatch = tournament.matches.find((match) => {
    const participantIds = [...match.side1, ...(match.side2 ?? [])];
    return new Set(participantIds).size !== participantIds.length;
  });
  if (repeatedPlayersInMatch) {
    return {
      success: false,
      message: `${matchLocation(repeatedPlayersInMatch, tournament)} enthält Spieler mehrfach: ${quotedIds([...new Set([...repeatedPlayersInMatch.side1, ...(repeatedPlayersInMatch.side2 ?? [])].filter((id, index, ids) => ids.indexOf(id) !== index))])}.`,
    };
  }
  const registeredPairs = new Map(
    tournament.pairs.map((pair) => [JSON.stringify([pair.menPlayerId, pair.womenPlayerId].sort()), pair]),
  );
  const mismatchedSide = tournament.matches.find((match) => {
    if (match.stage !== 'group') return false;
    return [match.side1, match.side2].some((side) => {
      if (!side) return false;
      const pair = registeredPairs.get(JSON.stringify([...side].sort()));
      return !pair || pair.groupId !== match.groupId;
    });
  });
  if (mismatchedSide) {
    const sideIndex = [mismatchedSide.side1, mismatchedSide.side2].findIndex((side) => {
      if (!side) return false;
      const pair = registeredPairs.get(JSON.stringify([...side].sort()));
      return !pair || pair.groupId !== mismatchedSide.groupId;
    });
    const side = sideIndex === 0 ? mismatchedSide.side1 : mismatchedSide.side2;
    const registeredPair = side
      ? registeredPairs.get(JSON.stringify([...side].sort()))
      : undefined;
    return {
      success: false,
      message: `${matchLocation(mismatchedSide, tournament)}, Seite ${sideIndex + 1} (${side ? matchSideNames(side, playersById) : 'Freilos'}) entspricht keinem angemeldeten Paar dieser Gruppe${registeredPair ? `; Paar „${registeredPair.id}“ ist Gruppe „${registeredPair.groupId}“ zugeordnet` : ''}.`,
    };
  }
  const invalidKnockoutSide = tournament.matches.find((match) =>
    match.stage === 'knockout'
    && [match.side1, match.side2].filter((side): side is Match['side1'] => side !== null).some((side) => {
      const categories = side.map((id) => playersById.get(id)?.category);
      return categories.filter((category) => category === 'men').length !== 1
        || categories.filter((category) => category === 'women').length !== 1;
    }),
  );
  if (invalidKnockoutSide) {
    return {
      success: false,
      message: `${matchLocation(invalidKnockoutSide, tournament)} enthält in der KO-Runde kein Mixed-Paar: ${matchSideNames(invalidKnockoutSide.side1, playersById)}${invalidKnockoutSide.side2 ? ` und ${matchSideNames(invalidKnockoutSide.side2, playersById)}` : ''}.`,
    };
  }
  const knockoutPlayerNotQualified = tournament.matches.find((match) =>
    match.stage === 'knockout'
    && tournament.qualifiedIds.length > 0
    && [...match.side1, ...(match.side2 ?? [])].some((id) => !tournament.qualifiedIds.includes(id)),
  );
  if (knockoutPlayerNotQualified) {
    const invalidIds = [...new Set([...knockoutPlayerNotQualified.side1, ...(knockoutPlayerNotQualified.side2 ?? [])]
      .filter((id) => !tournament.qualifiedIds.includes(id)))];
    return {
      success: false,
      message: `${matchLocation(knockoutPlayerNotQualified, tournament)} enthält nicht qualifizierte Spieler-ID(s): ${quotedIds(invalidIds)}.`,
    };
  }
  const matchesByRound = new Map<string, Match[]>();
  tournament.matches.forEach((match) => {
    const key = `${match.stage}:${match.round}`;
    matchesByRound.set(key, [...(matchesByRound.get(key) ?? []), match]);
  });
  for (const roundMatches of matchesByRound.values()) {
    const appearances = new Map<string, Match[]>();
    roundMatches.forEach((match) => {
      [...match.side1, ...(match.side2 ?? [])].forEach((id) => {
        appearances.set(id, [...(appearances.get(id) ?? []), match]);
      });
    });
    const conflict = [...appearances].find(([, matches]) => matches.length > 1);
    if (conflict) {
      const [playerId, conflictingMatches] = conflict;
      return {
        success: false,
        message: `${playersById.get(playerId)?.name || playerId} (Spieler-ID „${playerId}“) ist in derselben ${conflictingMatches[0].stage === 'group' ? 'Gruppen-' : 'KO-'}Runde ${conflictingMatches[0].round} mehrfach angesetzt: ${conflictingMatches.map((match) => `Spiel „${match.id}“`).join(' und ')}.`,
      };
    }
  }
  const inconsistentMatch = tournament.matches.find((match) =>
    !matchResultIsConsistent(match as Tournament['matches'][number]),
  );
  if (inconsistentMatch) {
    const match = inconsistentMatch as Tournament['matches'][number];
    return {
      success: false,
      message: `Die Sicherung enthält ein widersprüchliches Spielergebnis bei ${matchLocation(match, tournament)} zwischen ${matchSideNames(match.side1, playersById)} und ${match.side2 ? matchSideNames(match.side2, playersById) : 'Freilos'}: ${matchResultInconsistency(match)}`,
    };
  }
  if (tournament.qualifiedIds.some((id) => !playerIds.has(id))) {
    const missingIds = [...new Set(tournament.qualifiedIds.filter((id) => !playerIds.has(id)))];
    return { success: false, message: `Die KO-Qualifikation verweist auf fehlende Spieler-ID(s): ${quotedIds(missingIds)}.` };
  }

  return { success: true, tournament: tournament as Tournament };
}

export const RECOVERY_STORAGE_KEY = 'tt-turnier-recovery-v1';
export const MAX_RECOVERY_COPIES = 5;

export type TournamentRecoveryCopy = { savedAt: string; raw: string };

export function loadTournamentRecoveryCopies(storage: Pick<Storage, 'getItem'>): TournamentRecoveryCopy[] {
  try {
    const stored = storage.getItem(RECOVERY_STORAGE_KEY);
    if (!stored) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      return parseTournamentBackup(stored).success
        ? [{ savedAt: backupExportedAt(stored) ?? new Date(0).toISOString(), raw: stored }]
        : [];
    }
    if (!Array.isArray(parsed)) {
      return parseTournamentBackup(stored).success
        ? [{ savedAt: backupExportedAt(stored) ?? new Date(0).toISOString(), raw: stored }]
        : [];
    }
    return parsed.flatMap((entry): TournamentRecoveryCopy[] => {
      if (!entry || typeof entry.savedAt !== 'string' || typeof entry.raw !== 'string') return [];
      return parseTournamentBackup(entry.raw).success ? [{ savedAt: entry.savedAt, raw: entry.raw }] : [];
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, MAX_RECOVERY_COPIES);
  } catch {
    return [];
  }
}

export function recoveryCopyDownload(copy: TournamentRecoveryCopy): { raw: string; fileName: string } | null {
  if (!parseTournamentBackup(copy.raw).success) return null;
  return {
    raw: copy.raw,
    fileName: `turnier-wiederherstellung-${copy.savedAt.slice(0, 10)}.json`,
  };
}

export type RecoveryCopyResult =
  | { success: true; raw: string }
  | { success: false; message: string };

export function saveTournamentRecoveryCopy(
  tournament: Tournament,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): RecoveryCopyResult {
  const parsed = parseTournamentBackup(JSON.stringify(createTournamentBackup(tournament)));
  if (!parsed.success) {
    return {
      success: false,
      message: 'Das aktuelle Turnier ist ungültig und konnte nicht als Wiederherstellungskopie gespeichert werden. Es wurde nichts ersetzt.',
    };
  }

  try {
    const copies = loadTournamentRecoveryCopies(storage);
    const newestSavedAt = copies.reduce((newest, copy) => {
      const timestamp = Date.parse(copy.savedAt);
      return Number.isFinite(timestamp) ? Math.max(newest, timestamp) : newest;
    }, 0);
    const savedAt = new Date(Math.max(Date.now(), newestSavedAt + 1)).toISOString();
    const raw = JSON.stringify(createTournamentBackup(tournament, savedAt));
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify([
      { savedAt, raw },
      ...copies,
    ].slice(0, MAX_RECOVERY_COPIES)));
    return { success: true, raw };
  } catch {
    return {
      success: false,
      message: 'Die Wiederherstellungskopie konnte nicht gespeichert werden. Es wurde nichts ersetzt.',
    };
  }
}

export type TournamentBackupImportResult =
  | { success: true; imported: boolean }
  | { success: false; message: string };

export function importTournamentBackup(
  raw: string,
  currentTournament: Tournament,
  onImport: (tournament: Tournament) => void,
  confirmReplacement: (message: string) => boolean,
  beforeImport?: (currentTournament: Tournament) => void,
): TournamentBackupImportResult {
  const parsed = parseTournamentBackup(raw);
  if (!parsed.success) return parsed;

  const hasData = currentTournament.players.length > 0
    || currentTournament.pairs.length > 0
    || currentTournament.matches.length > 0;
  if (
    hasData
    && !confirmReplacement(
      'Die aktuelle Turnierdatei wird durch die Sicherung ersetzt. Vorher am besten eine Sicherung herunterladen. Fortfahren?',
    )
  ) {
    return { success: true, imported: false };
  }

  try {
    beforeImport?.(currentTournament);
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error
        ? error.message
        : 'Die Wiederherstellungskopie konnte nicht gespeichert werden. Es wurde nichts ersetzt.',
    };
  }

  onImport(parsed.tournament);
  return { success: true, imported: true };
}
