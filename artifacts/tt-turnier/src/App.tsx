import { type ReactNode, useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter, Link } from 'wouter';
import { Activity, CalendarDays, Check, ChevronRight, CircleHelp, ClipboardList, Clock3, Crown, ExternalLink, FileCog, Flag, ListChecks, Maximize2, Monitor as MonitorIcon, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, Settings2, Shuffle, Table2, Trophy, Users, X, Trash2 } from 'lucide-react';
import {
  blankTournament,
  bracketProgress,
  createGroupSchedule,
  createKnockoutMatches,
  createSampleGroupPhase,
  currentRoundNumber,
  findLikelyPlayerNameMatches,
  findMissingPairPlayers,
  findPairRosterConflicts,
  pairMixedPlayers,
  partnerHistoryFor,
  parseSetScoreInput,
  playerById,
  playerNameDuplicateKey,
  qualifiedMixedTeams,
  reassignPendingGroupTables,
  removePairAndOrphanedPlayers,
  resolveBestOfThree,
  resizeGroupSchedule,
  schleiferlFor,
  parseTournamentWorkspaceIndex,
  selectTournamentWorkspace,
  upsertTournamentWorkspace,
  standingsFor,
  teamLabel,
  updateRegisteredPair,
  type Group,
  type Match,
  type MatchSide,
  type Player,
  type RegisteredPair,
  type SetScore,
  type Tournament,
  type TournamentWorkspaceIndex,
} from '@/lib/tournament';
import {
  createTournamentBackup,
  backupExportedAt,
  compareTournamentContents,
  importTournamentBackup,
  loadTournamentRecoveryCopies,
  MAX_RECOVERY_COPIES,
  parseLegacyTournament,
  parseStoredTournament,
  parseTournamentBackup,
  recoveryCopyDownload,
  saveTournamentRecoveryCopy,
} from '@/lib/backup';

const STORAGE_KEY = 'tt-turnier-state-v2';
const LEGACY_STORAGE_KEY = 'tt-turnier-state-v1';
const WORKSPACE_INDEX_KEY = 'tt-turnier-workspaces-v1';
const WORKSPACE_TOURNAMENT_PREFIX = 'tt-turnier-tournament-v1-';
const workspaceTournamentKey = (id: string) => `${WORKSPACE_TOURNAMENT_PREFIX}${encodeURIComponent(id)}`;
const releaseNotesUrl = import.meta.env.VITE_RELEASE_NOTES_URL;
const today = new Date().toISOString().slice(0, 10);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const dateTimeLabel = (value: string | null) => {
  if (!value) return 'Zeitpunkt nicht angegeben';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Zeitpunkt nicht angegeben'
    : new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
};
const dateLabel = (date: string) => {
  if (!date) return 'Noch kein Datum';
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }).format(parsed);
};

function loadTournament(): { tournament: Tournament; unreadableSavedData: boolean } {
  if (new URLSearchParams(window.location.search).get('demo') === 'group-results') {
    const containsTournamentData = (raw: string | null) => {
      if (!raw) return false;
      const parsed = JSON.parse(raw) as Partial<Tournament>;
      return Boolean(
        parsed.players?.length
        || parsed.pairs?.length
        || parsed.groups?.length
        || parsed.matches?.length
        || parsed.legacyParticipantNames?.length,
      );
    };
    let hasExistingData = false;
    try {
      hasExistingData = containsTournamentData(localStorage.getItem(STORAGE_KEY))
        || containsTournamentData(localStorage.getItem(LEGACY_STORAGE_KEY));
    } catch {
      hasExistingData = true;
    }
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash}`);
    if (!hasExistingData) return { tournament: createSampleGroupPhase(today, uid), unreadableSavedData: false };
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const result = parseStoredTournament(saved);
      if (!result.success) return { tournament: blankTournament(today), unreadableSavedData: true };
      const parsed = result.tournament;
      return {
        tournament: {
          ...blankTournament(today),
          ...parsed,
          groupRounds: parsed.groupRounds ?? 3,
          pairs: parsed.pairs ?? [],
          qualifiedIds: parsed.qualifiedIds ?? [],
        },
        unreadableSavedData: false,
      };
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy !== null) {
      const migrated = parseLegacyTournament(legacy, today);
      if (!migrated.success) return { tournament: blankTournament(today), unreadableSavedData: true };
      return { tournament: migrated.tournament, unreadableSavedData: false };
    }
  } catch {
    return { tournament: blankTournament(today), unreadableSavedData: true };
  }
  return { tournament: blankTournament(today), unreadableSavedData: false };
}

function loadWorkspaceState(): {
  index: TournamentWorkspaceIndex;
  tournament: Tournament;
  unreadableSavedData: boolean;
} {
  try {
    const rawIndex = localStorage.getItem(WORKSPACE_INDEX_KEY);
    if (rawIndex !== null) {
      const index = parseTournamentWorkspaceIndex(rawIndex);
      if (!index) {
        return {
          index: { activeId: 'tournament-1', workspaces: [{ id: 'tournament-1', name: 'Turnier 1' }] },
          tournament: blankTournament(today),
          unreadableSavedData: true,
        };
      }
      const rawTournament = localStorage.getItem(workspaceTournamentKey(index.activeId));
      if (rawTournament === null) {
        return {
          index,
          tournament: blankTournament(today),
          unreadableSavedData: false,
        };
      }
      const result = parseStoredTournament(rawTournament);
      if (!result.success) return { index, tournament: blankTournament(today), unreadableSavedData: true };
      const parsed = result.tournament;
      return {
        index,
        tournament: {
          ...blankTournament(today),
          ...parsed,
          groupRounds: parsed.groupRounds ?? 3,
          pairs: parsed.pairs ?? [],
          qualifiedIds: parsed.qualifiedIds ?? [],
        },
        unreadableSavedData: false,
      };
    }
  } catch {
    return {
      index: { activeId: 'tournament-1', workspaces: [{ id: 'tournament-1', name: 'Turnier 1' }] },
      tournament: blankTournament(today),
      unreadableSavedData: true,
    };
  }

  // Migrate the existing single-tournament save without deleting or rewriting it.
  const legacy = loadTournament();
  return {
    index: {
      activeId: 'tournament-1',
      workspaces: [{ id: 'tournament-1', name: legacy.tournament.name || 'Turnier 1' }],
    },
    tournament: legacy.tournament,
    unreadableSavedData: legacy.unreadableSavedData,
  };
}

function loadRecoveryBackup(): string | null {
  return loadTournamentRecoveryCopies(localStorage)[0]?.raw ?? null;
}

function AppView() {
  const [location] = useLocation();
  const [initialState] = useState(loadWorkspaceState);
  const [tournament, setTournament] = useState<Tournament>(initialState.tournament);
  const [workspaceIndex, setWorkspaceIndex] = useState<TournamentWorkspaceIndex>(initialState.index);
  const [unreadableSavedData, setUnreadableSavedData] = useState(initialState.unreadableSavedData);
  const [startupRecoveryBackup] = useState(loadRecoveryBackup);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('tt-turnier-sidebar-collapsed-v1') === 'true';
    } catch {
      return false;
    }
  });
  const [modal, setModal] = useState<'pair' | 'score' | 'roster-conflict' | 'new-tournament' | null>(null);
  const [newTournamentName, setNewTournamentName] = useState('');
  const [editingPair, setEditingPair] = useState<RegisteredPair | null>(null);
  const [activeMatch, setActiveMatch] = useState<Match | null>(null);
  const [toast, setToast] = useState('');
  const [groupTab, setGroupTab] = useState<'fixtures' | 'standings'>('fixtures');
  const [menName, setMenName] = useState('');
  const [womenName, setWomenName] = useState('');
  const [pairClub, setPairClub] = useState('');
  const [pastedPairs, setPastedPairs] = useState('');
  const [similarNameWarnings, setSimilarNameWarnings] = useState<{ name: string; matches: string[] }[]>([]);
  const [scoreInputs, setScoreInputs] = useState<string[]>(['', '', '']);
  const clearSimilarNameWarnings = () => setSimilarNameWarnings([]);

  useEffect(() => {
    if (unreadableSavedData) return;
    const serialized = JSON.stringify(tournament);
    const key = workspaceTournamentKey(workspaceIndex.activeId);
    if (localStorage.getItem(key) !== serialized) localStorage.setItem(key, serialized);
  }, [tournament, unreadableSavedData, workspaceIndex.activeId]);
  useEffect(() => {
    if (unreadableSavedData) return;
    try {
      localStorage.setItem(WORKSPACE_INDEX_KEY, JSON.stringify(workspaceIndex));
    } catch {
      setToast('Die Turnierliste konnte nicht gespeichert werden. Prüfe den freien Speicherplatz im Browser.');
    }
  }, [workspaceIndex, unreadableSavedData]);
  useEffect(() => {
    const name = tournament.name.trim() || 'Unbenanntes Turnier';
    setWorkspaceIndex((current) => {
      const active = current.workspaces.find((workspace) => workspace.id === current.activeId);
      return active?.name === name
        ? current
        : upsertTournamentWorkspace(current, { id: current.activeId, name });
    });
  }, [tournament.name]);
  useEffect(() => {
    try {
      localStorage.setItem('tt-turnier-sidebar-collapsed-v1', String(sidebarCollapsed));
    } catch {
      // Keep the sidebar usable when browser storage is unavailable.
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    const syncTournament = (event: StorageEvent) => {
      if (event.key === WORKSPACE_INDEX_KEY && event.newValue) {
        const parsedIndex = parseTournamentWorkspaceIndex(event.newValue);
        if (!parsedIndex) return;
        setWorkspaceIndex(parsedIndex);
        if (parsedIndex.activeId !== workspaceIndex.activeId) {
          setUnreadableSavedData(false);
          const raw = localStorage.getItem(workspaceTournamentKey(parsedIndex.activeId));
          if (!raw) {
            setTournament(blankTournament(today));
            return;
          }
          const saved = parseStoredTournament(raw);
          if (!saved.success) {
            setTournament(blankTournament(today));
            setUnreadableSavedData(true);
            return;
          }
          setTournament({
            ...blankTournament(today),
            ...saved.tournament,
            groupRounds: saved.tournament.groupRounds ?? 3,
            pairs: saved.tournament.pairs ?? [],
            qualifiedIds: saved.tournament.qualifiedIds ?? [],
          });
        }
        return;
      }
      if (event.key !== workspaceTournamentKey(workspaceIndex.activeId)) return;
      if (!event.newValue) {
        setTournament(blankTournament(today));
        return;
      }
      try {
        const result = parseStoredTournament(event.newValue);
        if (!result.success) return;
        const parsed = result.tournament;
        setTournament({
          ...blankTournament(today),
          ...parsed,
          groupRounds: parsed.groupRounds ?? 3,
          pairs: parsed.pairs ?? [],
          qualifiedIds: parsed.qualifiedIds ?? [],
        });
      } catch {
        // Ignore incomplete or malformed changes from another tab.
      }
    };
    window.addEventListener('storage', syncTournament);
    return () => window.removeEventListener('storage', syncTournament);
  }, [workspaceIndex.activeId]);
  useEffect(() => {
    const handleToast = (event: Event) => setToast((event as CustomEvent<string>).detail);
    window.addEventListener('tt-toast', handleToast);
    return () => window.removeEventListener('tt-toast', handleToast);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);
  const completedGroupMatches = tournament.matches.filter((match) => match.stage === 'group' && !match.isBye && match.status === 'completed').length;
  const groupMatches = tournament.matches.filter((match) => match.stage === 'group' && !match.isBye);
  const pendingMatches = tournament.matches.filter((match) => match.status !== 'completed');
  const progress = bracketProgress(tournament);
  const showToast = (message: string) => setToast(message);
  const updateTournament = (patch: Partial<Tournament>) => setTournament((previous) => ({ ...previous, ...patch }));

  function openPair(pair?: RegisteredPair) {
    setEditingPair(pair || null);
    setMenName(pair ? playerById(tournament, pair.menPlayerId)?.name ?? '' : '');
    setWomenName(pair ? playerById(tournament, pair.womenPlayerId)?.name ?? '' : '');
    setPairClub(pair ? playerById(tournament, pair.menPlayerId)?.club ?? '' : '');
    setPastedPairs('');
    clearSimilarNameWarnings();
    setModal('pair');
  }
  function resetSchedule(players: Player[], pairs: RegisteredPair[]) {
    updateTournament({
      players: players.map((player) => ({ ...player, groupId: '' })),
      pairs: pairs.map((pair) => ({ ...pair, groupId: '' })),
      groups: [],
      matches: [],
      qualifiedIds: [],
      phase: 'setup',
    });
  }
  function savePairs(allowSimilarNames = false) {
    const rows = pastedPairs.trim()
      ? pastedPairs.split(/\r\n|\n|\r/).flatMap((line, index) => line.trim()
        ? [{ lineNumber: index + 1, names: line.split(/\s*[;|]\s*/).map((name) => name.trim()) }]
        : [])
      : [{ lineNumber: 1, names: [menName.trim(), womenName.trim()] }];
    const invalidRow = rows.find((row) => row.names.length !== 2 || row.names.some((name) => !name));
    if (invalidRow) {
      showToast(`Zeile ${invalidRow.lineNumber}: genau zwei Namen mit Semikolon oder | eingeben.`);
      return;
    }
    const ignoredIds = editingPair ? [editingPair.menPlayerId, editingPair.womenPlayerId] : [];
    const taken = new Set(tournament.players
      .filter((player) => !ignoredIds.includes(player.id))
      .map((player) => playerNameDuplicateKey(player.name)));
    const newNames = rows.flatMap((row) => row.names);
    const duplicate = newNames.find((name, index) =>
      taken.has(playerNameDuplicateKey(name))
      || newNames.slice(0, index).some((other) => playerNameDuplicateKey(other) === playerNameDuplicateKey(name)),
    );
    if (duplicate) {
      const registeredPlayer = tournament.players.find((player) =>
        !ignoredIds.includes(player.id)
        && playerNameDuplicateKey(player.name) === playerNameDuplicateKey(duplicate),
      );
      const registeredName = registeredPlayer ? ` (bereits registriert als: ${registeredPlayer.name})` : '';
      showToast(`Name bereits vorhanden: ${duplicate}${registeredName}`);
      return;
    }

    const existingNames = tournament.players
      .filter((player) => !ignoredIds.includes(player.id))
      .map((player) => player.name);
    const likelyTypos: { name: string; matches: string[] }[] = [];
    const checkedNames = [...existingNames];
    for (const name of newNames) {
      const matches = findLikelyPlayerNameMatches(name, checkedNames);
      if (matches.length) likelyTypos.push({ name, matches });
      checkedNames.push(name);
    }
    if (likelyTypos.length && !allowSimilarNames) {
      setSimilarNameWarnings(likelyTypos);
      return;
    }
    clearSimilarNameWarnings();

    if (editingPair) {
      if (tournament.matches.length && !window.confirm('Beim Ändern dieses Paars wird der vorhandene Spielplan einschließlich aller Ergebnisse zurückgesetzt. Fortfahren?')) return;
      const { players, pairs } = updateRegisteredPair(
        tournament,
        editingPair.id,
        { men: rows[0].names[0], women: rows[0].names[1] },
        pairClub.trim() || undefined,
        uid,
      );
      if (tournament.matches.length) resetSchedule(players, pairs);
      else updateTournament({ players, pairs });
      setModal(null);
      showToast('Mixed-Paar aktualisiert.');
      return;
    }

    if (tournament.matches.length && !window.confirm('Paar hinzufügen und den vorhandenen Spielplan samt Ergebnissen zurücksetzen?')) return;
    const additions = rows.map(({ names: [manName, womanName] }) => {
      const man: Player = { id: uid(), name: manName, club: pairClub.trim() || undefined, category: 'men', groupId: '' };
      const woman: Player = { id: uid(), name: womanName, club: pairClub.trim() || undefined, category: 'women', groupId: '' };
      return {
        players: [man, woman],
        pair: { id: uid(), menPlayerId: man.id, womenPlayerId: woman.id, groupId: '' } satisfies RegisteredPair,
      };
    });
    const players = [...tournament.players, ...additions.flatMap((addition) => addition.players)];
    const pairs = [...tournament.pairs, ...additions.map((addition) => addition.pair)];
    if (tournament.matches.length) resetSchedule(players, pairs);
    else updateTournament({ players, pairs });
    setModal(null);
    showToast(`${additions.length} Mixed-Paar${additions.length === 1 ? '' : 'e'} hinzugefügt.`);
  }
  function removePair(pair: RegisteredPair) {
    const man = playerById(tournament, pair.menPlayerId);
    const woman = playerById(tournament, pair.womenPlayerId);
    if (!window.confirm(`${man?.name ?? 'Paar'} + ${woman?.name ?? ''} wirklich entfernen? Ein vorhandener Spielplan wird ebenfalls zurückgesetzt.`)) return;
    const { players, pairs } = removePairAndOrphanedPlayers(tournament, pair.id);
    resetSchedule(players, pairs);
    showToast('Mixed-Paar entfernt; Spielplan zurückgesetzt.');
  }
  function generateGroups() {
    if (findPairRosterConflicts(tournament).length || findMissingPairPlayers(tournament).length) {
      setModal('roster-conflict');
      return;
    }
    if (tournament.pairs.length < 2) { showToast('Füge mindestens zwei gemeldete Mixed-Paare hinzu.'); return; }
    const q = Math.max(1, tournament.qualifiersPerGroup);
    if (tournament.matches.some((match) => match.status === 'completed' || match.status === 'in_progress') && !window.confirm('Der bestehende Spielplan enthält gestartete Spiele oder Ergebnisse. Beim Neuverteilen gehen diese verloren. Trotzdem fortfahren?')) return;
    const groups = [{ id: 'group-1', name: 'Gesamtgruppe' }];
    const pairs = tournament.pairs.map((pair) => ({ ...pair, groupId: groups[0].id }));
    const players = tournament.players.map((player) => ({ ...player, groupId: groups[0].id }));
    const draft = { ...tournament, qualifiersPerGroup: q };
    const matches = createGroupSchedule(draft, pairs, players, groups, uid);
    updateTournament({ players, pairs, groups, matches, qualifiedIds: [], phase: 'groups' });
    showToast(`Spielplan für die Gesamtgruppe erstellt: ${tournament.groupRounds} Runden.`);
  }
  function startMatch(match: Match) {
    if (match.status !== 'pending' || match.isBye) return;
    if (match.round !== currentRoundNumber(tournament, match.stage)) {
      showToast('Bitte zuerst alle Spiele der aktuellen Runde abschließen.');
      return;
    }
    updateTournament({
      matches: tournament.matches.map((candidate) =>
        candidate.id === match.id ? { ...candidate, status: 'in_progress' as const } : candidate,
      ),
    });
    showToast('Spiel läuft und wird jetzt auf dem Monitor angezeigt.');
  }
  function beginKnockout() {
    if (findPairRosterConflicts(tournament).length || findMissingPairPlayers(tournament).length) {
      setModal('roster-conflict');
      return;
    }
    if (tournament.groups.length !== 1) { showToast('Erstelle zuerst den Spielplan für eine Gesamtgruppe.'); return; }
    if (!tournament.groups.length || groupMatches.some((m) => m.status !== 'completed')) { showToast('Erst alle Gruppenspiele abschließen.'); return; }
    const teams = qualifiedMixedTeams(tournament);
    if (teams.length < 2) { showToast('Für die KO-Runde werden mindestens zwei Mixed-Paare benötigt.'); return; }
    const matches = createKnockoutMatches(teams, 1, tournament.tableCount, uid);
    const qualifiedIds = teams.flatMap((team) => team);
    updateTournament({ qualifiedIds, matches: [...tournament.matches, ...matches], phase: 'knockout' });
    showToast(`${teams.length} Mixed-Paare qualifiziert und neu zusammengestellt.`);
  }
  function openScore(match: Match) {
    if (match.isBye || !match.side2) return;
    if (match.stage === 'group' && tournament.qualifiedIds.length) {
      if (!window.confirm('Die Finalrunde wird verworfen, damit die geänderten Gruppenergebnisse neu gewertet werden können. Fortfahren?')) return;
      updateTournament({
        matches: tournament.matches.filter((candidate) => candidate.stage === 'group'),
        qualifiedIds: [],
        phase: 'groups',
      });
    }
    setActiveMatch(match);
    const existingInputs: string[] = [];
    let side1Sets = 0;
    let side2Sets = 0;
    for (const set of match.sets) {
      if (side1Sets === 2 || side2Sets === 2) break;
      existingInputs.push(`${set.p1}:${set.p2}`);
      if (set.p1 > set.p2) side1Sets += 1;
      else side2Sets += 1;
    }
    setScoreInputs([...existingInputs, ...Array.from({ length: Math.max(0, 3 - existingInputs.length) }, () => '')]);
    setModal('score');
  }
  function saveScore(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeMatch) return;
    const parsed = scoreInputs.map(parseSetScoreInput);
    if (parsed.some((score) => score === undefined)) {
      showToast('Ungültiger Satzstand. Nutze z. B. 11:7, 5 (wie +5) oder -7.');
      return;
    }
    const firstEmpty = parsed.indexOf(null);
    if (firstEmpty >= 0 && parsed.slice(firstEmpty + 1).some((score) => score !== null)) {
      showToast('Bitte die Satzergebnisse der Reihe nach ohne Lücken eintragen.');
      return;
    }
    const clean = parsed.filter((score): score is SetScore => score !== null && score !== undefined);
    const resolution = resolveBestOfThree(clean);
    if (!resolution.ok) {
      showToast(resolution.reason === 'extra-sets'
        ? 'Nach zwei gewonnenen Sätzen dürfen keine weiteren Sätze folgen.'
        : 'Das Match ist entschieden, sobald ein Paar zwei Sätze gewonnen hat.');
      return;
    }
    const winnerSide = resolution.winnerSide;
    const sourceMatches = activeMatch.stage === 'knockout'
      ? tournament.matches.filter((match) => match.stage !== 'knockout' || match.round <= activeMatch.round)
      : tournament.matches;
    const updatedMatches = sourceMatches.map((match) => match.id === activeMatch.id
      ? { ...match, sets: clean, status: 'completed' as const, winnerSide }
      : match);
    if (activeMatch.stage === 'knockout') {
      const roundMatches = updatedMatches.filter((match) => match.stage === 'knockout' && match.round === activeMatch.round && !match.isThirdPlace);
      if (roundMatches.length && roundMatches.every((match) => match.status === 'completed')) {
        const winners = roundMatches.map((match) => match.winnerSide === 1 ? match.side1 : match.winnerSide === 2 ? match.side2 : null).filter((team): team is MatchSide => Boolean(team));
        if (winners.length === 1) {
          const thirdPlaceMatch = updatedMatches.find((match) => match.stage === 'knockout' && match.isThirdPlace && match.round === activeMatch.round);
          updateTournament({ phase: thirdPlaceMatch && thirdPlaceMatch.status !== 'completed' ? 'knockout' : 'finished', matches: updatedMatches });
        } else if (roundMatches.filter((match) => !match.isBye).length === 2 && winners.length === 2) {
          updateTournament({ phase: 'knockout', matches: updatedMatches });
        } else {
          const allMatches = [...updatedMatches];
          const history = partnerHistoryFor({ ...tournament, matches: updatedMatches });
          const mixed = pairMixedPlayers(winners.flatMap((team) => team.map((id) => playerById(tournament, id)).filter((player): player is Player => Boolean(player))), history);
          const nextMatches = createKnockoutMatches(mixed.teams, activeMatch.round + 1, tournament.tableCount, uid, mixed.byeTeam);
          allMatches.push(...nextMatches);
          updateTournament({ phase: 'knockout', matches: allMatches });
        }
      } else updateTournament({ matches: updatedMatches });
    } else updateTournament({ matches: updatedMatches, phase: 'groups' });
    setModal(null); showToast('Ergebnis gespeichert. Ein Sieg zählt als ein Schleiferl pro Person.');
  }
  function continueKnockoutWithThirdPlace(playThirdPlace: boolean) {
    const semifinalMatches = progress.rounds.at(-1)?.matches.filter((match) => !match.isBye && !match.isThirdPlace) ?? [];
    if (semifinalMatches.length !== 2 || semifinalMatches.some((match) => match.status !== 'completed')) {
      showToast('Die beiden Halbfinals müssen zuerst abgeschlossen sein.');
      return;
    }
    const winners = semifinalMatches.map((match) => match.winnerSide === 1 ? match.side1 : match.winnerSide === 2 ? match.side2 : null);
    const losers = semifinalMatches.map((match) => match.winnerSide === 1 ? match.side2 : match.winnerSide === 2 ? match.side1 : null);
    if (winners.some((team) => !team) || losers.some((team) => !team)) {
      showToast('Die Halbfinalergebnisse sind unvollständig.');
      return;
    }
    const history = partnerHistoryFor(tournament);
    const finalTeams = pairMixedPlayers(
      (winners as MatchSide[]).flatMap((team) => team.map((id) => playerById(tournament, id)).filter((player): player is Player => Boolean(player))),
      history,
    );
    const finalMatches = createKnockoutMatches(finalTeams.teams, (progress.rounds.at(-1)?.round ?? 1) + 1, tournament.tableCount, uid, finalTeams.byeTeam);
    const nextMatches = [...finalMatches];
    if (playThirdPlace) {
      const thirdPlaceTeams = pairMixedPlayers(
        (losers as MatchSide[]).flatMap((team) => team.map((id) => playerById(tournament, id)).filter((player): player is Player => Boolean(player))),
        history,
      );
      const [thirdPlaceMatch] = createKnockoutMatches(thirdPlaceTeams.teams, (progress.rounds.at(-1)?.round ?? 1) + 1, tournament.tableCount, uid, thirdPlaceTeams.byeTeam);
      if (thirdPlaceMatch) {
        const finalTable = finalMatches[0]?.tableNumber ?? 1;
        const thirdPlaceTable = tournament.tableCount > 1 ? (finalTable % tournament.tableCount) + 1 : finalTable;
        nextMatches.push({ ...thirdPlaceMatch, tableNumber: thirdPlaceTable, isThirdPlace: true });
      }
    }
    updateTournament({ matches: [...tournament.matches, ...nextMatches], phase: 'knockout' });
    showToast(playThirdPlace ? 'Finale und Spiel um Platz 3 erstellt.' : 'Finale erstellt; das Spiel um Platz 3 wird ausgelassen.');
  }
  function resetTournament() {
    if (!window.confirm('Dieses Turnier und alle zugehörigen Ergebnisse dauerhaft zurücksetzen? Andere Turniere bleiben erhalten.')) return;
    setTournament(blankTournament(today));
    showToast('Die Daten dieses Turniers wurden zurückgesetzt.');
  }
  function switchTournament(id: string) {
    if (id === workspaceIndex.activeId) return;
    if (!workspaceIndex.workspaces.some((workspace) => workspace.id === id)) return;
    if (!unreadableSavedData) {
      localStorage.setItem(workspaceTournamentKey(workspaceIndex.activeId), JSON.stringify(tournament));
    }
    const raw = localStorage.getItem(workspaceTournamentKey(id));
    const nextIndex = selectTournamentWorkspace(workspaceIndex, id);
    setWorkspaceIndex(nextIndex);
    setModal(null);
    setUnreadableSavedData(false);
    if (!raw) {
      setTournament(blankTournament(today));
      return;
    }
    const saved = parseStoredTournament(raw);
    if (!saved.success) {
      setTournament(blankTournament(today));
      setUnreadableSavedData(true);
      return;
    }
    setTournament({
      ...blankTournament(today),
      ...saved.tournament,
      groupRounds: saved.tournament.groupRounds ?? 3,
      pairs: saved.tournament.pairs ?? [],
      qualifiedIds: saved.tournament.qualifiedIds ?? [],
    });
  }
  function createTournament(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newTournamentName.trim();
    if (!name) return;
    if (!unreadableSavedData) {
      localStorage.setItem(workspaceTournamentKey(workspaceIndex.activeId), JSON.stringify(tournament));
    }
    const id = uid();
    const fresh = { ...blankTournament(today), name };
    const nextIndex = upsertTournamentWorkspace(workspaceIndex, { id, name });
    nextIndex.activeId = id;
    localStorage.setItem(workspaceTournamentKey(id), JSON.stringify(fresh));
    setWorkspaceIndex(nextIndex);
    setTournament(fresh);
    setUnreadableSavedData(false);
    setNewTournamentName('');
    setModal(null);
    showToast(`„${name}“ wurde angelegt.`);
  }
  function continueWithBlankTournament() {
    setUnreadableSavedData(false);
  }
  function restoreStartupBackup(raw: string): boolean {
    const parsed = parseTournamentBackup(raw);
    if (!parsed.success) return false;
    setTournament(parsed.tournament);
    setUnreadableSavedData(false);
    return true;
  }

  const title = tournament.name || 'Vereinsturnier';
  const routeLabel = location === '/participants' ? 'Mixed-Paare' : location === '/players' ? 'Spielerwertung' : location === '/groups' ? 'Gruppenphase' : location === '/knockout' ? 'KO-Runde' : location === '/settings' ? 'Einstellungen' : 'Turnier';
  if (location === '/monitor') return <>
    <Monitor tournament={tournament}/>
    {unreadableSavedData && <StartupRecoveryDialog
      recoveryBackup={startupRecoveryBackup}
      onRestore={restoreStartupBackup}
      onContinue={continueWithBlankTournament}
    />}
  </>;
  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="side-rail">
        <div className="brand"><img className="brand-logo" src={`${import.meta.env.BASE_URL}djk-hafner-logo.png`} alt="DJK Hafner Straubing"/><div><div className="brand-name">{tournament.name || 'Plattenplan'}</div></div></div>
        <div className="nav-label">Turnier</div>
        <nav id="main-navigation" className="nav-list" aria-label="Hauptnavigation">
          <Link href="/" className={`nav-link ${location === '/' ? 'active' : ''}`} aria-label="Übersicht" title="Übersicht" data-testid="link-overview"><Activity size={16}/> <span className="nav-link-label">Übersicht</span></Link>
          <Link href="/participants" className={`nav-link ${location === '/participants' ? 'active' : ''}`} aria-label="Mixed-Paare" title="Mixed-Paare" data-testid="link-participants"><Users size={16}/> <span className="nav-link-label">Mixed-Paare</span></Link>
          <Link href="/players" className={`nav-link ${location === '/players' ? 'active' : ''}`} aria-label="Spielerwertung" title="Spielerwertung" data-testid="link-players"><Users size={16}/> <span className="nav-link-label">Spielerwertung</span></Link>
          <Link href="/groups" className={`nav-link ${location === '/groups' ? 'active' : ''}`} aria-label="Gruppenphase" title="Gruppenphase" data-testid="link-groups"><ListChecks size={16}/> <span className="nav-link-label">Gruppenphase</span></Link>
          <Link href="/knockout" className={`nav-link ${location === '/knockout' ? 'active' : ''}`} aria-label="KO-Runde" title="KO-Runde" data-testid="link-knockout"><Trophy size={16}/> <span className="nav-link-label">KO-Runde</span></Link>
          <Link href="/monitor" target="_blank" rel="noreferrer" className="nav-link" aria-label="Monitor" title="Monitor" data-testid="link-monitor"><MonitorIcon size={16}/> <span className="nav-link-label">Monitor</span></Link>
        </nav>
        <div className="nav-label">Verwaltung</div>
        <nav className="nav-list">
          <Link href="/settings" className={`nav-link ${location === '/settings' ? 'active' : ''}`} aria-label="Einstellungen" title="Einstellungen" data-testid="link-settings"><Settings2 size={16}/> <span className="nav-link-label">Einstellungen</span></Link>
        </nav>
        <div className="rail-foot">{dateLabel(tournament.date)}<br/>{tournament.pairs.length} Mixed-Paare · {tournament.players.length} Spieler</div>
      </aside>
      <div className="main-area">
        <header className="topbar"><div className="topbar-start"><button type="button" className="btn btn-quiet sidebar-toggle" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} aria-expanded={!sidebarCollapsed} aria-controls="main-navigation" title={sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'} data-testid="button-toggle-sidebar">{sidebarCollapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}</button><div className="crumb">Plattenplan <ChevronRight size={13} style={{ verticalAlign: 'middle', margin: '0 5px' }}/><b>{routeLabel}</b></div></div><div className="topbar-workspaces"><label className="sr-only" htmlFor="active-tournament">Aktives Turnier</label><select id="active-tournament" value={workspaceIndex.activeId} onChange={(event) => switchTournament(event.target.value)} aria-label="Aktives Turnier auswählen" data-testid="select-active-tournament">{workspaceIndex.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name || 'Unbenanntes Turnier'}</option>)}</select><button type="button" className="btn btn-primary" onClick={() => { setNewTournamentName(''); setModal('new-tournament'); }} data-testid="button-new-tournament"><Plus size={14}/>Neues Turnier</button></div></header>
        <main className="content">
          <Switch>
            <Route path="/"><Overview tournament={tournament} progress={progress} pending={pendingMatches.length} completedGroupMatches={completedGroupMatches} groupMatchCount={groupMatches.length} onAdd={() => openPair()} onStart={generateGroups}/></Route>
            <Route path="/participants"><Participants tournament={tournament} onAdd={() => openPair()} onEdit={openPair} onRemove={removePair}/></Route>
            <Route path="/players"><Players tournament={tournament}/></Route>
            <Route path="/groups"><Groups tournament={tournament} tab={groupTab} setTab={setGroupTab} onScore={openScore} onStartMatch={startMatch} onGenerate={generateGroups} onKnockout={beginKnockout}/></Route>
            <Route path="/knockout"><Knockout tournament={tournament} progress={progress} onScore={openScore} onStartMatch={startMatch} onStart={beginKnockout} onContinue={continueKnockoutWithThirdPlace}/></Route>
            <Route path="/settings"><Settings tournament={tournament} onSave={updateTournament} onImport={setTournament} onReset={resetTournament}/></Route>
            <Route component={NotFound}/>
          </Switch>
        </main>
      </div>
      {modal === 'pair' && <Modal title={editingPair ? 'Mixed-Paar bearbeiten' : 'Mixed-Paar anmelden'} onClose={() => setModal(null)}>
        <form onSubmit={(event) => { event.preventDefault(); savePairs(); }}>
          {editingPair ? <div className="form-grid">
            <Field label="Spieler aus dem Herrenfeld" value={menName} onChange={(value) => { setMenName(value); clearSimilarNameWarnings(); }} testId="input-pair-man"/>
            <Field label="Spielerin aus dem Damenfeld" value={womenName} onChange={(value) => { setWomenName(value); clearSimilarNameWarnings(); }} testId="input-pair-woman"/>
          </div> : <div className="form-grid">
            <div className="field full"><label htmlFor="mixed-pairs-list">Mehrere Paare einfügen</label><textarea id="mixed-pairs-list" value={pastedPairs} onChange={(e) => { setPastedPairs(e.target.value); clearSimilarNameWarnings(); }} placeholder={'Herrenfeld-Spieler; Damenfeld-Spielerin\nMax Mustermann; Erika Beispiel'} data-testid="input-pair-list"/><div className="field-hint">Eine Zeile pro Paar. Namen mit Semikolon oder | trennen. Jeder Name muss einmalig sein.</div></div>
            {!pastedPairs.trim() && <>
              <Field label="Spieler aus dem Herrenfeld" value={menName} onChange={(value) => { setMenName(value); clearSimilarNameWarnings(); }} testId="input-pair-man"/>
              <Field label="Spielerin aus dem Damenfeld" value={womenName} onChange={(value) => { setWomenName(value); clearSimilarNameWarnings(); }} testId="input-pair-woman"/>
            </>}
          </div>}
          <div style={{ marginTop: 12 }}><Field label="Verein (optional, gilt für beide)" value={pairClub} onChange={setPairClub} testId="input-pair-club"/></div>
          {similarNameWarnings.length > 0 && <div role="alert" data-testid="similar-name-warning" style={{ marginTop: 14, padding: 12, border: '1px solid #e5b35b', borderRadius: 8, background: '#fff8e8', color: '#593d0a', fontSize: 12, lineHeight: 1.5 }}>
            <strong>Möglicher Schreibfehler bei Spielernamen</strong>
            <p style={{ margin: '5px 0 10px' }}>Diese Namen ähneln bereits registrierten Namen. Prüfe, ob sie richtig geschrieben sind:</p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>{similarNameWarnings.map(({ name, matches }) => <li key={name}>„{name}“ ähnelt {matches.map((match) => `„${match}“`).join(', ')}</li>)}</ul>
            <div className="form-actions" style={{ margin: 0 }}>
              <button type="button" className="btn btn-secondary" onClick={clearSimilarNameWarnings} data-testid="button-review-similar-names">Namen weiter prüfen</button>
              <button type="button" className="btn btn-primary" onClick={() => savePairs(true)} data-testid="button-accept-similar-names">Trotzdem speichern</button>
            </div>
          </div>}
          <div className="form-actions"><button type="button" className="btn btn-secondary" onClick={() => setModal(null)} data-testid="button-cancel-pair">Abbrechen</button><button className="btn btn-primary" type="submit" data-testid="button-save-pair"><Check size={14}/>{editingPair ? 'Paar speichern' : 'Paar anmelden'}</button></div>
        </form>
      </Modal>}
      {modal === 'new-tournament' && <Modal title="Neues Turnier anlegen" onClose={() => setModal(null)}>
        <form onSubmit={createTournament}>
          <Field label="Name des Turniers" value={newTournamentName} onChange={setNewTournamentName} testId="input-new-tournament-name"/>
          <p className="field-hint">Dein aktuelles Turnier bleibt gespeichert. Das neue Turnier beginnt mit einer leeren Meldeliste.</p>
          <div className="form-actions"><button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>Abbrechen</button><button className="btn btn-primary" type="submit" disabled={!newTournamentName.trim()} data-testid="button-create-tournament"><Plus size={14}/>Turnier anlegen</button></div>
        </form>
      </Modal>}
      {modal === 'score' && activeMatch && <Modal title={activeMatch.status === 'completed' ? 'Spielergebnis bearbeiten' : 'Spielergebnis eintragen'} onClose={() => setModal(null)}>
         <div data-testid="score-match-teams" style={{ fontSize: 12, color: '#7b1b27', marginBottom: 16, fontWeight: 700 }}>{teamLabel(tournament, activeMatch.side1)} <span style={{ color: '#9a8589', margin: '0 7px' }}>gegen</span> {teamLabel(tournament, activeMatch.side2)}</div>
        <form onSubmit={saveScore}>
          <div style={{ display: 'grid', gap: 9 }}>
            {scoreInputs.map((score, i) => <div className="set-row" key={i}><label className="set-label" htmlFor={`score-set-${i + 1}`}>SATZ {i + 1}</label><input id={`score-set-${i + 1}`} type="text" inputMode="text" maxLength={7} placeholder="11:7, 5 oder -7" value={score} onChange={(e) => setScoreInputs((old) => old.map((value, n) => n === i ? e.target.value : value))} aria-label={`Ergebnis für Satz ${i + 1}; Eingabe aus Sicht von ${teamLabel(tournament, activeMatch.side1)}`} data-testid={`input-score-set-${i + 1}`}/></div>)}
          </div>
          <p className="field-hint" style={{ marginTop: 12 }}>Zwei Gewinnsätze. Gib den vollständigen Stand ein (11:7) oder aus Sicht des zuerst genannten Paars 5 bzw. +5 (11:5) oder -7 (7:11). Eine Zahl ohne Vorzeichen zählt wie +. Ein Satz zählt ab 11 Punkten mit zwei Punkten Abstand.</p>
          <div className="form-actions"><button type="button" className="btn btn-secondary" onClick={() => setModal(null)} data-testid="button-cancel-score">Abbrechen</button><button className="btn btn-primary" type="submit" data-testid="button-save-score"><Check size={14}/>Ergebnis speichern</button></div>
        </form>
      </Modal>}
      {modal === 'roster-conflict' && <Modal title="Meldeliste muss geprüft werden" onClose={() => setModal(null)}>
        <p style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.6 }}>
          Für diese gespeicherten Paare kann kein Spielplan erstellt werden. Prüfe die mehrfachen Zuordnungen und fehlenden Spielerdatensätze:
        </p>
        <ul data-testid="roster-conflict-list" style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 12, lineHeight: 1.7 }}>
          {findPairRosterConflicts(tournament).map((conflict) => {
            const conflictingPairs = conflict.pairIds.flatMap((pairId) => {
              const pairIndex = tournament.pairs.findIndex((pair) => pair.id === pairId);
              const pair = tournament.pairs[pairIndex];
              if (!pair || pairIndex < 0) return [];
              return [{
                id: pair.id,
                number: pairIndex + 1,
                names: [
                  playerById(tournament, pair.menPlayerId)?.name ?? 'Unbekannter Spieler',
                  playerById(tournament, pair.womenPlayerId)?.name ?? 'Unbekannte Spielerin',
                ],
              }];
            });
            return <li key={conflict.playerId}>
              <strong>{playerById(tournament, conflict.playerId)?.name ?? 'Unbekannter Spieler'}</strong>
              {' ist in folgenden Paaren eingetragen:'}
              <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>
                {conflictingPairs.map((pair) => <li key={pair.id}>Paar {pair.number}: {pair.names.join(' + ')}</li>)}
              </ul>
            </li>;
          })}
          {findMissingPairPlayers(tournament).map((missing) => {
            const pairNumbers = missing.pairIds
              .map((pairId) => tournament.pairs.findIndex((pair) => pair.id === pairId) + 1)
              .filter((pairNumber) => pairNumber > 0);
            return <li key={`missing-${missing.playerId}`}>
              <strong>Spielerdatensatz fehlt</strong>
              {' (ID '}{missing.playerId}{') in Paar '}{pairNumbers.join(' und ')}.
            </li>;
          })}
        </ul>
        <div className="warning-box" style={{ marginBottom: 16 }}>
          Es wurden keine Turnierdaten geändert. Öffne „Mixed-Paare“ und bearbeite das betroffene Paar: Trage bei einem fehlenden Spielerdatensatz den Namen erneut ein oder ersetze dort eine doppelt zugeordnete Person. Alternativ kannst du das betroffene Paar entfernen und neu anmelden.
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setModal(null)} data-testid="button-close-roster-conflict">Später</button>
          <Link href="/participants" className="btn btn-primary" onClick={() => setModal(null)} data-testid="link-fix-roster-conflict">Mixed-Paare öffnen</Link>
        </div>
      </Modal>}
      {unreadableSavedData && <StartupRecoveryDialog
        recoveryBackup={startupRecoveryBackup}
        onRestore={restoreStartupBackup}
        onContinue={continueWithBlankTournament}
      />}
      {toast && <div className="toast-message" role="status" data-testid="status-toast">{toast}</div>}
    </div>
  );
}

function Field({ label, value, onChange, testId, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; testId: string; type?: string }) {
  return <div className="field"><label htmlFor={testId}>{label}</label><input id={testId} type={type} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}/></div>;
}
function Modal({ title, children, onClose, dismissible = true, initialFocus = 'field' }: { title: string; children: ReactNode; onClose: () => void; dismissible?: boolean; initialFocus?: 'field' | 'button' }) {
  const contentRef = useRef<HTMLDivElement>(null);
  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="app-dialog-overlay"/>
      <DialogPrimitive.Content
        ref={contentRef}
        className="app-dialog"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          const selector = initialFocus === 'button'
            ? 'button:not([disabled])'
            : 'input:not([disabled]), textarea:not([disabled]), select:not([disabled])';
          const firstTarget = contentRef.current?.querySelector<HTMLElement>(selector);
          if (firstTarget) {
            event.preventDefault();
            firstTarget.focus();
          }
        }}
      >
        <div className="modal-head"><DialogPrimitive.Title className="modal-title">{title}</DialogPrimitive.Title>{dismissible && <DialogPrimitive.Close asChild><button type="button" className="modal-close" aria-label="Dialog schließen" data-testid="button-close-modal"><X size={18}/></button></DialogPrimitive.Close>}</div>
        <div className="modal-body">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
function StartupRecoveryDialog({ recoveryBackup, onRestore, onContinue }: { recoveryBackup: string | null; onRestore: (raw: string) => boolean; onContinue: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  async function importBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      if (!onRestore(raw)) {
        const parsed = parseTournamentBackup(raw);
        setError(parsed.success ? 'Die Sicherung konnte nicht geladen werden.' : parsed.message);
      }
    } catch {
      setError('Die Datei konnte nicht gelesen werden. Bitte wähle eine gültige JSON-Sicherung.');
    }
  }
  function restoreRecoveryCopy() {
    if (!recoveryBackup) return;
    if (!onRestore(recoveryBackup)) setError('Die Wiederherstellungskopie ist ungültig und kann nicht geladen werden.');
  }
  return <Modal title="Gespeicherte Turnierdaten nicht lesbar" onClose={() => {}} dismissible={false} initialFocus="button">
    <p style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.65 }} role="alert" data-testid="alert-unreadable-tournament">
      Die gespeicherten Turnierdaten sind beschädigt oder unvollständig. Sie wurden noch nicht überschrieben.
    </p>
    <p style={{ margin: '0 0 14px', fontSize: 12, lineHeight: 1.65 }}>
      Lade, falls vorhanden, eine Wiederherstellungskopie oder wähle eine heruntergeladene Sicherung. Erst wenn du ausdrücklich fortfährst, wird ein leeres Turnier gespeichert.
    </p>
    {error && <p style={{ margin: '0 0 12px', color: '#990000', fontSize: 12 }} role="alert" data-testid="text-startup-backup-error">{error}</p>}
    <input ref={inputRef} type="file" accept=".json,application/json" onChange={importBackup} style={{ display: 'none' }} data-testid="input-startup-backup"/>
    <div className="form-actions" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
      {recoveryBackup && <button type="button" className="btn btn-secondary" onClick={restoreRecoveryCopy} data-testid="button-load-startup-recovery">Wiederherstellungskopie laden</button>}
      <button type="button" className="btn btn-secondary" onClick={() => inputRef.current?.click()} data-testid="button-select-startup-backup">Sicherung auswählen</button>
      <button type="button" className="btn btn-danger" onClick={onContinue} data-testid="button-continue-blank">Mit leerem Turnier fortfahren</button>
    </div>
  </Modal>;
}
function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1><p className="page-subtitle">{subtitle}</p></div>{action}</div>;
}
function Overview({ tournament, progress, pending, completedGroupMatches, groupMatchCount, onAdd, onStart }: { tournament: Tournament; progress: ReturnType<typeof bracketProgress>; pending: number; completedGroupMatches: number; groupMatchCount: number; onAdd: () => void; onStart: () => void }) {
  const champion = progress.championIds ? teamLabel(tournament, progress.championIds) : null;
  const phaseNames = { setup: 'Einrichtung', groups: 'Gruppenphase', knockout: 'KO-Runde', finished: 'Beendet' };
  return <>
    <PageHeading eyebrow="Turnierübersicht" title={tournament.name || 'Dein Turniertag, im Überblick.'} subtitle={tournament.name ? dateLabel(tournament.date) : 'Alles für einen reibungslosen Spieltag an einem Ort.'} action={<Link href="/settings" className="btn btn-secondary" data-testid="button-edit-tournament"><Pencil size={14}/>Turnierdaten</Link>}/>
    <div className="metrics">
      <Metric label="Mixed-Paare" value={tournament.pairs.length} detail={`${tournament.players.length} Spieler eingetragen`} icon={<Users size={15}/>}/>
      <Metric label="Gesamtgruppe" value={tournament.groups.length === 1 ? 1 : tournament.groups.length || '–'} detail={tournament.groups.length > 1 ? 'Alte Einteilung · neuen Spielplan erstellen' : tournament.groups.length ? `${tournament.groupRounds} Runden · beste Spieler je Feld weiter` : 'Spielplan noch offen'} icon={<Table2 size={15}/>}/>
      <Metric label="Offene Spiele" value={pending} detail={tournament.matches.length ? `${completedGroupMatches} Vorrundenspiele abgeschlossen` : 'Noch keine Begegnungen'} icon={<Clock3 size={15}/>}/>
      <Metric label="Turnierphase" value={phaseNames[tournament.phase]} detail={tournament.tableCount + ' Tische verfügbar'} icon={<Flag size={15}/>}/>
    </div>
    <div className="overview-grid">
      <section className="panel">
         <div className="panel-head"><div><div className="panel-title">Spieltag im Blick</div><div className="panel-note">Der aktuelle Stand deines Turniers</div></div><Activity size={17} color="#990000"/></div>
        <div className="panel-body">
          {tournament.pairs.length === 0 ? <div className="empty-state"><div className="empty-icon"><ClipboardList size={20}/></div><h3>Dein Turnier beginnt hier</h3><p>Melde zuerst die festen Mixed-Paare an. Runde 1 startet mit diesen Teams; danach werden die Partner neu zugelost.</p><button className="btn btn-primary" onClick={onAdd} data-testid="button-add-first-pair"><Plus size={14}/>Erstes Mixed-Paar anmelden</button></div> :
          <><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 19 }}><div><div className="panel-title">Spiele in der Gesamtgruppe</div><div className="panel-note">Fortschritt in der Vorrunde</div></div><Link href="/groups" className="btn btn-quiet" data-testid="link-open-groups">Zur Gruppenphase <ChevronRight size={14}/></Link></div>
            <div className="progress-wrap"><div className="progress-track"><div className="progress-fill" style={{ width: `${groupMatchCount ? completedGroupMatches / groupMatchCount * 100 : 0}%` }}/></div><span className="progress-count">{completedGroupMatches} / {groupMatchCount} Spiele</span></div>
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 22 }}>
              {tournament.groups.length !== 1 ? <button className="btn btn-primary" onClick={onStart} data-testid="button-create-schedule"><Shuffle size={14}/>{tournament.groups.length > 1 ? 'Gesamtgruppe erstellen' : 'Spielplan erstellen'}</button> : null}
              {tournament.groups.length === 1 && completedGroupMatches === groupMatchCount && !tournament.qualifiedIds?.length && <Link href="/groups" className="btn btn-primary" data-testid="button-start-knockout"><Trophy size={14}/>KO-Runde vorbereiten</Link>}
              {champion && <div className="pill pill-done"><Crown size={13}/>Turniersieger: {champion}</div>}
            </div>
          </>}
        </div>
      </section>
      <section className="panel">
         <div className="panel-head"><div><div className="panel-title">Nächste Schritte</div><div className="panel-note">Ein einfacher Ablauf, ohne Tabellenchaos</div></div><CircleHelp size={16} color="#990000"/></div>
        <div className="panel-body">
          <Step number="01" title="Mixed-Paare anmelden" detail={`${tournament.pairs.length} Paare · ${tournament.players.length} Spieler`} done={tournament.pairs.length >= 2}/>
          <Step number="02" title="Spielplan erstellen" detail={tournament.groups.length > 1 ? 'Gespeicherte alte Einteilung ersetzen' : tournament.groups.length ? 'Eine Gesamtgruppe · Runde 1 mit festen Paaren' : 'Alle Paare spielen in einer Gesamtgruppe'} done={tournament.groups.length === 1}/>
          <Step number="03" title="Ergebnisse eintragen" detail={groupMatchCount ? `${completedGroupMatches} von ${groupMatchCount} Gruppenspielen` : 'Nach jeder Begegnung direkt erfassen'} done={groupMatchCount > 0 && completedGroupMatches === groupMatchCount}/>
          <Step number="04" title="Finalrunde spielen" detail={tournament.phase === 'finished' ? 'Turnier ist abgeschlossen' : 'Qualifizierte spielen um den Sieg'} done={tournament.phase === 'finished'}/>
        </div>
      </section>
    </div>
  </>;
}
function Metric({ label, value, detail, icon }: { label: string; value: string | number; detail: string; icon: ReactNode }) {
  return <div className="metric" data-testid={`metric-${label.toLocaleLowerCase('de').replaceAll(' ', '-')}`}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div className="metric-label">{label}</div><span style={{ color: '#87998e' }}>{icon}</span></div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></div>;
}
function Step({ number, title, detail, done }: { number: string; title: string; detail: string; done: boolean }) {
   return <div className="list-row"><div className="avatar" style={{ background: done ? '#fff2f2' : '#fffafa', color: '#990000' }}>{done ? <Check size={14}/> : number}</div><div><div className="row-name">{title}</div><div className="row-meta">{detail}</div></div><div className="row-end">{done && <span className="pill pill-done">Erledigt</span>}</div></div>;
}
function Participants({ tournament, onAdd, onEdit, onRemove }: { tournament: Tournament; onAdd: () => void; onEdit: (pair: RegisteredPair) => void; onRemove: (pair: RegisteredPair) => void }) {
  return <>
    <PageHeading eyebrow="Meldeliste" title="Mixed-Paare" subtitle="Runde 1 spielt mit den gemeldeten Paaren. Ab Runde 2 werden die Partner neu ausgelost." action={<button className="btn btn-primary" onClick={onAdd} data-testid="button-add-pair"><Plus size={15}/>Mixed-Paar anmelden</button>}/>
    {tournament.legacyParticipantNames?.length ? <div className="panel" style={{ marginBottom: 14 }}><div className="panel-body"><div className="panel-title">Bisherige Einzelnamen aus der alten Meldeliste</div><p className="panel-note">Diese Namen wurden bewahrt, aber noch keinem Mixed-Paar zugeordnet. Bitte beim Anmelden der Paare manuell übernehmen.</p><div style={{ marginTop: 8, fontSize: 12 }}>{tournament.legacyParticipantNames.join(' · ')}</div></div></div> : null}
    <div className="panel">
      <div className="panel-head"><div><div className="panel-title">Gemeldete Teams</div><div className="panel-note">{tournament.pairs.length} Mixed-Paare · {tournament.players.length} Spielerinnen und Spieler</div></div><span className="pill pill-info"><Users size={12}/>{tournament.pairs.length}</span></div>
      {tournament.pairs.length === 0 ? <div className="empty-state"><div className="empty-icon"><Users size={20}/></div><h3>Noch keine Mixed-Paare</h3><p>Melde pro Team eine Person aus dem Herrenfeld und eine Person aus dem Damenfeld an.</p><button className="btn btn-primary" onClick={onAdd} data-testid="button-add-empty-pair"><Plus size={14}/>Erstes Paar anmelden</button></div> :
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Nr.</th><th>Gemeldetes Paar</th><th>Verein</th><th></th></tr></thead><tbody>{tournament.pairs.map((pair, i) => {
          const man = playerById(tournament, pair.menPlayerId);
          const woman = playerById(tournament, pair.womenPlayerId);
           const manName = man?.name ?? 'Fehlender Spieler';
           const womanName = woman?.name ?? 'Fehlende Spielerin';
           return <tr key={pair.id} data-testid={`row-pair-${pair.id}`}><td className="rank">{String(i + 1).padStart(2, '0')}</td><td className="strong"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span className="avatar" style={{ display: 'inline-grid' }}>{manName.split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase()}</span>{manName} + {womanName}</span></td><td>{man?.club || woman?.club || '—'}</td><td><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}><button className="btn btn-quiet" onClick={() => onEdit(pair)} aria-label={`Paar ${manName} und ${womanName} bearbeiten`} data-testid={`button-edit-pair-${pair.id}`}><Pencil size={14}/></button><button className="btn btn-quiet" onClick={() => onRemove(pair)} aria-label={`Paar ${manName} und ${womanName} entfernen`} data-testid={`button-remove-pair-${pair.id}`}><Trash2 size={14}/></button></div></td></tr>;
        })}</tbody></table></div>}
    </div>
     <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, color: '#8a7579', fontSize: 11 }}><CircleHelp size={14}/>Doppelte Namen werden erkannt. Änderungen an angemeldeten Paaren setzen den Spielplan nach Bestätigung zurück.</div>
  </>;
}
function Players({ tournament }: { tournament: Tournament }) {
  const schleiferl = schleiferlFor(tournament);
  const men = tournament.players.filter((player) => player.category === 'men').sort((a, b) =>
    (schleiferl.get(b.id) ?? 0) - (schleiferl.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'de'),
  );
  const women = tournament.players.filter((player) => player.category === 'women').sort((a, b) =>
    (schleiferl.get(b.id) ?? 0) - (schleiferl.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'de'),
  );
  return <>
    <PageHeading eyebrow="Einzelwertung" title="Spielerwertung" subtitle="Alle Spieler nach Herren- und Damenfeld getrennt. Für jeden Sieg in Gruppen- oder KO-Spielen erhält jede Person im Siegerteam ein Schleiferl."/>
    {tournament.players.length === 0 ? <div className="panel"><div className="empty-state"><div className="empty-icon"><Users size={20}/></div><h3>Noch keine Spieler eingetragen</h3><p>Melde zuerst feste Mixed-Paare an. Danach erscheinen alle Spieler hier, auch mit null Schleiferln.</p><Link href="/participants" className="btn btn-primary" data-testid="link-add-players"><Plus size={14}/>Mixed-Paare anmelden</Link></div></div> :
      <div className="group-grid">
        <PlayerCategoryTable title="Herrenfeld" players={men} schleiferl={schleiferl}/>
        <PlayerCategoryTable title="Damenfeld" players={women} schleiferl={schleiferl}/>
      </div>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, color: '#819087', fontSize: 11 }}><CircleHelp size={14}/>Die Schleiferl-Anzahl entspricht den gewonnenen Begegnungen. Freilose bringen kein Schleiferl.</div>
  </>;
}
function PlayerCategoryTable({ title, players, schleiferl }: { title: string; players: Player[]; schleiferl: Map<string, number> }) {
  return <section className="panel group-card" data-testid={`card-players-${title === 'Herrenfeld' ? 'men' : 'women'}`}>
    <div className="group-band"><h3>{title}</h3><span>{players.length} Teilnehmende</span></div>
    {players.length === 0 ? <div className="empty-state" style={{ padding: 24 }}><p>Noch keine Spieler in diesem Feld.</p></div> :
      <div className="table-wrap"><table className="data-table"><thead><tr><th>#</th><th>Name</th><th>Verein</th><th>Schleiferl (Siege)</th></tr></thead><tbody>
        {players.map((player, index) => <tr key={player.id} data-testid={`player-standing-${player.id}`}><td className="rank">{index + 1}</td><td className="strong">{player.name}</td><td>{player.club || '—'}</td><td className="strong">{schleiferl.get(player.id) ?? 0}</td></tr>)}
      </tbody></table></div>}
  </section>;
}
function Monitor({ tournament }: { tournament: Tournament }) {
  const [clock, setClock] = useState(() => new Date());
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);
  const activeStage = tournament.phase === 'knockout' || tournament.phase === 'finished' ? 'knockout' : 'group';
  const stageMatches = tournament.matches.filter((match) => match.stage === activeStage && !match.isBye);
  const currentRound = currentRoundNumber(tournament, activeStage);
  const currentRoundMatches = stageMatches
    .filter((match) => match.round === currentRound)
    .sort((a, b) => (a.tableNumber ?? Number.MAX_SAFE_INTEGER) - (b.tableNumber ?? Number.MAX_SAFE_INTEGER));
  const schleiferl = schleiferlFor(tournament);
  const men = tournament.players.filter((player) => player.category === 'men').sort((a, b) =>
    (schleiferl.get(b.id) ?? 0) - (schleiferl.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'de'),
  );
  const women = tournament.players.filter((player) => player.category === 'women').sort((a, b) =>
    (schleiferl.get(b.id) ?? 0) - (schleiferl.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'de'),
  );
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }
  return <div className="monitor-shell">
    <header className="monitor-header">
      <div className="monitor-brand"><div className="monitor-brand-logo"><img src={`${import.meta.env.BASE_URL}djk-hafner-logo.png`} alt="DJK Hafner Straubing"/></div><div><div className="monitor-brand-name">{tournament.name || 'Tischtennis-Turnier'}</div><div className="monitor-brand-caption">Turniermonitor{tournament.date ? ` · ${dateLabel(tournament.date)}` : ''}</div></div></div>
      <div className="monitor-header-right"><div className="monitor-live-indicator"><span className="live-dot"/><span>LIVE</span><time>{clock.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time></div><button className="btn btn-primary" onClick={toggleFullscreen} data-testid="button-monitor-fullscreen"><Maximize2 size={15}/>{isFullscreen ? 'Vollbild schließen' : 'Vollbild'}</button><Link href="/" className="btn btn-secondary" data-testid="link-monitor-back">Turnierverwaltung</Link></div>
    </header>
    <main className="monitor-grid">
      <section className="monitor-games">
        <div className="monitor-section-head"><div><span className="monitor-eyebrow">Spielbetrieb</span><h1>Aktuelle Runde</h1></div><span className="monitor-count">{currentRound ? `Runde ${currentRound} · ${currentRoundMatches.length} Spiele` : 'Kein Spielplan'}</span></div>
        {currentRoundMatches.length ? <div className="monitor-match-grid">{currentRoundMatches.map((match) => <MonitorMatchCard key={match.id} match={match} tournament={tournament}/>)}</div> :
          <div className="monitor-empty"><span className="monitor-empty-icon"><MonitorIcon size={24}/></span><strong>{tournament.phase === 'finished' ? 'Turnier beendet' : 'Noch keine Runde vorhanden'}</strong><span>{tournament.phase === 'finished' ? 'Die letzte Runde mit Ergebnissen wird angezeigt, sobald Begegnungen vorliegen.' : 'Sobald ein Spielplan erstellt ist, erscheint hier nur die aktuelle Runde.'}</span></div>}
      </section>
      <aside className="monitor-standings">
        <div className="monitor-section-head"><div><span className="monitor-eyebrow">Einzelwertung</span><h2>Schleiferl</h2></div><span className="monitor-total">{tournament.players.length} Spieler</span></div>
        <div className="monitor-rankings">
          <MonitorRanking title="Herrenfeld" players={men} schleiferl={schleiferl}/>
          <MonitorRanking title="Damenfeld" players={women} schleiferl={schleiferl}/>
        </div>
        <div className="monitor-footnote">Ein Sieg pro Person = ein Schleiferl · Freilose zählen nicht</div>
      </aside>
    </main>
    <footer className="monitor-footer"><span>Plattenplan · Mixed-Doppel</span><span>Synchronisiert automatisch in Tabs desselben Browsers</span></footer>
  </div>;
}
function MonitorMatchCard({ match, tournament }: { match: Match; tournament: Tournament }) {
  const side1Sets = match.sets.filter((set) => set.p1 > set.p2).length;
  const side2Sets = match.sets.filter((set) => set.p2 > set.p1).length;
  const statusLabel = match.status === 'completed' ? 'BEENDET' : match.status === 'in_progress' ? 'LÄUFT' : 'OFFEN';
  return <article className={`monitor-match-card ${match.status === 'in_progress' ? 'monitor-match-card-active' : ''}`} data-testid={`monitor-round-match-${match.id}`}>
    <div className="monitor-match-top"><span>TISCH {match.tableNumber ?? '–'} · {match.stage === 'knockout' ? 'KO' : `RUNDE ${match.round}`}</span><span className={`monitor-match-status monitor-match-status-${match.status}`}>{match.status === 'in_progress' && <span className="live-dot"/>}{statusLabel}</span></div>
    <div className={`monitor-match-team ${match.winnerSide === 1 ? 'monitor-match-winner' : ''}`}>{teamLabel(tournament, match.side1)}</div>
    <div className="monitor-match-vs">GEGEN</div>
    <div className={`monitor-match-team ${match.winnerSide === 2 ? 'monitor-match-winner' : ''}`}>{teamLabel(tournament, match.side2)}</div>
    {match.status === 'completed' && <div className="monitor-result"><strong>Ergebnis: {side1Sets}:{side2Sets} Sätze</strong><span>{match.sets.map((set) => `${set.p1}:${set.p2}`).join(' · ')}</span></div>}
  </article>;
}
function MonitorRanking({ title, players, schleiferl }: { title: string; players: Player[]; schleiferl: Map<string, number> }) {
  return <section className="monitor-ranking" data-testid={`monitor-ranking-${title === 'Herrenfeld' ? 'men' : 'women'}`}>
    <div className="monitor-ranking-head"><h3>{title}</h3><span>{players.length}</span></div>
    {players.length ? players.map((player, index) => <div className="monitor-player-row" key={player.id} data-testid={`monitor-player-${player.id}`}><span className="monitor-player-rank">{String(index + 1).padStart(2, '0')}</span><span className="monitor-player-name">{player.name}</span><strong className="monitor-player-score">{schleiferl.get(player.id) ?? 0}</strong></div>) : <div className="monitor-ranking-empty">Noch keine Teilnehmenden</div>}
  </section>;
}
function Groups({ tournament, tab, setTab, onScore, onStartMatch, onGenerate, onKnockout }: { tournament: Tournament; tab: 'fixtures' | 'standings'; setTab: (tab: 'fixtures' | 'standings') => void; onScore: (match: Match) => void; onStartMatch: (match: Match) => void; onGenerate: () => void; onKnockout: () => void }) {
  const groupMatches = tournament.matches.filter((match) => match.stage === 'group');
  const playedMatches = groupMatches.filter((match) => !match.isBye);
  const allDone = groupMatches.length > 0 && groupMatches.every((match) => match.status === 'completed');
  const qualifiedTeams = qualifiedMixedTeams(tournament);
  return <>
    <PageHeading eyebrow="Vorrunde" title="Gruppenphase" subtitle="Alle spielen in einer Gesamtgruppe. In Runde 1 bleiben die gemeldeten Paare zusammen; ab Runde 2 werden Partner- und Gegnerwiederholungen soweit möglich vermieden. Jeder Sieg gibt ein Schleiferl." action={tournament.groups.length ? <button className="btn btn-secondary" onClick={onGenerate} data-testid="button-regenerate-groups"><Shuffle size={14}/>{tournament.groups.length > 1 ? 'Gesamtspielplan erstellen' : 'Spielplan neu erstellen'}</button> : null}/>
    {tournament.groups.length > 1 && <div className="panel" role="alert" style={{ marginBottom: 16 }}><div className="panel-body" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}><div><div className="panel-title">Gespeicherter Spielplan hat mehrere Gruppen</div><div className="panel-note">Erstelle einen Spielplan für die Gesamtgruppe. Vorhandene Ergebnisse bleiben bis zur Bestätigung erhalten.</div></div><button className="btn btn-primary" onClick={onGenerate} data-testid="button-create-single-group"><Shuffle size={14}/>Gesamtspielplan erstellen</button></div></div>}
    {tournament.groups.length === 0 ? <div className="panel"><div className="empty-state"><div className="empty-icon"><Table2 size={20}/></div><h3>Der Spielplan wartet</h3><p>Melde mindestens zwei Mixed-Paare an. Alle spielen in einer gemeinsamen Gruppe.</p><button className="btn btn-primary" onClick={onGenerate} data-testid="button-generate-groups"><Shuffle size={14}/>Spielplan erstellen</button></div></div> :
      <>
         <div className="panel" style={{ marginBottom: 16 }}><div className="panel-body" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}><div><div className="panel-title">{tournament.groups.length === 1 ? 'Gesamtgruppe' : `${tournament.groups.length} Gruppen (alte Einteilung)`} · {playedMatches.length} Spiele in {tournament.groupRounds} Runden</div><div className="panel-note">Ein Sieg bringt ein Schleiferl pro Person; Sätze und Ballpunkte helfen nur bei Gleichstand. Die besten Spieler je Feld bilden die Finalpaare.</div></div><div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}><span className="pill pill-info">{tournament.qualifiersPerGroup} Spieler je Feld für KO-Runde</span>{allDone && tournament.groups.length === 1 && !tournament.qualifiedIds.length && <button className="btn btn-primary" onClick={onKnockout} data-testid="button-generate-knockout"><Trophy size={14}/>KO-Runde erstellen</button>}</div></div></div>
        <div className="tabs"><button className={`tab ${tab === 'fixtures' ? 'active' : ''}`} onClick={() => setTab('fixtures')} data-testid="tab-fixtures">Begegnungen</button><button className={`tab ${tab === 'standings' ? 'active' : ''}`} onClick={() => setTab('standings')} data-testid="tab-standings">Tabellen</button></div>
        {tab === 'standings' ? <div className="group-grid">{tournament.groups.map((group) => {
          const standings = standingsFor(tournament, group.id);
          const qualifyingMen = standings.filter((standing) => standing.player.category === 'men').slice(0, tournament.qualifiersPerGroup);
          const qualifyingWomen = standings.filter((standing) => standing.player.category === 'women').slice(0, tournament.qualifiersPerGroup);
          const qualifyingIds = new Set([...qualifyingMen, ...qualifyingWomen].map((standing) => standing.player.id));
           return <div className="panel group-card" key={group.id} data-testid={`card-standings-${group.id}`}><div className="group-band"><h3>{group.name}</h3><span>{standings.length} Spielerinnen und Spieler</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>#</th><th>Name</th><th>Feld</th><th>Schleiferl</th><th>Niederlagen</th><th>Sätze</th><th>Ballpunkte</th></tr></thead><tbody>{standings.map((standing, index) => <tr key={standing.player.id} data-testid={`standing-${standing.player.id}`}><td className="rank">{index + 1}</td><td className="strong">{standing.player.name}{qualifyingIds.has(standing.player.id) && <span style={{ color: '#990000', marginLeft: 5 }} title="Qualifiziert">↑</span>}</td><td>{standing.player.category === 'men' ? 'Herrenfeld' : 'Damenfeld'}</td><td>{standing.wins}</td><td>{standing.losses}</td><td>{standing.setsFor}:{standing.setsAgainst}</td><td>{standing.pointsFor}:{standing.pointsAgainst}</td></tr>)}</tbody></table></div></div>;
        })}</div> :
          <div className="group-grid">{tournament.groups.map((group) => <GroupFixtures key={group.id} group={group} tournament={tournament} onScore={onScore} onStartMatch={onStartMatch}/>)}</div>}
      </>}
  </>;
}
function GroupFixtures({ group, tournament, onScore, onStartMatch }: { group: Group; tournament: Tournament; onScore: (match: Match) => void; onStartMatch: (match: Match) => void }) {
  const matches = tournament.matches.filter((match) => match.stage === 'group' && match.groupId === group.id);
  const games = matches.filter((match) => !match.isBye);
  const byes = matches.filter((match) => match.isBye).length;
  const rounds = [...new Set(matches.map((match) => match.round))].sort((a, b) => a - b);
  return <section className="panel"><div className="group-band"><h3>{group.name}</h3><span>{games.filter((match) => match.status === 'completed').length} / {games.length} Spiele{byes ? ` · ${byes} Freilos${byes === 1 ? '' : 'e'}` : ''}</span></div><div className="panel-body" style={{ padding: '7px 14px' }}>
    {matches.length === 0 ? <div className="empty-state" style={{ padding: 24 }}><p>In dieser Gruppe sind noch keine Begegnungen.</p></div> : rounds.map((round) => <div key={round} style={{ marginBottom: 14 }}><div className="round-title" style={{ margin: '10px 0 5px' }}>Runde {round}{round === 1 ? ' · gemeldete Paare' : ' · neu gemischte Paare'}</div><div className="match-list">{matches.filter((match) => match.round === round).map((match) => <MatchRow key={match.id} match={match} tournament={tournament} onScore={onScore} onStartMatch={onStartMatch}/>)}</div></div>)}
  </div></section>;
}
function MatchRow({ match, tournament, onScore, onStartMatch }: { match: Match; tournament: Tournament; onScore: (match: Match) => void; onStartMatch: (match: Match) => void }) {
  return <div className={`match-row ${match.status === 'in_progress' ? 'match-row-active' : ''}`} data-testid={`match-${match.id}`}>
    <div><div className="match-players">{teamLabel(tournament, match.side1)}<span className="vs">gegen</span>{teamLabel(tournament, match.side2)}</div><div className="match-meta">{match.groupId ? tournament.groups.find((group) => group.id === match.groupId)?.name : 'KO-Runde'} · Runde {match.round} · Tisch {match.tableNumber || '–'}</div></div>
    <div>{match.isBye ? <span className="pill pill-info">Freilos</span> : match.status === 'completed' ? <div className="match-score">{match.sets.map((set) => `${set.p1}:${set.p2}`).join('  ')}</div> : match.status === 'in_progress' ? <span className="pill pill-live"><span className="live-dot"/>Läuft</span> : <span className="pill pill-pending"><Clock3 size={11}/>Offen</span>}</div>
    {!match.isBye && <div className="match-actions">
      {match.status === 'pending' && <button className="btn btn-secondary" onClick={() => onStartMatch(match)} data-testid={`button-start-${match.id}`}><Play size={13}/>Start</button>}
      <button type="button" className={`btn ${match.status === 'completed' ? 'btn-secondary' : 'btn-primary'}`} onClick={() => onScore(match)} data-testid={`button-score-${match.id}`}><Pencil size={13}/>{match.status === 'completed' ? 'Ergebnis bearbeiten' : 'Ergebnis eintragen'}</button>
    </div>}
  </div>;
}
function Knockout({ tournament, progress, onScore, onStartMatch, onStart, onContinue }: { tournament: Tournament; progress: ReturnType<typeof bracketProgress>; onScore: (match: Match) => void; onStartMatch: (match: Match) => void; onStart: () => void; onContinue: (playThirdPlace: boolean) => void }) {
  const winner = progress.championIds ? teamLabel(tournament, progress.championIds) : null;
  const rounds = progress.rounds;
  const roundNames = (round: number, total: number) => round === total ? 'Finale' : round === total - 1 ? 'Halbfinale' : round === total - 2 ? 'Viertelfinale' : `Runde ${round}`;
  const qualifiedPairCount = Math.floor(tournament.qualifiedIds.length / 2);
  const totalRounds = Math.ceil(Math.log2(Math.max(2, qualifiedPairCount)));
  const latestRound = rounds.at(-1);
  const semifinalMatches = latestRound?.matches.filter((match) => !match.isBye && !match.isThirdPlace) ?? [];
  const showThirdPlaceChoice = Boolean(
    latestRound
    && latestRound.matches.length === 2
    && latestRound.matches.every((match) => match.status === 'completed')
    && semifinalMatches.length === 2
    && semifinalMatches.every((match) => match.winnerSide !== null)
    && !tournament.matches.some((match) => match.isThirdPlace),
  );
  const thirdPlaceMatch = tournament.matches.find((match) => match.isThirdPlace);
  return <>
    <PageHeading eyebrow="Finalrunde" title="KO-Runde" subtitle="Qualifizierte bilden Mixed-Paare; nach jeder Runde werden die Partner neu gemischt."/>
    {winner && <div className="champion-card" data-testid="champion-card"><div className="champion-cup"><Crown size={22}/></div><div><span>Siegerpaar</span><strong>{winner}</strong></div></div>}
    {!tournament.qualifiedIds?.length ? <div className="panel"><div className="empty-state"><div className="empty-icon"><Trophy size={20}/></div><h3>Noch keine Finalrunde</h3><p>Schließe zunächst alle Gruppenspiele ab. Qualifizierte werden anhand der aktuellen Gruppentabellen ermittelt.</p>{tournament.groups.length && tournament.matches.filter((m) => m.groupId).every((m) => m.status === 'completed') ? <button className="btn btn-primary" onClick={onStart} data-testid="button-create-bracket"><Trophy size={14}/>KO-Runde erstellen</button> : <Link href="/groups" className="btn btn-secondary" data-testid="link-to-group-results">Zu den Gruppenspielen <ChevronRight size={14}/></Link>}</div></div> :
      <>
        {showThirdPlaceChoice && <section className="panel" style={{ marginBottom: 16 }} data-testid="third-place-choice"><div className="panel-head"><div><div className="panel-title">Spiel um Platz 3</div><div className="panel-note">Die Verlierer der Halbfinals werden neu gemischt. Möchtest du das Platzierungsspiel austragen?</div></div><Trophy size={17} color="#990000"/></div><div className="panel-body" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button className="btn btn-primary" onClick={() => onContinue(true)} data-testid="button-play-third-place">Ja, Spiel um Platz 3</button><button className="btn btn-secondary" onClick={() => onContinue(false)} data-testid="button-skip-third-place">Nein, direkt zum Finale</button></div></section>}
        <div className="panel"><div className="panel-head"><div><div className="panel-title">KO-Baum</div><div className="panel-note">{qualifiedPairCount} Mixed-Paare · nach jedem Sieg werden die Partner neu zugelost</div></div><span className="pill pill-info"><Trophy size={12}/>KO</span></div><div className="panel-body">
          <div className="bracket">{rounds.map((round) => <div className="bracket-round" key={round.round}><div className="round-title">{roundNames(round.round, totalRounds)}</div>{round.matches.filter((match) => !match.isThirdPlace).map((match) => <BracketMatch key={match.id} match={match} tournament={tournament} onScore={onScore} onStartMatch={onStartMatch}/>)}</div>)}</div>
        </div></div>
        {thirdPlaceMatch && <section className="panel" style={{ marginTop: 16 }} data-testid="third-place-match"><div className="panel-head"><div><div className="panel-title">Spiel um Platz 3</div><div className="panel-note">Platzierungsspiel zwischen den Halbfinalverlierern</div></div><span className="pill pill-info">Platz 3</span></div><div className="panel-body"><BracketMatch match={thirdPlaceMatch} tournament={tournament} onScore={onScore} onStartMatch={onStartMatch}/></div></section>}
      </>}
  </>;
}
function BracketMatch({ match, tournament, onScore, onStartMatch }: { match: Match; tournament: Tournament; onScore: (match: Match) => void; onStartMatch: (match: Match) => void }) {
  const winnerSide = match.winnerSide;
  return <div className="bracket-match" data-testid={`bracket-match-${match.id}`}><div className={`bracket-player ${winnerSide === 1 ? 'winner' : ''}`}>{teamLabel(tournament, match.side1)}{winnerSide === 1 && <Check size={12}/>}</div>{match.side2 ? <div className={`bracket-player ${winnerSide === 2 ? 'winner' : ''}`}>{teamLabel(tournament, match.side2)}{winnerSide === 2 && <Check size={12}/>}</div> : <div className="bracket-player" style={{ color: '#a2aaa2' }}>Freilos</div>}{match.isBye ? <div className="match-score" style={{ padding: '7px 10px' }}>Automatisch weiter</div> : match.status === 'completed' ? <div className="match-score" style={{ padding: '7px 10px' }}>{match.sets.map((set) => `${set.p1}:${set.p2}`).join(' ')}</div> : <div className="bracket-actions">{match.status === 'pending' && <button className="btn btn-secondary" onClick={() => onStartMatch(match)} data-testid={`button-bracket-start-${match.id}`}><Play size={13}/>Start</button>}<button className="btn btn-primary" onClick={() => onScore(match)} data-testid={`button-bracket-score-${match.id}`}>Ergebnis eintragen</button></div>}</div>;
}
function Settings({ tournament, onSave, onImport, onReset }: { tournament: Tournament; onSave: (patch: Partial<Tournament>) => void; onImport: (tournament: Tournament) => void; onReset: () => void }) {
  const [form, setForm] = useState({ name: tournament.name, date: tournament.date, tableCount: String(tournament.tableCount), groupRounds: String(tournament.groupRounds), qualifiersPerGroup: String(tournament.qualifiersPerGroup) });
  const backupInput = useRef<HTMLInputElement>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<{ status: 'checking' | 'available' | 'current' | 'unavailable' | 'unsupported'; currentVersion?: string; latestVersion?: string; downloadUrl?: string }>({ status: 'unsupported' });
  const [updateFeedback, setUpdateFeedback] = useState('');
  const [portableUpdateFeedback, setPortableUpdateFeedback] = useState('');
  const [portableUpdateBusy, setPortableUpdateBusy] = useState(false);
  const [recoveryCopies, setRecoveryCopies] = useState(() => loadTournamentRecoveryCopies(localStorage));
  const [backupPreview, setBackupPreview] = useState<{ raw: string; fileName: string; tournament: Tournament; exportedAt: string | null; source: 'file' | 'recovery' } | null>(null);
  const groupPhaseClosed = tournament.phase === 'knockout' || tournament.phase === 'finished';
  useEffect(() => setForm({ name: tournament.name, date: tournament.date, tableCount: String(tournament.tableCount), groupRounds: String(tournament.groupRounds), qualifiersPerGroup: String(tournament.qualifiersPerGroup) }), [tournament.name, tournament.date, tournament.tableCount, tournament.groupRounds, tournament.qualifiersPerGroup, tournament.phase]);
  async function checkForDesktopUpdate() {
    const desktop = window.ttTurnierDesktop;
    if (!desktop || !releaseNotesUrl) return;
    setDesktopUpdate({ status: 'checking' });
    setUpdateFeedback('');
    try {
      setDesktopUpdate(await desktop.checkForUpdate(releaseNotesUrl));
    } catch {
      setDesktopUpdate({ status: 'unavailable' });
    }
  }
  useEffect(() => {
    let isMounted = true;
    if (window.ttTurnierDesktop && releaseNotesUrl) {
      setDesktopUpdate({ status: 'checking' });
      void window.ttTurnierDesktop.checkForUpdate(releaseNotesUrl)
        .then((result) => { if (isMounted) setDesktopUpdate(result); })
        .catch(() => { if (isMounted) setDesktopUpdate({ status: 'unavailable' }); });
    }
    return () => { isMounted = false; };
  }, []);
  async function openUpdateLink(url: string) {
    const desktop = window.ttTurnierDesktop;
    if (!desktop) return;
    setUpdateFeedback('');
    try {
      const result = await desktop.openExternal(url);
      if (!result.success) setUpdateFeedback(result.message || 'Der Link konnte nicht im Browser geöffnet werden.');
    } catch {
      setUpdateFeedback('Der Link konnte nicht im Browser geöffnet werden. Prüfe die Standardbrowser-Einstellungen.');
    }
  }
  async function startPortableUpdate() {
    const desktop = window.ttTurnierDesktop;
    if (!desktop) return;
    setPortableUpdateBusy(true);
    setPortableUpdateFeedback('');
    try {
      const result = await desktop.installPortableUpdate();
      if (result.status === 'started') {
        setPortableUpdateFeedback(`Version ${result.version} wurde aus einem neuen Ordner gestartet. Die bisherige App und deine Turnierdaten bleiben erhalten.`);
      } else if (result.status === 'launch-failed') {
        setPortableUpdateFeedback(`Version ${result.version} wurde geprüft und abgelegt, konnte aber nicht gestartet werden. Die bisherige App bleibt verfügbar. Ordner: ${result.folder}. ${result.message || ''}`);
      } else if (result.status === 'failed') {
        setPortableUpdateFeedback(result.message || 'Die ZIP-Aktualisierung ist fehlgeschlagen. Die bisherige App bleibt unverändert.');
      }
    } catch {
      setPortableUpdateFeedback('Die ZIP-Aktualisierung ist fehlgeschlagen. Die bisherige App bleibt unverändert.');
    } finally {
      setPortableUpdateBusy(false);
    }
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim()) { window.alert('Bitte gib dem Turnier einen Namen.'); return; }
    const tableCount = Math.max(1, Number(form.tableCount) || 1);
    const groupRounds = Math.max(2, Math.min(12, Number(form.groupRounds) || 2));
    const qualifiersPerGroup = Math.max(1, Number(form.qualifiersPerGroup) || 1);
    const hasSchedule = tournament.matches.length > 0;
    const patch = { name: form.name.trim(), date: form.date, tableCount, groupRounds, qualifiersPerGroup };
    let adjustedRounds = groupRounds;
    let matches = tournament.matches;
    const messages: string[] = [];
    if (hasSchedule && groupRounds !== tournament.groupRounds && groupPhaseClosed) {
      adjustedRounds = tournament.groupRounds;
      messages.push('Die Gruppenphase ist beendet; ihre Rundenzahl bleibt unverändert.');
    } else if (hasSchedule && groupRounds !== tournament.groupRounds) {
      const resized = resizeGroupSchedule({ ...tournament, tableCount }, groupRounds, uid);
      adjustedRounds = resized.groupRounds;
      matches = resized.matches;
      messages.push(resized.protectedRound
        ? `Runde ${resized.protectedRound} enthält bereits begonnene Spiele; die Rundenzahl bleibt bei ${resized.groupRounds}.`
        : `Gruppenphase auf ${resized.groupRounds} Runden angepasst.`);
    }
    if (hasSchedule && tableCount !== tournament.tableCount) {
      if (groupPhaseClosed) {
        messages.push('Neue Tischzahl gespeichert; vorhandene Spiele und Ergebnisse bleiben erhalten.');
      } else {
        matches = reassignPendingGroupTables(matches, tableCount);
        messages.push('Ausstehende Gruppenspiele wurden auf die neue Tischzahl verteilt.');
      }
    }
    if (hasSchedule && qualifiersPerGroup !== tournament.qualifiersPerGroup) {
      messages.push('Qualifikationsmarkierungen angepasst; bestehende KO-Spiele bleiben unverändert.');
    }
    onSave({ ...patch, groupRounds: adjustedRounds, matches });
    const toastMessage = messages.length ? messages.join(' ') : 'Turniereinstellungen gespeichert.';
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('tt-toast', { detail: toastMessage })), 0);
  }
  function exportBackup() {
    const backup = createTournamentBackup(tournament);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `turnier-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function importBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = parseTournamentBackup(raw);
      if (!parsed.success) { window.alert(parsed.message); return; }
      setBackupPreview({ raw, fileName: file.name, tournament: parsed.tournament, exportedAt: backupExportedAt(raw), source: 'file' });
    } catch {
      window.alert('Die Datei konnte nicht gelesen werden. Bitte wähle eine gültige JSON-Sicherung.');
    }
  }
  function previewRecoveryCopy(copy: (typeof recoveryCopies)[number]) {
    const parsed = parseTournamentBackup(copy.raw);
    if (!parsed.success) {
      setRecoveryCopies(loadTournamentRecoveryCopies(localStorage));
      window.alert('Diese Wiederherstellungskopie ist ungültig und kann nicht geladen werden.');
      return;
    }
    setBackupPreview({
      raw: copy.raw,
      fileName: `Wiederherstellungskopie vom ${dateTimeLabel(copy.savedAt)}`,
      tournament: parsed.tournament,
      exportedAt: copy.savedAt,
      source: 'recovery',
    });
  }
  function downloadRecoveryCopy(copy: (typeof recoveryCopies)[number]) {
    const download = recoveryCopyDownload(copy);
    if (!download) {
      setRecoveryCopies(loadTournamentRecoveryCopies(localStorage));
      window.alert('Diese Wiederherstellungskopie ist ungültig und kann nicht heruntergeladen werden.');
      return;
    }
    const url = URL.createObjectURL(new Blob([download.raw], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = download.fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
  function confirmBackupImport() {
    if (!backupPreview) return;
    const result = importTournamentBackup(
      backupPreview.raw,
      tournament,
      onImport,
      (message) => window.confirm(message),
      (currentTournament) => {
        const recovery = saveTournamentRecoveryCopy(currentTournament, localStorage);
        if (!recovery.success) throw new Error(recovery.message);
        setRecoveryCopies(loadTournamentRecoveryCopies(localStorage));
      },
    );
    if (!result.success) {
      setBackupPreview(null);
      window.alert(result.message);
      return;
    }
    if (!result.imported) return;
    setBackupPreview(null);
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('tt-toast', { detail: 'Turniersicherung wurde geladen.' })), 0);
  }
  return <>
    <PageHeading eyebrow="Organisation" title="Turnier einstellen" subtitle="Rahmenbedingungen pflegen. Dein Turnier bleibt auf diesem Gerät gespeichert."/>
    <div className="overview-grid" style={{ alignItems: 'start' }}>
       <section className="panel"><div className="panel-head"><div><div className="panel-title">Turnierdaten</div><div className="panel-note">Name, Ort und Spieltag</div></div><FileCog size={17} color="#990000"/></div><div className="panel-body">
        <form onSubmit={submit}><div className="form-grid">
          <div className="field full"><label htmlFor="tournament-name">Turniername</label><input id="tournament-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Zum Beispiel Frühjahrs-Cup 2025" data-testid="input-tournament-name"/></div>
          <div className="field"><label htmlFor="tournament-date">Datum</label><input id="tournament-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} data-testid="input-tournament-date"/></div>
          <div className="field"><label htmlFor="table-count">Verfügbare Tische</label><input id="table-count" type="number" min="1" max="100" value={form.tableCount} onChange={(e) => setForm({ ...form, tableCount: e.target.value })} data-testid="input-table-count"/><span className="field-hint">Ausstehende Gruppenspiele werden neu verteilt; Ergebnisse bleiben erhalten.</span></div>
          <div className="field"><label htmlFor="group-rounds">Runden in der Gruppenphase</label><input id="group-rounds" type="number" min="2" max="12" value={form.groupRounds} onChange={(e) => setForm({ ...form, groupRounds: e.target.value })} disabled={groupPhaseClosed} data-testid="input-group-rounds"/><span className="field-hint">{groupPhaseClosed ? 'Die Gruppenphase ist beendet; die Rundenzahl kann nicht mehr angepasst werden.' : 'Runde 1 nutzt die gemeldeten Paare, danach wird neu gemischt. Begonnene Runden bleiben erhalten.'}</span></div>
          <div className="field"><label htmlFor="qualifiers-count">Spieler je Feld für KO-Runde</label><input id="qualifiers-count" type="number" min="1" max="32" value={form.qualifiersPerGroup} onChange={(e) => setForm({ ...form, qualifiersPerGroup: e.target.value })} data-testid="input-qualifiers-count"/><span className="field-hint">Passt die Qualifikationsmarkierungen an; bestehende KO-Spiele bleiben unverändert.</span></div>
        </div><div className="form-actions"><button type="submit" className="btn btn-primary" data-testid="button-save-settings"><Check size={14}/>Änderungen speichern</button></div></form>
      </div></section>
      <div style={{ display: 'grid', gap: 14 }}>
         {releaseNotesUrl && <section className="panel"><div className="panel-head"><div><div className="panel-title">Aktuelle Version</div><div className="panel-note">Änderungen und verfügbare Windows-Versionen ansehen</div></div><ExternalLink size={17} color="#990000"/></div><div className="panel-body">
           {desktopUpdate.status !== 'unsupported' && <p role="status" aria-live="polite" data-testid="status-desktop-update" style={{ fontSize: 12, lineHeight: 1.5, color: desktopUpdate.status === 'available' ? '#805500' : '#646b72', margin: '0 0 12px' }}>
             {desktopUpdate.status === 'checking' && 'Suche nach einer neuen Windows-Version …'}
             {desktopUpdate.status === 'available' && `Eine neuere Windows-Version (${desktopUpdate.latestVersion}) ist verfügbar. Installiert ist Version ${desktopUpdate.currentVersion}.`}
             {desktopUpdate.status === 'current' && `Du nutzt die aktuelle Windows-Version (${desktopUpdate.currentVersion}).`}
             {desktopUpdate.status === 'unavailable' && 'Die Verfügbarkeit einer neuen Windows-Version konnte gerade nicht geprüft werden.'}
           </p>}
           {window.ttTurnierDesktop?.isWindows && <div className="form-actions" style={{ margin: '0 0 10px' }}>
             <button type="button" className="btn btn-secondary" onClick={() => void checkForDesktopUpdate()} disabled={desktopUpdate.status === 'checking'} data-testid="button-check-desktop-update">
               {desktopUpdate.status === 'checking' ? 'Wird geprüft …' : 'Erneut nach Updates suchen'}
             </button>
             {desktopUpdate.status === 'available' && desktopUpdate.downloadUrl && <a
               className="btn btn-primary"
               href={desktopUpdate.downloadUrl}
               target="_blank"
               rel="noreferrer"
               onClick={(event) => {
                 if (window.ttTurnierDesktop) {
                   event.preventDefault();
                   void openUpdateLink(desktopUpdate.downloadUrl!);
                 }
               }}
               data-testid="link-windows-installer"
             >Installer für Version {desktopUpdate.latestVersion} herunterladen <ExternalLink size={14}/></a>}
           </div>}
           <a className="btn btn-secondary" href={releaseNotesUrl} target="_blank" rel="noreferrer" onClick={(event) => {
             if (window.ttTurnierDesktop) {
               event.preventDefault();
               void openUpdateLink(releaseNotesUrl);
             }
           }} data-testid="link-release-notes">Versionshinweise öffnen <ExternalLink size={14}/></a>
           {updateFeedback && <p role="status" aria-live="polite" data-testid="status-update-feedback" style={{ fontSize: 12, lineHeight: 1.5, color: '#805500', margin: '12px 0 0' }}>{updateFeedback}</p>}
         </div></section>}
        {window.ttTurnierDesktop?.isWindows && <section className="panel" data-testid="panel-portable-update">
          <div className="panel-head"><div><div className="panel-title">Portable ZIP-Version aktualisieren</div><div className="panel-note">Die neue Version wird getrennt geprüft und gestartet</div></div><ExternalLink size={17} color="#990000"/></div>
          <div className="panel-body">
            <p style={{ fontSize: 11, lineHeight: 1.6, color: '#646b72', margin: '0 0 12px' }}>Lege die Windows-ZIP und ihre gleichnamige .sha256-Datei in denselben Ordner und wähle dann die ZIP aus. Die App prüft Prüfsumme und Version und fragt danach nach einem Zielordner. Deine bisherige App bleibt als Rückweg erhalten; Turnierdaten bleiben im Windows-Benutzerprofil.</p>
            <button type="button" className="btn btn-secondary" onClick={() => void startPortableUpdate()} disabled={portableUpdateBusy} data-testid="button-portable-update">
              {portableUpdateBusy ? 'ZIP wird geprüft und vorbereitet …' : 'Windows-ZIP auswählen und starten'}
            </button>
            {portableUpdateFeedback && <p role="status" aria-live="polite" data-testid="status-portable-update" style={{ fontSize: 12, lineHeight: 1.5, color: '#805500', margin: '12px 0 0', overflowWrap: 'anywhere' }}>{portableUpdateFeedback}</p>}
          </div>
        </section>}
        <section className="panel"><div className="panel-head"><div><div className="panel-title">Ablauf &amp; Wertung</div><div className="panel-note">Mixed-Doppel mit individueller Spielerwertung</div></div><CalendarDays size={17} color="#990000"/></div><div className="panel-body"><div className="list-row"><span className="avatar"><ListChecks size={14}/></span><div><div className="row-name">Eine Gesamtgruppe</div><div className="row-meta">Keine Gruppenauslosung nötig; der Spielplan startet direkt</div></div></div><div className="list-row"><span className="avatar"><Shuffle size={14}/></span><div><div className="row-name">Schleiferl-Wertung</div><div className="row-meta">Jeder Sieg gibt ein Schleiferl pro Person; Sätze und Ballpunkte trennen Gleichstände</div></div></div><div className="list-row"><span className="avatar"><Trophy size={14}/></span><div><div className="row-name">KO-Runde</div><div className="row-meta">Die besten Spieler je Feld werden neu zu Mixed-Paaren zusammengestellt</div></div></div></div></section>
         <section className="panel"><div className="panel-head"><div><div className="panel-title">Datensicherung</div><div className="panel-note">Turnierdatei sichern oder auf diesem Gerät laden</div></div><FileCog size={17} color="#990000"/></div><div className="panel-body"><p style={{ fontSize: 11, lineHeight: 1.6, color: '#646b72', margin: '0 0 14px' }}>Zum Umzug aus dem Browser zuerst eine Sicherung herunterladen, dann im installierten Programm einspielen. Die Sicherungsdatei enthält Teilnehmer, Spielplan und Ergebnisse.</p><div className="form-actions" style={{ marginTop: 0 }}><button className="btn btn-secondary" onClick={exportBackup} data-testid="button-export-backup">Sicherung herunterladen</button><button className="btn btn-secondary" onClick={() => backupInput.current?.click()} data-testid="button-import-backup">Sicherung einspielen</button><input ref={backupInput} type="file" accept=".json,application/json" onChange={importBackup} style={{ display: 'none' }} /></div><div style={{ borderTop: '1px solid #e8ece8', marginTop: 16, paddingTop: 14 }}><div className="row-name">Wiederherstellungsverlauf</div><p style={{ fontSize: 11, lineHeight: 1.6, color: '#646b72', margin: '5px 0 12px' }}>Die letzten {MAX_RECOVERY_COPIES} bestätigten Ersetzungen bleiben auf diesem Gerät verfügbar.</p>{recoveryCopies.length ? <div style={{ display: 'grid', gap: 9 }} data-testid="recovery-history">{recoveryCopies.map((copy, index) => <div key={`${copy.savedAt}-${index}`} style={{ border: '1px solid #e8ece8', borderRadius: 8, padding: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }} data-testid={`recovery-copy-${index}`}><div><div className="row-name">{dateTimeLabel(copy.savedAt)}</div><div className="row-meta">{index === 0 ? 'Zuletzt ersetzte Version' : 'Frühere Version'}</div></div><div className="form-actions" style={{ margin: 0 }}><button type="button" className="btn btn-secondary" onClick={() => previewRecoveryCopy(copy)} data-testid={`button-preview-recovery-${index}`}>Prüfen &amp; wiederherstellen</button><button type="button" className="btn btn-secondary" onClick={() => downloadRecoveryCopy(copy)} data-testid={`button-download-recovery-${index}`}>Herunterladen</button></div></div>)}</div> : <p style={{ fontSize: 11, color: '#87938c', margin: 0 }} data-testid="empty-recovery-history">Noch keine Wiederherstellungskopie vorhanden.</p>}</div></div></section>
        <section className="panel"><div className="panel-head"><div><div className="panel-title" style={{ color: '#990000' }}>Dieses Turnier zurücksetzen</div><div className="panel-note">Andere gespeicherte Turniere bleiben erhalten</div></div><Trash2 size={16} color="#990000"/></div><div className="panel-body"><p style={{ fontSize: 11, lineHeight: 1.6, color: '#646b72', margin: '0 0 14px' }}>Teilnehmer, Gruppen, Spielplan und Ergebnisse dieses Turniers werden entfernt. Vor dem Löschen erscheint eine Bestätigung.</p><button className="btn btn-danger" onClick={onReset} data-testid="button-reset-tournament"><Trash2 size={14}/>Turnier zurücksetzen</button></div></section>
      </div>
    </div>
     {backupPreview && <Modal title="Sicherung prüfen" onClose={() => setBackupPreview(null)}>
       <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 700, color: '#405b54' }}>{backupPreview.fileName}</p>
        <p style={{ margin: '0 0 16px', fontSize: 11, color: '#87938c' }}>{backupPreview.source === 'recovery' ? 'Gespeichert am' : 'Exportiert am'} {dateTimeLabel(backupPreview.exportedAt)}. Die Daten werden erst nach Bestätigung ersetzt.</p>
       <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 16 }}>
         <div className="metric"><div className="metric-label">Turnier</div><div className="metric-value" style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{backupPreview.tournament.name || 'Ohne Namen'}</div></div>
         <div className="metric"><div className="metric-label">Datum</div><div className="metric-value" style={{ fontSize: 16 }}>{dateLabel(backupPreview.tournament.date)}</div></div>
         <div className="metric"><div className="metric-label">Spieler</div><div className="metric-value">{backupPreview.tournament.players.length}</div></div>
         <div className="metric"><div className="metric-label">Spiele</div><div className="metric-value">{backupPreview.tournament.matches.length}</div></div>
       </div>
        <section aria-label="Unterschiede zum aktiven Turnier" data-testid="backup-comparison" style={{ border: '1px solid #e8ece8', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div className="row-name" style={{ marginBottom: 8 }}>Unterschiede zum aktiven Turnier</div>
          <div style={{ display: 'grid', gap: 7 }}>
            {compareTournamentContents(tournament, backupPreview.tournament).map((difference) => <div key={difference.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11, lineHeight: 1.5 }} data-testid={`backup-difference-${difference.label.toLowerCase()}`}>
              <span>{difference.label}: {difference.currentCount} → {difference.backupCount}</span>
              <span style={{ color: '#646b72', textAlign: 'right' }}>{difference.changed || difference.added || difference.removed ? `${difference.added} neu · ${difference.removed} entfernt · ${difference.changed} geändert` : 'Keine inhaltliche Änderung'}</span>
            </div>)}
          </div>
        </section>
       <section className="backup-preview-matches" aria-label="Spiele in der Sicherung">
         <div className="backup-preview-matches-head">Spielplan</div>
         {backupPreview.tournament.matches.length === 0
           ? <p className="backup-preview-empty">Diese Sicherung enthält noch keine Spiele.</p>
           : <div className="backup-preview-match-list">
             {backupPreview.tournament.matches.map((match) => {
               const groupName = match.groupId
                 ? backupPreview.tournament.groups.find((group) => group.id === match.groupId)?.name ?? 'Gruppe'
                 : match.isThirdPlace ? 'Spiel um Platz 3' : 'KO-Runde';
               const location = `${groupName} · Runde ${match.round}${match.tableNumber ? ` · Tisch ${match.tableNumber}` : ''}`;
               const status = match.isBye
                 ? 'Freilos'
                 : match.status === 'completed' ? 'Beendet' : match.status === 'in_progress' ? 'Läuft' : 'Offen';
               return <article className="backup-preview-match" key={match.id} data-testid={`backup-preview-match-${match.id}`}>
                 <div className="backup-preview-match-heading">
                   <span className="backup-preview-match-location">{location}</span>
                   <span className={`backup-preview-match-status backup-preview-match-status-${match.status}`}>{status}</span>
                 </div>
                 <div className="backup-preview-pairing">
                   <span>{teamLabel(backupPreview.tournament, match.side1)}</span>
                   <span className="backup-preview-versus">gegen</span>
                   <span>{teamLabel(backupPreview.tournament, match.side2)}</span>
                 </div>
                 {match.status === 'completed' && !match.isBye && <div className="backup-preview-match-score">{match.sets.map((set) => `${set.p1}:${set.p2}`).join(' · ')}</div>}
                 {match.isBye && <div className="backup-preview-match-score">Automatisch weiter</div>}
               </article>;
             })}
           </div>}
       </section>
       <div className="warning-box">Beim Einspielen wird das aktuelle Turnier durch diese Sicherung ersetzt. Eine gültige aktuelle Turnierversion wird vorher als Wiederherstellungskopie gespeichert.</div>
       <div className="form-actions">
         <button type="button" className="btn btn-secondary" onClick={() => setBackupPreview(null)} data-testid="button-cancel-backup-preview">Abbrechen</button>
         <button type="button" className="btn btn-danger" onClick={confirmBackupImport} data-testid="button-confirm-backup-import">{backupPreview.source === 'recovery' ? 'Wiederherstellung laden' : 'Sicherung einspielen'}</button>
       </div>
     </Modal>}
  </>;
}

const queryClient = new QueryClient();
function Router() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/" component={AppView}/>
    <Route path="/participants" component={AppView}/>
    <Route path="/players" component={AppView}/>
    <Route path="/groups" component={AppView}/>
    <Route path="/knockout" component={AppView}/>
    <Route path="/monitor" component={AppView}/>
    <Route path="/settings" component={AppView}/>
    <Route component={NotFound}/>
  </Switch></RoutedErrorBoundary>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function App() {
  const appBase = import.meta.env.BASE_URL.startsWith('.') ? '' : import.meta.env.BASE_URL.replace(/\/$/, '');
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={appBase}><Router/></WouterRouter><Toaster/></TooltipProvider></QueryClientProvider>;
}
export default App;
