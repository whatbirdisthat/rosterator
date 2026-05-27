'use strict';

// Build-time mode injection replaces this line with `window.__SPA_MODE = 'user';`
window.__SPA_MODE = 'user';
function isAdmin() { return window.__SPA_MODE !== 'user'; }

// ── Allocator global (loaded in index.html as ES module) ──────────────────
// Read lazily at call time — the ES module may not have executed yet at load.
function _getAllocator() { return window.__allocator; }

// ── Module-level UI state (not in store — render-cycle local) ─────────────
let _balanceSort = 'most-loaded';          // US-07: Balance panel sort
const _expandedVols = new Set();           // US-03: Volunteer timeline expand/collapse
let _renderingSettings = false;            // Guard: prevents saveUserTeam() during DOM rebuild
let _mobileNavOpen = false;                // iPhone drawer state
let _mobileNavHintSeen = false;            // One-time affordance state

const MOBILE_NAV_HINT_KEY = 'roster-mobile-nav-hint-seen';

// ── Offline mode state ─────────────────────────────────────────────────────
let _unsyncedWriteCount = 0;               // Counter for unsynced PUT failures
let _idb = null;                           // Reference to idb module when available
let _idbAvailable = false;                 // Whether IndexedDB is available

// ── Store foundation ──────────────────────────────────────────────────────
const SPA_STORE = createStore();

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.getOwnPropertyNames(value).forEach(key => {
    deepFreeze(value[key]);
  });
  return value;
}

function mergeReportModel(serverSnapshot, clientOverrides) {
  if (!serverSnapshot) return null;
  const merged = deepClone(serverSnapshot);
  Object.entries(clientOverrides || {}).forEach(([key, value]) => {
    if (value !== undefined) merged[key] = deepClone(value);
  });
  return deepFreeze(merged);
}

function initialUiState() {
  return {
    activePanel: 'dashboard',
    loadedFilename: null,
    selectedRound: null,
    roundDetailOpen: false,
    teamSplitsRound: null,
  };
}

function buildStoreState(serverSnapshot, clientOverrides, ui) {
  const overrides = clientOverrides || {};
  const data = mergeReportModel(serverSnapshot, overrides);
  return {
    serverSnapshot,
    clientOverrides: overrides,
    ui: normalizeUiState(ui, data),
    data,
  };
}

function normalizeUiState(ui, data) {
  const nextUi = {
    ...initialUiState(),
    ...(ui || {}),
  };
  const rounds = data?.round_summary?.rounds || [];
  const selectedRound = nextUi.selectedRound == null
    ? null
    : String(nextUi.selectedRound);
  const hasSelectedRound = selectedRound != null
    && rounds.some(round => String(round.round) === selectedRound);
  const roundDetailOpen = nextUi.activePanel === 'rounds'
    && !!nextUi.roundDetailOpen
    && hasSelectedRound;
  return {
    ...nextUi,
    selectedRound: hasSelectedRound ? selectedRound : null,
    roundDetailOpen,
  };
}

function replaceStoreData(currentState, nextReport, ui = currentState.ui) {
  if (!nextReport) return currentState;
  return buildStoreState(deepFreeze(deepClone(nextReport)), {}, ui);
}

function updateSeasonOverviewCounts(seasonOverview, rounds) {
  if (!seasonOverview) return seasonOverview;
  const confirmedRounds = rounds.filter(round => round.status === 'confirmed').length;
  return {
    ...deepClone(seasonOverview),
    confirmed_rounds: confirmedRounds,
    scheduled_rounds: Math.max(rounds.length - confirmedRounds, 0),
  };
}

function updateMatrixRoundStatuses(matrix, rounds) {
  if (!matrix) return matrix;
  const statusByRound = Object.fromEntries(
    rounds.map(round => [String(round.round), round.status])
  );
  return {
    ...deepClone(matrix),
    rounds: (matrix.rounds || []).map(round => {
      const nextStatus = statusByRound[String(round.round)];
      if (nextStatus === undefined) return deepClone(round);
      return {
        ...deepClone(round),
        status: nextStatus,
      };
    }),
  };
}

function createStore() {
  let state = buildStoreState(null, {}, initialUiState());

  function getState() {
    return state;
  }

  function getData() {
    return state.data;
  }

  function dispatch(action) {
    state = reduceState(state, action);
    return state;
  }

  function reduceState(currentState, action) {
    switch (action.type) {
      case 'load-report': {
        const report = deepClone(action.payload.report);
        return replaceStoreData(currentState, report, {
          ...initialUiState(),
          loadedFilename: action.payload.filename,
        });
      }
      case 'apply-server-fragments': {
        if (!currentState.data) return currentState;
        const nextReport = deepClone(currentState.data);
        Object.entries(action.payload.fragments || {}).forEach(([key, value]) => {
          if (value !== undefined) nextReport[key] = deepClone(value);
        });
        return replaceStoreData(currentState, nextReport, currentState.ui);
      }
      case 'replace-server-report': {
        return replaceStoreData(currentState, action.payload.report, currentState.ui);
      }
      case 'set-active-panel':
        return buildStoreState(currentState.serverSnapshot, currentState.clientOverrides, {
          ...currentState.ui,
          activePanel: action.payload.panel,
          selectedRound: action.payload.panel === 'rounds' ? currentState.ui.selectedRound : null,
          roundDetailOpen: action.payload.panel === 'rounds' ? currentState.ui.roundDetailOpen : false,
        });
      case 'set-round-detail':
        return buildStoreState(currentState.serverSnapshot, currentState.clientOverrides, {
          ...currentState.ui,
          activePanel: 'rounds',
          selectedRound: action.payload.roundNum == null ? null : String(action.payload.roundNum),
          roundDetailOpen: !!action.payload.open,
        });
      case 'set-team-splits-round':
        return buildStoreState(currentState.serverSnapshot, currentState.clientOverrides, {
          ...currentState.ui,
          teamSplitsRound: action.payload.roundNum == null ? null : String(action.payload.roundNum),
        });
      case 'toggle-round-confirmed': {
        if (!currentState.data) return currentState;
        const roundNum = String(action.payload.roundNum);
        const rounds = ((currentState.data.round_summary && currentState.data.round_summary.rounds) || []).map(round =>
          String(round.round) === roundNum
            ? { ...deepClone(round), status: round.status === 'confirmed' ? 'scheduled' : 'confirmed' }
            : deepClone(round)
        );
        const overrides = {
          ...currentState.clientOverrides,
          round_summary: { ...deepClone(currentState.data.round_summary), rounds },
          matrix: updateMatrixRoundStatuses(currentState.data.matrix, rounds),
          season_overview: updateSeasonOverviewCounts(currentState.data.season_overview, rounds),
        };
        return buildStoreState(currentState.serverSnapshot, overrides, currentState.ui);
      }
      case 'save-round-edit': {
        if (!currentState.data) return currentState;
        const roundNum = String(action.payload.roundNum);
        const rounds = ((currentState.data.round_summary && currentState.data.round_summary.rounds) || []).map(round =>
          String(round.round) === roundNum ? { ...deepClone(round), ...deepClone(action.payload.updates) } : deepClone(round)
        );
        const refRounds = ((currentState.data.reference_data && currentState.data.reference_data.rounds) || []).map(rr =>
          String(rr.round) === roundNum ? { ...deepClone(rr), ...deepClone(action.payload.updates) } : deepClone(rr)
        );
        const overrides = {
          ...currentState.clientOverrides,
          round_summary: { ...deepClone(currentState.data.round_summary), rounds },
          reference_data: {
            ...deepClone(currentState.data.reference_data),
            rounds: refRounds,
          },
        };
        return buildStoreState(currentState.serverSnapshot, overrides, currentState.ui);
      }
      case 'set-user-team': {
        const nextUserTeam = {
          ...deepClone(currentState.data?.user_team || {}),
          club_id: action.payload.clubId || '',
          team_name: action.payload.teamName || '',
        };
        return buildStoreState(currentState.serverSnapshot, {
          ...currentState.clientOverrides,
          user_team: nextUserTeam,
        }, currentState.ui);
      }
      case 'set-ui-preference': {
        const prefs = deepClone(currentState.data?.ui_preferences || {});
        prefs[action.payload.key] = action.payload.value;
        return buildStoreState(currentState.serverSnapshot, {
          ...currentState.clientOverrides,
          ui_preferences: prefs,
        }, currentState.ui);
      }
      case 'set-split': {
        const { round, jumper, subteam } = action.payload;
        // Clone the full merged reference_data to preserve players, jobs, etc.
        const refData = deepClone((currentState.data && currentState.data.reference_data) || {});
        const existingSplits = refData.splits || [];
        const idx = existingSplits.findIndex(
          s => String(s.round) === String(round) && String(s.jumper) === String(jumper)
        );
        if (idx >= 0) existingSplits[idx] = { ...existingSplits[idx], subteam };
        else existingSplits.push({ round: String(round), jumper: String(jumper), subteam });
        refData.splits = existingSplits;
        return buildStoreState(currentState.serverSnapshot, {
          ...currentState.clientOverrides,
          reference_data: refData,
        }, currentState.ui);
      }
      case 'toggle-player-absent': {
        if (!currentState.data) return currentState;
        const { round: absentRound, jumper: absentJumper } = action.payload;
        const refData = deepClone((currentState.data && currentState.data.reference_data) || {});
        const absences = refData.absences || [];
        const matchAbsence = a =>
          String(a.round) === String(absentRound) && String(a.jumper) === String(absentJumper);
        refData.absences = absences.some(matchAbsence)
          ? absences.filter(a => !matchAbsence(a))
          : [...absences, { round: String(absentRound), jumper: String(absentJumper) }];
        return buildStoreState(currentState.serverSnapshot, {
          ...currentState.clientOverrides,
          reference_data: refData,
        }, currentState.ui);
      }
      case 'update-reference-data': {
        if (!currentState.data) return currentState;
        const { key: refKey, records: refRecords } = action.payload;
        const refData = deepClone(currentState.data?.reference_data || {});
        refData[refKey] = deepClone(refRecords);
        return buildStoreState(currentState.serverSnapshot, {
          ...currentState.clientOverrides,
          reference_data: refData,
        }, currentState.ui);
      }
      case 'swap-volunteer': {
        if (!currentState.data) return currentState;
        const { roundNum: swapRound, job: swapJob, subteam: swapSubteam, slotIndex: swapSlot,
                newVolunteer, newJumper } = action.payload;
        const swapRounds = ((currentState.data.round_summary && currentState.data.round_summary.rounds) || [])
          .map(round => {
            if (String(round.round) !== String(swapRound)) return deepClone(round);
            const entries = (round.entries || []).map(e => {
              if (e.job === swapJob
                && (e.subteam || 'shared') === swapSubteam
                && (e.slot_index ?? 0) === swapSlot) {
                return { ...deepClone(e), jumper: String(newJumper || ''), slot_status: 'manual' };
              }
              return deepClone(e);
            });
            return { ...deepClone(round), entries };
          });
        return buildStoreState(currentState.serverSnapshot, {
          ...currentState.clientOverrides,
          round_summary: { ...deepClone(currentState.data.round_summary), rounds: swapRounds },
        }, currentState.ui);
      }
      case 'unset-volunteer': {
        if (!currentState.data) return currentState;
        const { roundNum: unsetRound, job: unsetJob, subteam: unsetSubteam, slotIndex: unsetSlot } = action.payload;
        // Always clear to unfilled — never restore from serverSnapshot.
        // The server snapshot may itself have slot_status:'manual' (previously-saved
        // session), so restoring from it would leave the M badge in place and cause
        // reallocate to re-preserve the same assignment. Clearing to unfilled removes
        // the entry from the manual-preservation set so the next reallocate fills it
        // automatically.
        const unsetRounds = ((currentState.data.round_summary && currentState.data.round_summary.rounds) || [])
          .map(round => {
            if (String(round.round) !== String(unsetRound)) return deepClone(round);
            const entries = (round.entries || []).map(e => {
              if (e.job === unsetJob && (e.subteam || 'shared') === unsetSubteam && (e.slot_index ?? 0) === unsetSlot) {
                return { ...deepClone(e), jumper: '', slot_status: 'unfilled' };
              }
              return deepClone(e);
            });
            return { ...deepClone(round), entries };
          });
        return buildStoreState(currentState.serverSnapshot, {
          ...currentState.clientOverrides,
          round_summary: { ...deepClone(currentState.data.round_summary), rounds: unsetRounds },
        }, currentState.ui);
      }
      default:
        return currentState;
    }
  }

  return { getState, getData, dispatch };
}

function getState() {
  return SPA_STORE.getState();
}

function getData() {
  return SPA_STORE.getData();
}

function dispatch(action) {
  const result = SPA_STORE.dispatch(action);

  // OFF-005a: Persist mutations to IDB
  if (_idbAvailable && _idb && _idb.saveSnapshot) {
    const data = getData();
    if (data) {
      _idb.saveSnapshot(data).catch(err => {
        console.warn('[offline] IDB save failed after dispatch', err);
        // Non-blocking: IDB failure doesn't break app
      });
    }
  }

  // OFF-005b: Fire PUT async to sync with server
  const data = getData();
  if (data) {
    syncToServer(data);
  }

  return result;
}

function assertConsistency() {
  const data = getData();
  if (!data) return { ok: true, mismatches: [] };
  const mismatches = [];
  const teamName = data.user_team?.team_name || '';
  const sbName = document.getElementById('sbTeamName')?.textContent || '';
  if (teamName && sbName && sbName !== teamName) {
    mismatches.push({ field: 'user_team.team_name', displayed: sbName, stored: teamName });
  }
  const printFooter = data.ui_preferences?.print_footer ?? '';
  const pfInput = document.getElementById('printFooterInput');
  if (pfInput && pfInput.value !== printFooter) {
    mismatches.push({ field: 'ui_preferences.print_footer', displayed: pfInput.value, stored: printFooter });
  }
  return { ok: mismatches.length === 0, mismatches };
}

window.__rosterSpa = { getState, getData, dispatch, assertConsistency };

function selectUiState(state = getState()) {
  return state?.ui || initialUiState();
}

function selectStoreData(state = getState()) {
  return state?.data || null;
}

function selectRounds(state = getState()) {
  return selectStoreData(state)?.round_summary?.rounds || [];
}

function selectRoundByNum(roundNum, state = getState()) {
  if (roundNum == null) return null;
  const target = String(roundNum);
  return selectRounds(state).find(round => String(round.round) === target) || null;
}

function selectSelectedRound(state = getState()) {
  const ui = selectUiState(state);
  if (!ui.roundDetailOpen || ui.selectedRound == null) return null;
  return selectRoundByNum(ui.selectedRound, state);
}

function selectDashboardViewModel(state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;
  const rounds = selectRounds(state);
  const featureRound = rounds.find(round => round.status !== 'confirmed') || rounds[rounds.length - 1] || null;
  const totalRounds = rounds.length;
  const confirmedRounds = rounds.filter(round => round.status === 'confirmed').length;
  return {
    rounds,
    featureRound,
    totalRounds,
    confirmedRounds,
    scheduledRounds: Math.max(totalRounds - confirmedRounds, 0),
    columns: data.matrix?.columns || [],
  };
}

function selectMatrixViewModel(state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;
  const rounds = selectRounds(state);
  const roundEntriesLookup = {};
  rounds.forEach(round => {
    roundEntriesLookup[String(round.round)] = buildEntriesMap(round.entries || []);
  });
  const matrixRoundLookup = {};
  (data.matrix?.rounds || []).forEach(round => {
    matrixRoundLookup[String(round.round)] = round;
  });
  return {
    rounds,
    columns: data.matrix?.columns || [],
    roundEntriesLookup,
    matrixRoundLookup,
  };
}

function selectRoundsViewModel(state = getState()) {
  const rounds = selectRounds(state);
  return {
    rounds,
    roundCount: rounds.length,
    selectedRound: selectSelectedRound(state),
  };
}

function selectRoundDetailViewModel(state = getState()) {
  const round = selectSelectedRound(state);
  if (!round) return null;
  const rounds = selectRounds(state);
  return {
    round,
    rounds,
    totalRounds: rounds.length,
  };
}

function selectSettingsViewModel(state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;
  const ov = data.season_overview || {};
  const eligibleCount = data.volunteers?.eligible?.length || 0;
  const ineligibleCount = data.volunteers?.ineligible?.length || 0;
  return {
    cards: [
      { label: 'Players',       value: ov.players },
      { label: 'Eligible Vols', value: eligibleCount },
      { label: 'Ineligible',    value: ineligibleCount },
      { label: 'Rounds',        value: ov.rounds },
      { label: 'Total Slots',   value: ov.total_season_slots },
      { label: 'Slots / Round', value: ov.slots_per_round },
      { label: 'Ideal Assign.', value: Number(ov.ideal_assignments_per_volunteer).toFixed(1) },
      { label: 'Confirmed',     value: ov.confirmed_rounds, sub: 'rounds locked' },
      { label: 'Scheduled',     value: ov.scheduled_rounds, sub: 'rounds pending' },
    ],
    clubs: data.reference_data?.clubs || [],
    selectedClubId: data.user_team?.club_id || '',
    teamName: data.user_team?.team_name || '',
    printFooter: data.ui_preferences?.print_footer ?? '',
  };
}

function selectSidebarViewModel(state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;
  const rounds = selectRounds(state);
  const eligible = data.volunteers?.eligible || [];
  const ineligible = data.volunteers?.ineligible || [];
  const total = eligible.length + ineligible.length;
  const roster = data.user_team?.roster || [];
  const teamName = data.user_team?.team_name || 'Volunteer Roster';
  const admin = isAdmin();
  const playerCount = admin ? total : roster.length;
  const playerLabel = admin ? 'volunteer' : 'player';
  const roundCount = rounds.length;
  const initials = getInitials(teamName);
  return {
    teamName,
    initials,
    seasonYear: buildSeasonLabel(rounds),
    eligibleCount: eligible.length,
    totalCount: total,
    isAdmin: admin,
    modeLabel: admin ? 'ADMIN MODE' : 'USER MODE',
    modeIcon: admin ? '⚙' : '👤',
    modeStats: `${playerCount} ${playerLabel}${playerCount !== 1 ? 's' : ''} · ${roundCount} round${roundCount !== 1 ? 's' : ''}`,
    userAv: admin ? 'AD' : (initials.slice(0, 2) || 'U'),
    userName: admin ? 'Admin view' : (teamName || 'User view'),
    userRole: admin ? 'Server-synced · full access' : 'Local data · browser-only',
  };
}

function buildSeasonLabel(rounds) {
  const years = [...new Set(
    (rounds || [])
      .map(round => String(round?.date || '').slice(0, 4))
      .filter(year => /^\d{4}$/.test(year))
      .sort()
  )];
  if (years.length === 0) return '';
  if (years.length === 1) return `Season ${years[0]}`;
  return `Season ${years[0]}/${years[years.length - 1].slice(-2)}`;
}

function computeClientBalance(data) {
  // Build volunteer list: prefer user_team.roster (USER_SPA), fall back to
  // volunteers.eligible (ADMIN_SPA). Both must map jumper → display name.
  const rosterMembers = (data?.user_team?.roster || []).filter(m => m.jumper);
  const eligibleVols  = (data?.volunteers?.eligible || []).filter(v => v.jumper);

  const volList = rosterMembers.length > 0
    ? rosterMembers.map(m => ({ jumper: String(m.jumper), name: m.name || String(m.jumper) }))
    : eligibleVols.map(v => ({ jumper: String(v.jumper), name: v.volunteer || String(v.jumper) }));

  if (volList.length === 0) return null;

  // Count assignments from ALL non-BYE rounds regardless of confirmation status.
  // Scheduled rounds represent real allocations — omitting them hides the workload.
  // Track confirmed/scheduled split and assignment chip data for the volunteers panel.
  const countByJumper = {};
  const confirmedByJumper = {};
  const scheduledByJumper = {};
  const assignmentsByJumper = {};
  for (const r of (data?.round_summary?.rounds || [])) {
    if (r.home_away === 'B') continue;
    const isConfirmed = r.status === 'confirmed';
    for (const e of (r.entries || [])) {
      if (e.jumper && e.slot_status !== 'unfilled') {
        const j = String(e.jumper);
        countByJumper[j] = (countByJumper[j] || 0) + 1;
        if (isConfirmed) confirmedByJumper[j] = (confirmedByJumper[j] || 0) + 1;
        else scheduledByJumper[j] = (scheduledByJumper[j] || 0) + 1;
        if (!assignmentsByJumper[j]) assignmentsByJumper[j] = [];
        assignmentsByJumper[j].push({
          round: String(r.round),
          job: e.job || '',
          status: r.status || 'scheduled',
          consecutive_repeat: false,
        });
      }
    }
  }

  const entries = volList.map(m => ({
    volunteer: m.name,
    jumper: m.jumper,
    count: countByJumper[m.jumper] || 0,
    confirmed: confirmedByJumper[m.jumper] || 0,
    scheduled: scheduledByJumper[m.jumper] || 0,
    assignments: assignmentsByJumper[m.jumper] || [],
  }));
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  // No actual assignments yet — let stored balance take precedence as a fallback.
  if (total === 0) return null;
  const ideal = entries.length > 0 ? total / entries.length : 0;
  const maxCount = Math.max(...entries.map(e => e.count), 1);
  return {
    ideal_assignments_per_volunteer: ideal,
    entries: entries.map(e => ({
      ...e,
      delta: e.count - ideal,
      fraction_of_max: e.count / maxCount,
    })),
  };
}

function selectFairnessViewModel(state = getState()) {
  const data = selectStoreData(state);
  const bal = computeClientBalance(data) || data?.balance;
  if (!bal || !bal.entries || bal.entries.length === 0) {
    return {
      score: '—',
      summary: '',
      squares: [],
    };
  }
  const entries = bal.entries;
  const counts = entries.map(entry => entry.count);
  const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
  const variance = counts.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / counts.length;
  const sigma = Math.sqrt(variance);
  const maxCount = Math.max(...counts) || 1;
  return {
    score: Math.max(0, Math.min(10, 10 * (1 - sigma / maxCount))).toFixed(1),
    summary:
      sigma < 1 ? 'Workload spread evenly across volunteers.'
      : sigma < 2 ? 'Slight imbalance — review balance tab.'
      : 'Notable imbalance detected.',
    squares: entries.map(entry => ({
      jumper: entry.jumper || getVolJumper(entry.volunteer),
      volunteer: entry.volunteer || getVolunteerByJumper(entry.jumper),
      count: entry.count,
      delta: entry.delta || 0,
      opacity: 0.5 + (entry.fraction_of_max !== undefined ? entry.fraction_of_max : entry.count / maxCount) * 0.5,
    })),
  };
}

function selectAlertsViewModel(state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;
  const hardErrors = data.issues?.hard_errors || [];
  const warnings = data.issues?.warnings || [];
  const outcome = data.status?.outcome || 'unknown';
  const isOk = outcome === 'success' || outcome === 'ok';
  return {
    hardErrors,
    warnings,
    statusClass: isOk ? 'ok' : outcome === 'warning' ? 'warn' : 'err',
    statusIcon: isOk ? '✓' : outcome === 'warning' ? '⚠' : '✗',
    statusLabel: isOk ? 'Clean' : outcome === 'warning' ? 'Warnings' : 'Errors',
  };
}

function selectVolunteersViewModel(filter = '', state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;
  let eligible = data.volunteers?.eligible || [];
  const ineligible = data.volunteers?.ineligible || [];

  // USER_SPA fallback: derive minimal volunteer list from user_team.roster
  if (eligible.length === 0) {
    const roster = data.user_team?.roster || [];
    if (roster.length > 0) {
      eligible = roster.map(m => ({
        jumper: String(m.jumper),
        volunteer: m.name || String(m.jumper),
        player_name: m.name || String(m.jumper),
        certifications: [],
        preferred_jobs: [],
        avoid_jobs: [],
        total_assignments: 0,
        confirmed_assignments: 0,
        scheduled_assignments: 0,
        assignments: [],
      }));
    }
  }

  const lower = String(filter || '').toLowerCase();
  const absences = data.reference_data?.absences || [];

  // Compute live counts from round_summary so both panels agree.
  // balMap keys are String(jumper) → { count, confirmed, scheduled, assignments }.
  const bal = computeClientBalance(data) || data.balance;
  const balMap = Object.fromEntries((bal?.entries || []).map(e => [String(e.jumper), e]));

  return {
    eligibleCount: eligible.length,
    ideal: bal ? Number(bal.ideal_assignments_per_volunteer).toFixed(1) : '—',
    filtered: eligible.filter(volunteer =>
      (volunteer.volunteer || '').toLowerCase().includes(lower)
      || (volunteer.player_name || '').toLowerCase().includes(lower)
    ).map(v => {
      const b = balMap[String(v.jumper)] || {};
      // Use live computed counts; fall back to stored only when no round_summary data exists.
      const totalAssignments       = b.count     ?? v.total_assignments     ?? 0;
      const confirmedAssignments   = b.confirmed  ?? v.confirmed_assignments ?? 0;
      const scheduledAssignments   = b.scheduled  ?? v.scheduled_assignments ?? 0;
      // Use live assignment chips from round_summary; fall back to stored list.
      const liveAssignments = (b.assignments && b.assignments.length > 0)
        ? b.assignments
        : (v.assignments || []);
      return {
        ...v,
        total_assignments: totalAssignments,
        confirmed_assignments: confirmedAssignments,
        scheduled_assignments: scheduledAssignments,
        assignments: liveAssignments,
        outRounds: absences
          .filter(a => String(a.jumper) === String(v.jumper))
          .map(a => String(a.round)),
      };
    }),
    ineligible,
  };
}

function selectBalanceViewModel(state = getState()) {
  const data = selectStoreData(state);
  // Always compute from live round_summary so scheduled assignments are visible.
  // Fall back to stored data.balance only when there are no entries to compute from.
  const computed = computeClientBalance(data);
  const balance = computed || data?.balance;
  if (!balance) return null;
  const entries = balance.entries || [];
  const ideal = balance.ideal_assignments_per_volunteer;
  const maxCount = entries.length ? Math.max(...entries.map(entry => entry.count)) : 1;
  return {
    ideal: Number(ideal).toFixed(1),
    idealPct: maxCount ? Math.min((ideal / maxCount) * 100, 100) : 0,
    rows: entries.map(entry => ({
      volunteer: entry.volunteer,
      count: entry.count,
      delta: entry.delta ?? 0,
      barPct: (entry.fraction_of_max !== undefined ? entry.fraction_of_max : entry.count / maxCount) * 100,
    })),
  };
}

function selectConstraintsViewModel(state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;

  // Always copy — data is deep-frozen (state is immutable), so push to a new array.
  const storedAvoids = data.constraints?.avoid_jobs;
  let avoids = [...(storedAvoids || [])];

  // Fall back to volunteer profiles only when avoid_jobs key is absent (null constraints or
  // missing key).  An explicitly-empty [] means "constraints loaded, none defined" — don't
  // override it with derived data or an explicit clear would immediately re-populate.
  if (!storedAvoids) {
    // data.volunteers.eligible carries avoid_jobs per volunteer (ADMIN_SPA).
    // data.reference_data.volunteers carries the same for USER_SPA.
    const sources = [
      ...(data.volunteers?.eligible || []),
      ...(data.reference_data?.volunteers || []),
    ];
    const seen = new Set();
    for (const v of sources) {
      const name = v.volunteer || v.volunteer_name || '';
      const jobs = v.avoid_jobs || [];
      if (name && jobs.length > 0 && !seen.has(name)) {
        seen.add(name);
        avoids.push({ volunteer: name, jobs: Array.isArray(jobs) ? jobs : Array.from(jobs) });
      }
    }
  }

  return {
    avoids,
    count: avoids.length,
  };
}

function selectNavigationViewModel(state = getState()) {
  const ui = selectUiState(state);
  return {
    activePanel: ui.activePanel,
    showRoundDetail: ui.activePanel === 'rounds' && !!selectSelectedRound(state),
  };
}

function serializeSnapshotModel(state = getState()) {
  const data = selectStoreData(state);
  if (!data) return null;
  return { ...deepClone(data), _schema_version: '1.1' };
}

function normalizeRoundRef(roundOrNum) {
  return roundOrNum && typeof roundOrNum === 'object' ? roundOrNum.round : roundOrNum;
}

function isIphoneNavViewport() {
  return document.body?.dataset?.deviceTarget === 'iphone'
    || window.matchMedia('(max-width: 430px)').matches;
}

function markMobileNavHintSeen() {
  if (_mobileNavHintSeen) return;
  _mobileNavHintSeen = true;
  try {
    localStorage.setItem(MOBILE_NAV_HINT_KEY, '1');
  } catch (_) {}
}

function restoreMobileNavHintState() {
  try {
    _mobileNavHintSeen = localStorage.getItem(MOBILE_NAV_HINT_KEY) === '1';
  } catch (_) {
    _mobileNavHintSeen = false;
  }
}

// ── Offline mode helpers ─────────────────────────────────────────────────
function showOfflineBanner() {
  const banner = document.getElementById('offline-unavailable-banner');
  if (banner) banner.style.display = 'block';
}

function showUnsyncedBanner() {
  const banner = document.getElementById('unsynced-writes-banner');
  const count = document.getElementById('unsynced-count');
  if (banner) {
    if (_unsyncedWriteCount >= 50) {
      if (count) count.textContent = _unsyncedWriteCount + '+';
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }
}

function hideUnsyncedBanner() {
  const banner = document.getElementById('unsynced-writes-banner');
  if (banner) banner.style.display = 'none';
}

function showBlockingError(message) {
  const overlay = document.getElementById('blocking-error-overlay');
  const msgEl = document.getElementById('blocking-error-message');
  const loadingEl = document.getElementById('loading');

  if (msgEl) msgEl.textContent = message || 'Cannot load roster data. Please check your connection and try again.';
  if (loadingEl) loadingEl.remove();
  if (overlay) {
    // Promote overlay above other content so it isn't hidden by an unstyled #app.
    overlay.style.display = 'flex';
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '9999';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
  }
}

function showToast(message, type = 'info') {
  const el = document.getElementById('snapshotToast');
  if (!el) return;
  el.textContent = message;
  el.className = 'show ' + (type || '');
  el.dataset.toastType = type;
  el.dataset.toastMessage = message;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = ''; }, 4000);
}

function hideLoading() {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.add('hide');
  setTimeout(() => { try { el.remove(); } catch(e) {} }, 500);
}

async function initOfflineMode() {
  // OFF-008: Check if IndexedDB is available
  // This is a sync check; actual availability confirmed via async operations
  _idbAvailable = window.__idb && typeof window.__idb.isAvailable === 'function' && window.__idb.isAvailable();
  _idb = window.__idb;

  if (!_idbAvailable) {
    console.warn('[offline] IndexedDB unavailable (private browsing or blocked)');
    if (!isAdmin()) {
      // USP-054: USER_SPA requires IDB — show blocking error, do not proceed
      showIdbUnavailableError();
      return;
    }
    showOfflineBanner();
  }
}

function showIdbUnavailableError() {
  // USP-054: shown in user mode when browser storage (IDB) is unavailable
  hideLoading();
  const existing = document.getElementById('idbErrorScreen');
  if (existing) { existing.style.display = 'flex'; return; }
  const el = document.createElement('div');
  el.id = 'idbErrorScreen';
  el.setAttribute('data-idb-unavailable', '');
  el.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg,#111);color:var(--text,#eee);padding:2rem;text-align:center;z-index:9999;';
  el.innerHTML = `
    <h2 style="margin-bottom:1rem">Browser storage required</h2>
    <p>This app stores your team data in your browser's local storage (IndexedDB).<br>
    It looks like browser storage isn't available — this can happen in private or incognito mode.</p>
    <p style="margin-top:1rem">Please open the app in a regular (non-incognito) browser window.</p>`;
  document.body.appendChild(el);
  // Hide wizard and app so they cannot be reached
  const wizard = document.getElementById('wizard');
  if (wizard) wizard.style.display = 'none';
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
}

async function syncToServer(snapshot) {
  // OFF-005b: Fire PUT async to sync with server
  if (!snapshot) return;
  if (!isAdmin()) return;

  fetch('/api/roster-data', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': snapshot.revision ? String(snapshot.revision) : '0'
    },
    body: JSON.stringify(snapshot)
  }).then(resp => {
    if (resp.ok) {
      // OFF-011: Sync successful, reset counter
      _unsyncedWriteCount = 0;
      hideUnsyncedBanner();
    } else if (resp.status === 409) {
      // OFF-013: Conflict detected (stub for now, full handler in item [B])
      showToast('Data conflict — please reconcile', 'warning');
    } else {
      // OFF-006: Non-blocking error
      _unsyncedWriteCount++;
      showUnsyncedBanner();
      showToast('Server sync failed — data saved locally', 'error');
    }
  }).catch(err => {
    // OFF-006, OFF-010: Network error
    _unsyncedWriteCount++;
    showUnsyncedBanner();
    showToast('Offline — changes saved to local storage', 'info');
  });
}

// One-time migration: move print footer from legacy localStorage key into the store.
// Called after every successful hydration path so legacy installs converge to the
// store-backed model regardless of which loader (fresh/idb/server) ran.
function migrateLegacyPrintFooter() {
  if (getData()?.ui_preferences?.print_footer) return;
  try {
    const stored = localStorage.getItem('roster-print-footer');
    if (stored) {
      dispatch({ type: 'set-ui-preference', payload: { key: 'print_footer', value: stored } });
      localStorage.removeItem('roster-print-footer');
    }
  } catch (_) {
    /* localStorage may be unavailable in private browsing — non-fatal */
  }
}

async function initStore() {
  // OFF-007: Handle ?fresh=1 query parameter
  const url = new URL(location);
  const isFresh = url.searchParams.has('fresh');

  if (isFresh && isAdmin()) {
    // OFF-007: Bypass IDB, fetch fresh from server (admin mode only)
    url.searchParams.delete('fresh');
    history.replaceState(null, '', url.toString());

    try {
      const data = await fetch('/api/roster-data').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      dispatch({ type: 'load-report', payload: { filename: 'from-server', report: data } });
      migrateLegacyPrintFooter();
      render();
      document.getElementById('app').classList.add('show');
      hideLoading();

      // OFF-007: Repopulate IDB with fresh data
      if (_idbAvailable && _idb && _idb.saveSnapshot) {
        _idb.saveSnapshot(data).catch(err => {
          console.warn('[offline] Failed to save fresh data to IDB', err);
        });
      }
      return;
    } catch (err) {
      // OFF-016: Fresh load failure → blocking error, don't corrupt IDB
      showBlockingError('Fresh load failed. Check your connection and try again.');
      return;
    }
  }

  // OFF-003: Try IndexedDB first (if available)
  if (_idbAvailable && _idb && _idb.loadSnapshot) {
    try {
      const snapshot = await _idb.loadSnapshot();
      if (snapshot) {
        // OFF-003: Hydrate from IDB
        dispatch({ type: 'load-report', payload: { filename: 'from-idb', report: snapshot } });
        migrateLegacyPrintFooter();
        render();
        document.getElementById('app').classList.add('show');
        hideLoading();

        // OFF-005b: Fire PUT async to sync (admin mode only)
        syncToServer(snapshot);
        return;
      }
    } catch (err) {
      console.warn('[offline] IDB load failed', err);
    }
  }

  // USP-020: USER_SPA with no IDB state → show onboarding wizard
  // USP-054: if IDB is unavailable, showIdbUnavailableError already handled it
  if (!isAdmin()) {
    if (!_idbAvailable) return;
    hideLoading();
    window.__showWizard(async (state) => {
      if (_idbAvailable && _idb && _idb.saveSnapshot) {
        await _idb.saveSnapshot(state);
      }
      dispatch({ type: 'load-report', payload: { filename: 'from-wizard', report: state } });
      render();
      document.getElementById('app').classList.add('show');
    });
    return;
  }

  // OFF-004: Admin fall back to server
  try {
    const data = await fetch('/api/roster-data').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    dispatch({ type: 'load-report', payload: { filename: 'from-server', report: data } });
    migrateLegacyPrintFooter();
    render();
    document.getElementById('app').classList.add('show');
    hideLoading();

    // OFF-005b: Persist to IDB for next time
    if (_idbAvailable && _idb && _idb.saveSnapshot) {
      _idb.saveSnapshot(data).catch(err => {
        console.warn('[offline] Failed to save server data to IDB', err);
      });
    }
  } catch (err) {
    // OFF-009: Blocking error if both IDB and server fail
    console.error('[offline] initStore failed', err);
    showBlockingError('Cannot load roster. Check your connection and try again.');
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupNav();
  setupSettings();
  setupTeamSplits();
  setupDataPanel();
  restoreSkin();
  restoreMobileNavHintState();

  // OFF-008: Initialize offline mode (check IDB availability)
  await initOfflineMode();

  // OFF-003/OFF-004: New offline-first load path
  // This is the main entry point for the app
  await initStore();

  // Wire up banner buttons
  const bannerReconnect = document.getElementById('banner-reconnect');
  if (bannerReconnect) {
    bannerReconnect.addEventListener('click', () => {
      // Try syncing again
      const data = getData();
      if (data) syncToServer(data);
    });
  }

  const bannerClose = document.getElementById('banner-close');
  if (bannerClose) {
    bannerClose.addEventListener('click', () => {
      hideUnsyncedBanner();
    });
  }

  const blockingErrorRetry = document.getElementById('blocking-error-retry');
  if (blockingErrorRetry) {
    blockingErrorRetry.addEventListener('click', () => {
      location.reload();
    });
  }
});

// ── File picker ──────────────────────────────────────────────────────────
function showPicker(files) {
  const list = document.getElementById('fileList');
  list.innerHTML = '';
  if (files.length === 0) {
    list.innerHTML = '<p class="no-files">No .json files found in <code>roster-data/</code>.<br>Copy your <code>roster_report.json</code> there and refresh.</p>';
  } else {
    files.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'file-btn';
      btn.textContent = f;
      btn.onclick = async () => {
        document.getElementById('picker').classList.remove('show');
        try { await loadFile(f); } catch(err) {}
      };
      list.appendChild(btn);
    });
  }
  document.getElementById('picker').classList.add('show');
}

function openPicker() {
  fetch('/api/roster-files')
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(files => showPicker(files))
    .catch(() => showPicker([]));
}

// ── Save snapshot ────────────────────────────────────────────────────────
async function saveSnapshot() {
  const data = serializeSnapshotModel();
  if (!data) return;
  const btn = document.getElementById('btnSaveSnapshot');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/roster-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseName: 'roster_report', model: data }),
    });
    if (!res.ok) {
      showSnapshotToast('Save failed: ' + res.status, 'err');
      return;
    }
    const saved = await res.json();
    showSnapshotToast('Saved: ' + saved.filename, 'ok');
  } catch (err) {
    showSnapshotToast('Save failed: network error', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showSnapshotToast(msg, type) {
  const el = document.getElementById('snapshotToast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show ' + (type || '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = ''; }, 4000);
}

async function reallocate(btnEl) {
  const data = getData();
  if (!data) return;
  const btn = btnEl || document.getElementById('btnReallocate');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Working…'; }

  try {
    // Check allocator mode from localStorage (default: 'spa')
    const mode = localStorage.getItem('allocator-mode') ?? 'spa';

    if (mode === 'spa') {
      // ALC-004: Invoke JS allocator
      try {
        const allocator = _getAllocator();

        // Snapshot manual assignments from non-confirmed rounds before reallocating.
        // Group by round|job|subteam in order — slot_index schemes vary between
        // old data (1-based) and fresh allocations (0-based), so match by position
        // within each job+subteam group rather than by raw slot_index.
        const manualGroups = {};
        for (const rnd of (data.round_summary?.rounds || [])) {
          if (rnd.status === 'confirmed') continue;
          for (const e of (rnd.entries || [])) {
            if (e.slot_status === 'manual') {
              const key = `${rnd.round}|${e.job}|${e.subteam || 'shared'}`;
              if (!manualGroups[key]) manualGroups[key] = [];
              manualGroups[key].push(e);
            }
          }
        }

        const result = allocator.allocate(data);

        // Re-overlay manual assignments by positional match within each job+subteam group
        if (Object.keys(manualGroups).length > 0) {
          const groupPos = {};
          for (const rnd of (result.round_summary?.rounds || [])) {
            if (rnd.status === 'confirmed') continue;
            for (let i = 0; i < (rnd.entries || []).length; i++) {
              const e = rnd.entries[i];
              const key = `${rnd.round}|${e.job}|${e.subteam || 'shared'}`;
              if (!groupPos[key]) groupPos[key] = 0;
              const pos = groupPos[key]++;
              const manuals = manualGroups[key];
              if (manuals && manuals[pos]) {
                rnd.entries[i] = { ...e, jumper: manuals[pos].jumper, slot_status: 'manual' };
              }
            }
          }
        }

        const newState = {
          ...data,
          round_summary: result.round_summary,
        };
        // ALC-005a: dispatch replace-server-report
        dispatch({
          type: 'replace-server-report',
          payload: { report: newState },
        });
        // ALC-005b: render
        render();
        _writeMetadata();
        // ALC-005c: fire PUT asynchronously (non-blocking)
        syncToServer(newState);
        showSnapshotToast('Re-allocated successfully', 'ok');
      } catch (err) {
        // ALC-024: Show error toast, do not update state
        showSnapshotToast(`Allocation failed: ${err.message}`, 'err');
      }
    } else if (mode === 'server' && isAdmin()) {
      // ALC-019: Call server engine
      const res = await fetch('/api/reallocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: data }),
      });
      if (!res.ok) {
        // ALC-021: Show error, do not silently fall back
        const err = await res.json().catch(() => ({}));
        showSnapshotToast('Re-allocate failed: ' + (err.error || res.status), 'err');
        return;
      }
      const updated = await res.json();
      dispatch({
        type: 'replace-server-report',
        payload: { report: updated },
      });
      render();
      _writeMetadata();
      showSnapshotToast('Re-allocated successfully', 'ok');
    }
  } catch (err) {
    showSnapshotToast('Re-allocate failed: network error', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Re-allocate'; }
  }
}

// ALC-005c: Fire PUT asynchronously for SPA mode
function syncToServer(snapshot) {
  if (!isAdmin()) return;
  fetch('/api/roster-data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  }).catch(() => {
    // ALC-006: Non-blocking error toast
    showSnapshotToast('Server sync failed — data saved locally', 'err');
  });
}

// ── Round edit mode ───────────────────────────────────────────────────────
function _editOppositions() {
  const data = getData();
  return (data?.reference_data?.clubs || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

function _editLocationsForClub(clubId) {
  const data = getData();
  return (data?.reference_data?.locations || [])
    .filter(l => l.club_id === clubId)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

function _locationField(locs, currentDisplayName) {
  if (locs.length <= 1) {
    const val = locs[0] ? locs[0].display_name : (currentDisplayName || '');
    return `<span class="edit-form-static">${escHtml(val) || '—'}</span>`
         + `<input type="hidden" id="editLocation" value="${escHtml(val)}">`;
  }
  const opts = locs.map(l =>
    `<option value="${escHtml(l.display_name)}"${l.display_name === currentDisplayName ? ' selected' : ''}>${escHtml(l.display_name)}</option>`
  ).join('');
  return `<select id="editLocation">${opts}</select>`;
}

function openEditMode(r) {
  const round = selectRoundByNum(normalizeRoundRef(r));
  if (!round) return;
  const clubs   = _editOppositions();
  const curClub = clubs.find(c => String(c.club_id) === String(round.opposition_club_id))
    || clubs.find(c => c.name === round.opposition);
  const clubId  = curClub ? curClub.club_id : (clubs[0] ? clubs[0].club_id : '');
  const locs    = _editLocationsForClub(clubId);
  const timeVal = (round.time || '').match(/T(\d{2}:\d{2})/)?.[1] || '';

  const oppOpts = clubs.map(c =>
    `<option value="${escHtml(c.club_id)}"${c.club_id === clubId ? ' selected' : ''}>${escHtml(c.name)}</option>`
  ).join('');

  document.getElementById('roundEditForm').innerHTML = `
    <div class="edit-form">
      <div class="edit-form-row">
        <span class="edit-form-label">Opposition</span>
        <select id="editOpposition" onchange="updateEditLocation(this.value)">
          ${oppOpts}
        </select>
      </div>
      <div id="editLocationRow" class="edit-form-row">
        <span class="edit-form-label">Location</span>
        ${_locationField(locs, resolveLocation(round))}
      </div>
      <div id="editHaRow" class="edit-form-row">
        <span class="edit-form-label">Home/Away</span>
        ${haTogglePill(round)}
      </div>
      <div class="edit-form-row">
        <span class="edit-form-label">Time</span>
        <input type="time" id="editTime" value="${timeVal}">
      </div>
      <div class="edit-form-row">
        <span class="edit-form-label">Date</span>
        <input type="date" id="editDate" value="${escHtml(round.date || '')}">
      </div>
      <div class="edit-form-actions">
        <button class="btn" onclick="closeEditMode()">Cancel</button>
        <button class="btn btn-primary" onclick="saveRoundEdit('${escHtml(String(round.round))}')">Save</button>
      </div>
    </div>`;

  document.getElementById('roundEditForm').style.display = 'block';
  document.querySelector('#roundDetail .detail-layout').style.display = 'none';

  const btn = document.getElementById('btnEditRound');
  if (btn) { btn.classList.add('btn-editing'); btn.disabled = true; btn.innerHTML = '● Editing'; }
  const confirmBtn = document.getElementById('btnConfirmRound');
  if (confirmBtn) confirmBtn.disabled = true;
  const reallocBtn = document.getElementById('btnReallocate');
  if (reallocBtn) reallocBtn.disabled = true;
}

function updateEditLocation(clubId) {
  const locs = _editLocationsForClub(clubId);
  const row  = document.getElementById('editLocationRow');
  if (!row) return;
  row.innerHTML = `<span class="edit-form-label">Location</span>${_locationField(locs, '')}`;
}

function closeEditMode() {
  resetRoundEditMode();
}

function resetRoundEditMode() {
  document.getElementById('roundEditForm').style.display = 'none';
  document.getElementById('roundEditForm').innerHTML = '';
  document.querySelector('#roundDetail .detail-layout').style.display = '';

  const btn = document.getElementById('btnEditRound');
  if (btn) {
    btn.classList.remove('btn-editing');
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M11.5 2.5a2.121 2.121 0 0 1 3 3L5 15H2v-3L11.5 2.5z"/></svg> Edit values';
  }
  const confirmBtn = document.getElementById('btnConfirmRound');
  if (confirmBtn) confirmBtn.disabled = false;
  const reallocBtn = document.getElementById('btnReallocate');
  if (reallocBtn) reallocBtn.disabled = false;
}

function saveRoundEdit(roundNum) {
  const r = getRoundByNum(roundNum);
  if (!r) return;
  const clubId = document.getElementById('editOpposition')?.value;
  const data = getData();
  const club   = (data?.reference_data?.clubs || []).find(c => c.club_id === clubId);
  const locDisplayName = document.getElementById('editLocation')?.value ?? resolveLocation(r);
  const locObj = (data?.reference_data?.locations || []).find(l => l.display_name === locDisplayName);
  const t = document.getElementById('editTime')?.value;
  const newDate = document.getElementById('editDate')?.value || r.date;
  const updates = {
    date: newDate,
    location_id: locObj ? locObj.location_id : (r.location_id || ''),
    home_away: r.home_away || '',
  };
  if (club) {
    updates.opposition_club_id = club.club_id;
  }
  if (t) updates.time = newDate + 'T' + t + ':00';
  dispatch({ type: 'save-round-edit', payload: { roundNum, updates } });
  dispatch({ type: 'set-round-detail', payload: { roundNum, open: true } });
  closeEditMode();
  render();
  if (isAdmin()) {
    fetch(`/api/rounds/${encodeURIComponent(roundNum)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: updates.date,
        opposition_club_id: updates.opposition_club_id ?? (r.opposition_club_id || ''),
        home_away: updates.home_away,
        location_id: updates.location_id,
        time: updates.time ?? (r.time || ''),
      }),
    }).catch(e => console.error('Round fixture save failed:', e));
  }
}

// ── Load & render ────────────────────────────────────────────────────────
async function loadFile(filename) {
  const res = await fetch(`/roster-data/${filename}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const report = await res.json();
  dispatch({ type: 'load-report', payload: { filename, report } });
  // One-time migration: move print footer from localStorage into the store
  if (!getData()?.ui_preferences?.print_footer) {
    const stored = localStorage.getItem('roster-print-footer');
    if (stored) {
      dispatch({ type: 'set-ui-preference', payload: { key: 'print_footer', value: stored } });
      localStorage.removeItem('roster-print-footer');
    }
  }
  render();
  document.getElementById('app').classList.add('show');
}

function render() {
  try { renderLineup();       } catch(e) { console.error('[roster-spa] renderLineup:', e); }
  if (!getData()) return;
  try { renderNavigation();   } catch(e) { console.error('[roster-spa] renderNavigation:', e); }
  try { renderSidebar();      } catch(e) { console.error('[roster-spa] renderSidebar:', e); }
  try { renderDashboard();    } catch(e) { console.error('[roster-spa] renderDashboard:', e); }
  try { renderRoster();       } catch(e) { console.error('[roster-spa] renderRoster:', e); }
  try { renderRoundsList();   } catch(e) { console.error('[roster-spa] renderRoundsList:', e); }
  try { renderRoundDetail();  } catch(e) { console.error('[roster-spa] renderRoundDetail:', e); }
  try { renderVolunteers();   } catch(e) { console.error('[roster-spa] renderVolunteers:', e); }
  try { renderBalance();      } catch(e) { console.error('[roster-spa] renderBalance:', e); }
  try { renderConstraints();  } catch(e) { console.error('[roster-spa] renderConstraints:', e); }
  try { renderSettings();     } catch(e) { console.error('[roster-spa] renderSettings:', e); }
  try { renderTeamSplits();   } catch(e) { console.error('[roster-spa] renderTeamSplits:', e); }
  try { renderDataCounts();   } catch(e) { console.error('[roster-spa] renderDataCounts:', e); }
}

function renderNavigation() {
  const viewModel = selectNavigationViewModel();
  const sidebar = document.getElementById('sidebar');
  const navToggle = document.getElementById('sbNavToggle');
  const nav = document.getElementById('sbNav');
  const mobileMode = isIphoneNavViewport();

  if (!mobileMode) {
    _mobileNavOpen = false;
  }

  document.querySelectorAll('.sb-nav-item').forEach(button => {
    button.classList.toggle('active', button.dataset.panel === viewModel.activePanel);
  });
  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${viewModel.activePanel}`);
  });
  document.getElementById('roundsListView').classList.toggle('hidden', viewModel.showRoundDetail);
  document.getElementById('roundDetail').classList.toggle('active', viewModel.showRoundDetail);
  if (!viewModel.showRoundDetail) resetRoundEditMode();

  if (sidebar) {
    sidebar.dataset.mobileNavState = mobileMode ? (_mobileNavOpen ? 'open' : 'closed') : 'desktop';
  }
  if (navToggle) {
    navToggle.hidden = !mobileMode;
    navToggle.setAttribute('aria-expanded', mobileMode && _mobileNavOpen ? 'true' : 'false');
    navToggle.setAttribute('aria-label', mobileMode && _mobileNavOpen ? 'Tap to close navigation menu' : 'Tap to open navigation menu');
    navToggle.classList.toggle('sb-nav-toggle--open', mobileMode && _mobileNavOpen);
    navToggle.classList.toggle('sb-nav-toggle--hint', mobileMode && !_mobileNavHintSeen);
  }
  if (nav) {
    nav.setAttribute('aria-hidden', mobileMode && !_mobileNavOpen ? 'true' : 'false');
  }
}

// ── Sidebar metadata ─────────────────────────────────────────────────────
function renderSidebar() {
  const viewModel = selectSidebarViewModel();
  if (!viewModel) return;

  document.getElementById('sbClubName').textContent = viewModel.teamName;
  document.getElementById('sbInitials').textContent = viewModel.initials;
  document.getElementById('sbSeason').textContent = viewModel.seasonYear || '—';
  document.getElementById('sbModeIcon').textContent = viewModel.modeIcon;
  document.getElementById('sbModeLabel').textContent = viewModel.modeLabel;
  document.getElementById('sbModeStats').textContent = viewModel.modeStats;
  document.getElementById('sbUserAv').textContent = viewModel.userAv;
  document.getElementById('sbUserName').textContent = viewModel.userName;
  document.getElementById('sbUserRole').textContent = viewModel.userRole;
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.dataset.mode = viewModel.isAdmin ? 'admin' : 'user';
}

// ── Dashboard ────────────────────────────────────────────────────────────
function renderDashboard() {
  const viewModel = selectDashboardViewModel();
  if (!viewModel) return;
  const { rounds, featureRound: featRound, totalRounds, confirmedRounds, scheduledRounds, columns: cols } = viewModel;
  if (!featRound) return;

  // Headline
  const dateObj = featRound.date ? new Date(featRound.date + 'T00:00:00') : null;
  const dayName = dateObj ? dateObj.toLocaleDateString('en-AU', { weekday: 'long' }) : '';
  document.getElementById('dashHeadline').textContent =
    `${dayName} looks ${ featRound.status === 'confirmed' ? 'handled.' : 'scheduled.' }`;
  document.getElementById('dashMeta').textContent =
    `Round ${featRound.round} of ${totalRounds} · vs. ${resolveOpposition(featRound)} · ${resolveLocation(featRound)} · ${fmtTime(featRound.time)} bounce`;

  // Hero
  const thisLabel = dateObj ? dateObj.toLocaleDateString('en-AU', { weekday: 'long' }).toUpperCase() : 'THIS ROUND';
  document.getElementById('dashThisLabel').textContent = thisLabel;
  document.getElementById('dashHeroPill').innerHTML =
    `<span class="status-pill ${featRound.status === 'confirmed' ? 'ok' : 'warn'}">${featRound.status === 'confirmed' ? 'Confirmed' : 'Scheduled'}</span>` +
    (homeAwayLabel(featRound) ? ` ${haTogglePill(featRound)}` : '');
  document.getElementById('dashHeroTitle').textContent =
    `Round ${featRound.round} · ${fmtDate(featRound.date)}`;
  document.getElementById('dashHeroMeta').textContent =
    `vs. ${resolveOpposition(featRound)} · ${resolveLocation(featRound)} · ${fmtTime(featRound.time)} bounce`;

  // Job grid from entries — BYE rounds have no game, no volunteers needed
  const isByeRound = featRound.home_away === 'B';
  let jobGridHtml = '';
  if (isByeRound) {
    jobGridHtml = `<div class="bye-notice">No game this week — BYE round. Volunteers are free.</div>`;
  } else {
    const entriesMap = buildEntriesMap(featRound.entries || []);
    cols.forEach(col => {
      if (col.home_only && featRound.home_away === 'a') return;
      const key = colKey(col);
      const entries = entriesMap[key] || [];
      const chips = entries.length > 0
        ? entries.map(e => dashChipHtml(e)).join('')
        : `<span class="jumper-chip unfilled">⚠ unfilled</span>`;
      const certNote = (col.certifications && col.certifications.length)
        ? `🔒 ${escHtml(col.certifications.join(', '))}` : '';
      const subNote = col.subteam !== 'shared' ? col.subteam : '';
      const homeOnlyBadge = col.home_only
        ? `<span class="home-only-tag" title="Home games only">🏠</span>` : '';
      jobGridHtml += `<div class="job-tile">
        <div class="job-tile-left">
          <div class="job-tile-name">${escHtml(col.job)}${subNote ? ` <span class="stag stag-${subNote}">${subNote}</span>` : ''}${homeOnlyBadge}</div>
          ${certNote ? `<div class="job-tile-note">${escHtml(certNote)}</div>` : ''}
        </div>
        <div class="job-tile-chips">${chips}</div>
      </div>`;
    });
  }
  document.getElementById('dashJobGrid').innerHTML = jobGridHtml;

  // Button: copy email text
  document.getElementById('btnCopyEmail').onclick = () => copyRoundText(featRound);
  document.getElementById('btnEmailText').onclick  = () => copyRoundText(featRound);
  document.getElementById('btnPrintA4').onclick    = () => {
    openRoundDetail(featRound.round);
    setTimeout(() => window.print(), 300);
  };
  document.getElementById('btnAutoNext').onclick = () => openRoundDetail(featRound.round);

  // Season at a glance
  document.getElementById('glanceSummary').textContent =
    `${totalRounds} rounds · ${confirmedRounds} confirmed · ${scheduledRounds} scheduled`;
  const pillsHtml = rounds.map(r => {
    const isCurrent = r.round === featRound.round;
    const hasErr = false; // could check issues
    const isBye = r.home_away === 'B';
    const cls = [
      r.status,
      isCurrent ? 'current' : '',
      hasErr ? 'has-error' : '',
      isBye ? 'bye' : '',
    ].filter(Boolean).join(' ');
    const _pillHaSuffix = r.home_away === 'a' ? ' · AWAY'
                        : r.home_away === 'h' ? ' · HOME'
                        : r.home_away === 'B' ? ' · BYE' : '';
    const pillLabel = isBye ? `BYE` : `R${r.round}`;
    return `<span class="round-pill ${cls}" onclick="openRoundDetail('${r.round}')" title="Round ${r.round} · ${r.date}${_pillHaSuffix}">${pillLabel}</span>`;
  }).join('');
  document.getElementById('glancePills').innerHTML = pillsHtml;

  // Fairness score
  renderFairness();

  // Alerts
  renderAlerts();

  // Season overview stats at bottom of dashboard (F8)
  const sovm = selectSettingsViewModel();
  const dashStatGridEl = document.getElementById('dashStatGrid');
  if (dashStatGridEl && sovm) {
    dashStatGridEl.innerHTML = (sovm.cards || []).map(c => `
      <div class="stat-card">
        <div class="label">${c.label}</div>
        <div class="value">${c.value ?? '—'}</div>
        ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
      </div>`).join('');
  }
}

function renderFairness() {
  const viewModel = selectFairnessViewModel();
  document.getElementById('fairnessNum').textContent = viewModel.score;
  document.getElementById('fairnessSub').textContent = viewModel.summary || 'Workload spread across volunteers';

  const chartHtml = viewModel.squares.map(square => {
    const bg = square.delta > 1.5 ? 'var(--warn)' : square.delta < -1.5 ? 'var(--scheduled)' : 'var(--confirmed)';
    return `<div class="fairness-sq" style="background:${bg};opacity:${square.opacity}" title="${escHtml(square.volunteer)} — ${square.count} assignments">${square.jumper ? '#'+escHtml(square.jumper) : ''}</div>`;
  }).join('');
  document.getElementById('fairnessChart').innerHTML = chartHtml;
}

function renderAlerts() {
  const viewModel = selectAlertsViewModel();
  if (!viewModel) return;
  document.getElementById('headerStatus').innerHTML =
    `<span class="status-pill ${viewModel.statusClass}" style="margin-left:8px">${viewModel.statusIcon} ${viewModel.statusLabel}</span>`;

  const alertEl = document.getElementById('alertList');
  if (viewModel.hardErrors.length === 0 && viewModel.warnings.length === 0) {
    alertEl.innerHTML = `<div class="alert-item ok">
      <div class="alert-dot"></div>
      <div><span class="alert-title">All clear</span><span class="alert-body">No issues found in this roster.</span></div>
    </div>`;
    return;
  }

  alertEl.innerHTML = [
    ...viewModel.hardErrors.map(msg => `<div class="alert-item err">
      <div class="alert-dot"></div>
      <div><span class="alert-title">Error</span><span class="alert-body">${escHtml(msg)}</span></div>
    </div>`),
    ...viewModel.warnings.map(msg => `<div class="alert-item warn">
      <div class="alert-dot"></div>
      <div><span class="alert-title">Warning</span><span class="alert-body">${escHtml(msg)}</span></div>
    </div>`),
  ].join('');
}

// ── Roster (matrix) ──────────────────────────────────────────────────────
function renderRoster() {
  const viewModel = selectMatrixViewModel();
  if (!viewModel) return;
  const { columns: cols, rounds, roundEntriesLookup, matrixRoundLookup } = viewModel;

  document.getElementById('rosterSubtitle').textContent =
    `${rounds.length} rounds × ${cols.length} jobs · drag to swap · click a cell to edit`;

  // Header
  const thCols = cols.map(c => {
    const certNote = (c.certifications && c.certifications.length)
      ? `<span class="th-job-sub">🔒 ${escHtml(c.certifications.join(', '))}</span>` : '';
    const subTag = c.subteam !== 'shared'
      ? `<span class="stag stag-${c.subteam}">${escHtml(c.subteam)}</span>` : '';
    const homeOnlyBadge = c.home_only
      ? `<span class="home-only-tag" title="Home games only">🏠</span>` : '';
    return `<th><span class="th-job-name">${escHtml(c.job)} ${subTag}${homeOnlyBadge}</span>${certNote}</th>`;
  }).join('');

  const thead = `<thead><tr><th class="th-round">Round</th>${thCols}</tr></thead>`;

  // Body
  const tbody = `<tbody>${rounds.map(r => {
    const isConfirmed = r.status === 'confirmed';
    const tdCols = cols.map(c => {
      const k = colKey(c);
      const entries = roundEntriesLookup[String(r.round)]?.[k] || [];

      if (entries.length === 0) {
        // Check matrix.rounds for this round/job to see if it's truly unfilled
        const matRound = matrixRoundLookup[String(r.round)] || null;
        const matCell = matRound ? (matRound.cells || []).find(mc => colKey(mc) === k) : null;
        const volunteers = matCell ? (matCell.volunteers || []) : [];
        const hasUnfilled = volunteers.some(v => !v || v === '*** UNFILLED ***' || v === '-');
        if (hasUnfilled || volunteers.length === 0) {
          return `<td class="td-cell td-unfilled"><div class="td-cell-chips"><span class="jumper-chip unfilled">UNFILLED</span></div></td>`;
        }
        // Filled by name but no jumper — show name initials
        return `<td class="td-cell"><div class="td-cell-chips">${volunteers.filter(v=>v&&v!=='*** UNFILLED ***').map(v=>`<span class="jumper-chip" title="${escHtml(v)}">${escHtml(getInitials(v))}</span>`).join('')}</div></td>`;
      }

      const hasUnfilled = entries.some(e => e.slot_status === 'unfilled' || !e.jumper);
      const cellCls = hasUnfilled ? 'td-cell td-unfilled' : 'td-cell';
      const chips = entries.map(e => chipHtml(e)).join('');
      return `<td class="${cellCls}"><div class="td-cell-chips">${chips}</div></td>`;
    }).join('');

    const isByeRow = r.home_away === 'B';
    if (isByeRow) {
      return `<tr class="tr-bye">
        <td class="td-round td-round-bye" colspan="${cols.length + 1}">
          <div class="bye-row-inner">
            <span class="bye-tag">BYE</span>
            <span class="bye-date">${fmtDateShort(r.date)}</span>
            <span class="bye-status ${isConfirmed ? 'confirmed' : ''}">
              <span class="status-dot ${isConfirmed ? 'confirmed' : 'scheduled'}"></span>
              ${isConfirmed ? 'Confirmed' : 'Scheduled'}
            </span>
          </div>
        </td>
      </tr>`;
    }
    const ha = homeAwayLabel(r);
    const haBadge = ha ? `<span class="ha-badge ha-${ha.cls}">${ha.text}</span>` : '';
    return `<tr>
      <td class="td-round">
        <div class="td-round-num">${escHtml(String(r.round))}</div>
        <div class="td-round-date">${fmtDateShort(r.date)}</div>
        <div class="td-round-status ${isConfirmed ? 'confirmed' : ''}">
          <span class="status-dot ${isConfirmed ? 'confirmed' : 'scheduled'}"></span>
          ${isConfirmed ? 'Confirmed' : 'Scheduled'}
        </div>
        ${haBadge}
      </td>
      ${tdCols}
    </tr>`;
  }).join('')}</tbody>`;

  document.getElementById('matrixWrap').innerHTML =
    `<table class="matrix">${thead}${tbody}</table>`;

}

// ── Rounds list ──────────────────────────────────────────────────────────
function renderRoundsList() {
  const { rounds, roundCount } = selectRoundsViewModel();
  document.getElementById('roundsSubtitle').textContent = `${roundCount} rounds scheduled`;

  const data = getData();
  const grid = document.getElementById('roundsGrid');
  grid.innerHTML = rounds.map(r => {
    const isConfirmed = r.status === 'confirmed';
    const isBye = r.home_away === 'B';
    const roundSummary = (data.round_summary?.rounds || []).find(rr => String(rr.round) === String(r.round));
    const unfilledCount = (roundSummary?.entries || []).filter(e => e.slot_status === 'unfilled').length;
    const unfilledBadge = unfilledCount > 0
      ? `<span class="unfilled-badge">&#x26A0; ${unfilledCount} unfilled</span>` : '';
    const roundNumSpan = isBye
      ? `<span class="round-card-num bye-label">BYE</span>`
      : `<span class="round-card-num">Round ${escHtml(String(r.round))}</span>`;
    const haWrap = isBye
      ? `<span class="ha-pill bye">BYE</span>`
      : `<span onclick="event.stopPropagation()">${haTogglePill(r)}</span>`;
    const oppHtml = isBye ? '' : `<div class="round-card-opp">vs. ${escHtml(resolveOpposition(r))}</div>`;
    return `<div class="round-card" data-round="${escHtml(String(r.round))}" onclick="openRoundDetail('${r.round}')">
      <div class="round-card-head">
        ${roundNumSpan}
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
          <span class="status-pill ${isConfirmed ? 'ok' : 'warn'}" style="cursor:pointer;user-select:none" title="Click to ${isConfirmed ? 'unconfirm' : 'confirm'} this round" onclick="event.stopPropagation(); confirmRoundFromList('${escHtml(String(r.round))}');">${isConfirmed ? '&#x2713; Confirmed' : '&#x7E; Scheduled'}</span>
          ${haWrap}
        </div>
        ${unfilledBadge}
      </div>
      <div class="round-card-date">${fmtDate(r.date)}</div>
      ${oppHtml}
      <div class="round-card-loc">${escHtml(resolveLocation(r))}</div>
    </div>`;
  }).join('');

  document.getElementById('btnBackRounds').onclick = closeRoundDetail;
}

function getRoundByNum(num) {
  return selectRoundByNum(normalizeRoundRef(num));
}

function openRoundDetail(r) {
  const roundNum = normalizeRoundRef(r);
  if (!selectRoundByNum(roundNum)) return;
  dispatch({ type: 'set-round-detail', payload: { roundNum, open: true } });
  render();
}

function renderRoundDetail() {
  const viewModel = selectRoundDetailViewModel();
  if (!viewModel) return;
  const { round: r, totalRounds } = viewModel;

  document.getElementById('roundsListView').classList.add('hidden');
  document.getElementById('roundDetail').classList.add('active');

  document.getElementById('detailBreadcrumb').textContent =
    `Round ${r.round} of ${totalRounds}`;

  const dateStr = fmtDate(r.date);
  const dayStr  = r.date ? new Date(r.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' }) : '';
  document.getElementById('detailTitle').textContent = `${dayStr} ${dateStr} · vs. ${resolveOpposition(r)}`;
  document.getElementById('detailSub').textContent =
    `${resolveLocation(r)} · ${fmtTime(r.time)} bounce`;
  const _notesEl = document.getElementById('detailNotes');
  if (_notesEl) {
    _notesEl.textContent = r.extra_notes || '';
    _notesEl.classList.toggle('hidden', !r.extra_notes);
  }
  document.getElementById('detailPill').innerHTML =
    `<span class="status-pill ${r.status === 'confirmed' ? 'ok' : 'warn'}">${r.status === 'confirmed' ? 'Confirmed' : 'Scheduled'}</span>` +
    (homeAwayLabel(r) ? ` ${haTogglePill(r)}` : '');

  // Build print preview
  buildPrintPreview(r);

  // Build email text
  const plainText = buildEmailText(r);
  const cb = document.getElementById('detailCopyblock');
  cb.textContent = plainText;

  document.getElementById('btnCopyDetail').onclick = () => {
    copyToClipboard(plainText);
    cb.classList.add('flash');
    setTimeout(() => cb.classList.remove('flash'), 600);
  };
  document.getElementById('btnEditRound').onclick = () => openEditMode(r.round);

  const isConfirmed = r.status === 'confirmed';
  const confirmBtn = document.getElementById('btnConfirmRound');
  confirmBtn.textContent = isConfirmed ? 'Unconfirm Round' : 'Confirm Round';
  confirmBtn.className = isConfirmed ? 'btn' : 'btn btn-primary';
  confirmBtn.onclick = () => toggleConfirmRound(r.round);

  document.getElementById('btnReallocate').onclick = () => reallocate();
}

function toggleConfirmRound(roundNum) {
  const targetRoundNum = normalizeRoundRef(roundNum);
  dispatch({ type: 'toggle-round-confirmed', payload: { roundNum: targetRoundNum } });
  dispatch({ type: 'set-round-detail', payload: { roundNum: targetRoundNum, open: true } });
  render();
}

// US-06: confirm/unconfirm from the rounds list without opening the detail view
function confirmRoundFromList(roundNum) {
  const targetRoundNum = normalizeRoundRef(roundNum);
  dispatch({ type: 'toggle-round-confirmed', payload: { roundNum: targetRoundNum } });
  render();
}

function closeRoundDetail() {
  dispatch({ type: 'set-round-detail', payload: { roundNum: null, open: false } });
  render();
}

function buildPrintPreview(r) {
  const initials = document.getElementById('sbInitials').textContent;
  const dateStr = fmtDate(r.date);

  if (r.home_away === 'B') {
    const data = getData();
    const _ppTeamLabel = data.user_team?.team_name || 'Volunteer Roster';
    document.getElementById('printPreview').innerHTML = `
      <div class="pp-header">
        <div class="pp-club">
          <div class="pp-initials">${escHtml(initials)}</div>
          <div>
            <div class="pp-club-name">${escHtml(_ppTeamLabel)}</div>
            <div class="pp-club-sub"><span class="ha-pill bye">BYE</span> Round ${escHtml(String(r.round))}</div>
          </div>
        </div>
        <div class="pp-date-block">
          <div class="pp-date-big">${dateStr.toUpperCase()}</div>
        </div>
      </div>
      <div class="pp-bye-notice">BYE round — no game this week. No volunteers required.</div>`;
    return;
  }

  const entries = r.entries || [];
  const jobMap = new Map();
  entries.forEach(e => {
    const key = e.job_label || e.job;
    if (!jobMap.has(key)) jobMap.set(key, { col: e, slots: [] });
    jobMap.get(key).slots.push(e);
  });
  const dayStr  = r.date ? new Date(r.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' }).toUpperCase() : '';
  const monthUpper = dateStr.toUpperCase();

  let jobRows = '';
  jobMap.forEach(({ col, slots }, jobLabel) => {
    const certNote = (col.certifications && col.certifications.length)
      ? `Bring ${col.certifications.join(', ')} card` : '';
    const slotCols = slots.map(e => {
      const roundEsc   = escHtml(String(r.round));
      const jobEsc     = escHtml(e.job || col.job || '');
      const subteamEsc = escHtml(e.subteam || 'shared');
      const slotIdx    = e.slot_index ?? 0;
      const swapOnclick = `openVolSwap('${roundEsc}','${jobEsc}','${subteamEsc}',${slotIdx})`;
      if (e.slot_status === 'unfilled' || !e.jumper) {
        return { volHtml: '', swapHtml: `<button class="vol-swap-btn unfilled" onclick="${swapOnclick}" title="Click to assign">⚠ unfilled</button>` };
      }
      const manualBadge = e.slot_status === 'manual' ? '<span class="manual-badge">M</span>' : '';
      const popupOnclick = ` onclick="showVolPopup('${escHtml(String(e.jumper))}')"`;
      return {
        volHtml: `<span style="display:inline-block;margin:0 6px 0 0;cursor:pointer"${popupOnclick}>
          <span class="pp-jumper-big">#${escHtml(e.jumper)}</span>
          <span class="pp-vol-name">${escHtml(resolveVolunteerName(e))}${manualBadge}</span>
        </span>`,
        swapHtml: `<button class="vol-swap-btn vol-swap-btn-small" onclick="${swapOnclick}" title="Swap volunteer">&#8644;</button>`,
      };
    });

    jobRows += `<div class="pp-job-row">
      <div class="pp-job-name">${escHtml(jobLabel)}${certNote ? `<br><span class="pp-job-note">${escHtml(certNote)}</span>` : ''}</div>
      <div class="pp-right-group">
        <div class="pp-vol-col">${slotCols.map(s => `<span class="pp-slot">${s.swapHtml}${s.volHtml}</span>`).join('')}</div>
      </div>
    </div>`;
  });

  const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

  const data = getData();
  const _ppTeamLabel = data.user_team?.team_name || 'Volunteer Roster';
  const _ppHaText    = r.home_away === 'a' ? 'AWAY' : r.home_away === 'h' ? 'HOME' : '';
  const _ppHaHtml    = _ppHaText
    ? `<span class="ha-pill ${r.home_away === 'a' ? 'away' : 'home'}" style="margin-right:6px;vertical-align:middle">${_ppHaText}</span>`
    : '';

  const _printFooter = data.ui_preferences?.print_footer || '† Stick this to the canteen wall';
  document.getElementById('printPreview').innerHTML = `
    <div class="pp-header">
      <div class="pp-club">
        <div class="pp-initials">${escHtml(initials)}</div>
        <div>
          <div class="pp-club-name">${escHtml(_ppTeamLabel)}</div>
          <div class="pp-club-sub">${_ppHaHtml}vs. ${escHtml(resolveOpposition(r))} · Round ${escHtml(String(r.round))}</div>
        </div>
      </div>
      <div class="pp-date-block">
        <div class="pp-date-big">${dayStr} ${monthUpper}</div>
        <div class="pp-date-sub">${escHtml(resolveLocation(r))} · ${fmtTime(r.time)}</div>
      </div>
    </div>
    ${r.extra_notes ? `<div class="pp-notes">${escHtml(r.extra_notes)}</div>` : ''}
    <div class="pp-job-list">${jobRows}</div>
    <div class="pp-footer">
      <span>Generated ${today} · roster-spa</span>
      <span>${escHtml(_printFooter)}</span>
    </div>`;
}

function buildEmailText(r) {
  if (r.home_away === 'B') {
    return `Round ${r.round} · ${fmtDate(r.date)} · BYE\n\nNo game this round. No volunteers required.`;
  }

  const _GROUPED = { 'Umpire Escort': 'Umpire Escorts', 'Goal Umpire': 'Goal Umpires' };
  const entries = r.entries || [];
  const jobMap = new Map();
  entries.forEach(e => {
    const key = _GROUPED[e.job] || e.job_label || e.job || '(unknown job)';
    if (!jobMap.has(key)) jobMap.set(key, []);
    jobMap.get(key).push(e);
  });

  const dateStr = fmtDate(r.date);
  const _haText = r.home_away === 'h' ? 'HOME' : r.home_away === 'a' ? 'AWAY' : '';
  const header  = `R${r.round} · vs ${resolveOpposition(r)}${_haText ? ' · ' + _haText : ''} · (${(r.status || '').toLowerCase()})`;
  const dateLine = `${dateStr}${r.time ? ' ' + fmtTime(r.time) + ' bounce' : ''}`;
  const locLine  = resolveLocation(r) || null;

  const lines = [];
  jobMap.forEach((slots, jobLabel) => {
    lines.push(jobLabel + ':');
    slots.forEach(e => {
      if (e.slot_status === 'unfilled' || !e.jumper) {
        lines.push('  *** UNFILLED ***');
      } else {
        const sub = (e.subteam && e.subteam !== 'shared') ? ` [${e.subteam}]` : '';
        lines.push(`  #${e.jumper} ${resolveVolunteerName(e)}${sub}`);
      }
    });
  });

  const preamble = [
    header,
    dateLine,
    ...(locLine  ? [locLine]  : []),
    '',
    ...(r.extra_notes ? [r.extra_notes, ''] : []),
  ];
  return [...preamble, ...lines].join('\n');
}

function copyRoundText(r) {
  const text = buildEmailText(r);
  copyToClipboard(text);
}

// ── Volunteers ────────────────────────────────────────────────────────────
function renderVolunteers(filter = document.getElementById('volSearch')?.value || '') {
  const viewModel = selectVolunteersViewModel(filter);
  if (!viewModel) return;

  document.getElementById('volSubtitle').textContent =
    `${viewModel.eligibleCount} active · names live in your browser only`;

  const tbody = document.getElementById('volTableBody');
  tbody.innerHTML = viewModel.filtered.map(v => {
    const certs  = (v.certifications || []).map(c => `<span class="cert-chip">${escHtml(c)}</span>`).join('');
    const prefs  = (v.preferred_jobs || []).map(j => `<span class="vtag vtag-pref">★ ${escHtml(j)}</span>`).join('');
    const avoids = (v.avoid_jobs     || []).map(j => `<span class="vtag vtag-avoid">✕ ${escHtml(j)}</span>`).join('');
    const isExpanded = _expandedVols.has(v.jumper);
    const expandIcon = isExpanded ? '&#9650;' : '&#9660;';

    const mainRow = `<tr>
      <td><span class="jumper-chip">#${escHtml(v.jumper)}</span></td>
      <td>
        <div class="vol-name-main vol-expandable"
          onclick="_expandedVols.has('${escHtml(v.jumper)}') ? _expandedVols.delete('${escHtml(v.jumper)}') : _expandedVols.add('${escHtml(v.jumper)}'); renderVolunteers()">
          ${escHtml(v.volunteer)} <span class="vol-expand-icon">${expandIcon}</span>
        </div>
        <div class="vol-name-sub">
          <span class="vol-browser-badge">🔒 in browser</span>
          ${v.player_name ? escHtml(v.player_name) : ''}
        </div>
      </td>
      <td><div class="vol-chips">${certs || '<span style="color:var(--muted);font-size:10px">—</span>'}</div></td>
      <td><div class="vol-chips">${prefs  || '<span style="color:var(--muted)">—</span>'}</div></td>
      <td><div class="vol-chips">${avoids || '<span style="color:var(--muted)">—</span>'}</div></td>
      <td>
        <div class="vol-shifts-val">${v.total_assignments ?? 0} <span class="vol-shifts-ideal">/ ${viewModel.ideal}</span></div>
        <div class="vol-shifts-split">
          <span class="vol-conf">${v.confirmed_assignments} confirmed</span>
          <span class="vol-sched">${v.scheduled_assignments} scheduled</span>
        </div>
      </td>
    </tr>`;

    if (!isExpanded) return mainRow;

    const assignChips = v.assignments.map(a => ({
      round: Number(a.round),
      html: (() => {
        const repeatAttr = a.consecutive_repeat ? ` title="${escHtml(a.job)} — consecutive repeat"` : '';
        return `<span class="vol-assign-chip ${escHtml(a.status)}${a.consecutive_repeat ? ' repeat' : ''}"${repeatAttr}>Rd ${escHtml(String(a.round))} · ${escHtml(a.job)}${a.consecutive_repeat ? ' ⚠' : ''}</span>`;
      })(),
    }));
    const outChips = (v.outRounds || []).map(rnd => ({
      round: Number(rnd),
      html: `<span class="vol-assign-chip out" title="Player absent this round">Rd ${escHtml(rnd)} · OUT</span>`,
    }));
    const allChips = [...assignChips, ...outChips]
      .sort((a, b) => a.round - b.round)
      .map(c => c.html)
      .join('');
    const timelineRow = `<tr class="vol-timeline-row">
      <td colspan="6">
        <div class="vol-timeline">${allChips || '<span style="color:var(--muted);font-size:11px">No assignments yet</span>'}</div>
      </td>
    </tr>`;

    return mainRow + timelineRow;
  }).join('');

  // Ineligible
  const inelEl = document.getElementById('ineligibleSection');
  if (viewModel.ineligible.length > 0) {
    inelEl.innerHTML = `
      <p class="section-label" style="margin-top:24px">Ineligible Volunteers</p>
      <div class="vol-table-wrap">
        <table class="vol-table">
          <thead><tr><th>Jumper</th><th>Name (Local)</th></tr></thead>
          <tbody>${viewModel.ineligible.map(v => `
            <tr>
              <td><span class="jumper-chip" style="opacity:.6">#${escHtml(v.jumper)}</span></td>
              <td>
                <div class="vol-name-main" style="opacity:.7">${escHtml(v.volunteer)}</div>
                <div class="vol-name-sub"><span class="vol-browser-badge">🔒 in browser</span> ${escHtml(v.player_name || '')}</div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } else {
    inelEl.innerHTML = '';
  }
}

document.getElementById('volSearch').addEventListener('input', e => {
  try { renderVolunteers(e.target.value); } catch(err) {}
});

// ── Balance ───────────────────────────────────────────────────────────────
function renderBalance() {
  const viewModel = selectBalanceViewModel();
  if (!viewModel) return;
  document.getElementById('idealCount').textContent = viewModel.ideal;

  const sortedRows = viewModel.rows.slice().sort((a, b) => {
    if (_balanceSort === 'name')        return (a.volunteer || '').localeCompare(b.volunteer || '');
    if (_balanceSort === 'least-loaded') return a.delta - b.delta;
    return b.delta - a.delta; // 'most-loaded' default
  });

  const sortHtml = `<div class="balance-sort">
    <button onclick="_balanceSort='name'; renderBalance()" class="${_balanceSort === 'name' ? 'active' : ''}">Name A–Z</button>
    <button onclick="_balanceSort='most-loaded'; renderBalance()" class="${_balanceSort === 'most-loaded' ? 'active' : ''}">Most loaded</button>
    <button onclick="_balanceSort='least-loaded'; renderBalance()" class="${_balanceSort === 'least-loaded' ? 'active' : ''}">Least loaded</button>
  </div>`;

  const rowsHtml = sortedRows.map(entry => {
    const barCls   = entry.delta > 0 ? 'over'  : entry.delta < 0 ? 'under' : '';
    const deltaCls = entry.delta > 0 ? 'pos'   : entry.delta < 0 ? 'neg'   : '';
    const deltaStr = entry.delta > 0 ? `+${entry.delta.toFixed(1)}` : entry.delta.toFixed(1);

    return `<div class="balance-row">
      <span class="balance-name" title="${escHtml(entry.volunteer)}">${escHtml(entry.volunteer)}</span>
      <div class="balance-bar-wrap">
        <div class="balance-bar ${barCls}" style="width:${entry.barPct.toFixed(1)}%"></div>
        <div class="balance-ideal" style="left:${viewModel.idealPct.toFixed(1)}%"></div>
      </div>
      <div class="balance-meta">
        <span class="balance-count">${entry.count}</span>
        <span class="balance-delta ${deltaCls}">${deltaStr}</span>
      </div>
    </div>`;
  }).join('');

  document.getElementById('balanceList').innerHTML = sortHtml + rowsHtml;
}

// ── Constraints ───────────────────────────────────────────────────────────
function renderConstraints() {
  const viewModel = selectConstraintsViewModel();
  if (!viewModel) return;
  document.getElementById('constraintSubtitle').textContent = `${viewModel.count} constraint${viewModel.count !== 1 ? 's' : ''} defined`;

  const tbody = document.getElementById('constraintBody');
  if (viewModel.count === 0) {
    tbody.innerHTML = `<tr><td colspan="2" style="color:var(--muted);font-size:12px;font-style:italic;padding:16px 14px">No avoid-job constraints defined.</td></tr>`;
    return;
  }

  tbody.innerHTML = viewModel.avoids.map(c => {
    const jobs = (c.jobs || []).map(j => `<span class="vtag vtag-avoid">✕ ${escHtml(j)}</span>`).join('');
    return `<tr>
      <td style="font-size:12px;font-weight:500;color:var(--text2)">${escHtml(c.volunteer)}</td>
      <td><div class="vol-chips">${jobs}</div></td>
    </tr>`;
  }).join('');
}

// ── Settings ──────────────────────────────────────────────────────────────
function renderSettings() {
  const viewModel = selectSettingsViewModel();
  if (!viewModel) return;

  const _sel = document.getElementById('settingsClub');
  if (_sel) {
    _renderingSettings = true;
    try {
      _sel.innerHTML = '<option value="">— select club —</option>' +
        viewModel.clubs.map(c =>
          `<option value="${escHtml(c.club_id)}"${
            viewModel.selectedClubId === c.club_id ? ' selected' : ''
          }>${escHtml(c.name)}</option>`
        ).join('');
    } finally {
      _renderingSettings = false;
    }
  }
  const _tnInput = document.getElementById('settingsTeamName');
  if (_tnInput && _tnInput.value !== viewModel.teamName) _tnInput.value = viewModel.teamName;

  const _pfInput = document.getElementById('printFooterInput');
  if (_pfInput && _pfInput.value !== viewModel.printFooter) _pfInput.value = viewModel.printFooter;

  const _sdEl = document.getElementById('screenDims');
  if (_sdEl) _sdEl.textContent = `${window.innerWidth} × ${window.innerHeight}px`;
}

// ── Volunteer summary popup (US-08) ──────────────────────────────────────
function showVolPopup(jumper) {
  const data = getData();
  const vol = (data.volunteers?.eligible || []).find(v => String(v.jumper) === String(jumper));
  if (!vol) return;
  const bal = (data.balance?.entries || []).find(b => b.volunteer === vol.volunteer);
  const delta = bal?.delta ?? 0;
  const deltaStr = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
  const certs  = (vol.certifications  || []).map(c => `<span class="cert-chip">${escHtml(c)}</span>`).join('') || '<span style="color:var(--muted)">—</span>';
  const prefs  = (vol.preferred_jobs  || []).map(j => `<span class="vtag vtag-pref">★ ${escHtml(j)}</span>`).join('') || '<span style="color:var(--muted)">—</span>';
  const avoids = (vol.avoid_jobs      || []).map(j => `<span class="vtag vtag-avoid">✕ ${escHtml(j)}</span>`).join('') || '<span style="color:var(--muted)">—</span>';

  document.getElementById('volPopupContent').innerHTML = `
    <div class="vol-popup-name"><span class="jumper-chip">#${escHtml(String(vol.jumper))}</span> ${escHtml(vol.volunteer)}</div>
    <div class="vol-popup-row"><span class="vol-popup-label">Assignments:</span> ${vol.total_assignments ?? 0} total (${deltaStr} vs ideal)</div>
    <div class="vol-popup-row"><span class="vol-popup-label">Confirmed:</span> ${vol.confirmed_assignments ?? 0}&nbsp;&nbsp;<span class="vol-popup-label">Scheduled:</span> ${vol.scheduled_assignments ?? 0}</div>
    <div class="vol-popup-row"><span class="vol-popup-label">Certs:</span> ${certs}</div>
    <div class="vol-popup-row"><span class="vol-popup-label">Prefers:</span> ${prefs}</div>
    <div class="vol-popup-row"><span class="vol-popup-label">Avoids:</span> ${avoids}</div>`;
  document.getElementById('volPopup').classList.remove('hidden');
  document.getElementById('volPopupBackdrop').classList.remove('hidden');
}

function closeVolPopup() {
  document.getElementById('volPopup').classList.add('hidden');
  document.getElementById('volPopupBackdrop').classList.add('hidden');
}

// ── Team Splits panel (TSP-001..TSP-013) ──────────────────────────────────
function subteamLabel(subteam) {
  if (subteam === 'A') return 'Team A';
  if (subteam === 'B') return 'Team B';
  if (subteam === 'shared') return 'Shared';
  return subteam.charAt(0).toUpperCase() + subteam.slice(1);
}

// ── Touch drag-and-drop for Team Splits (mobile) ─────────────────────────────
// HTML5 drag events are silently discarded on touch devices. These handlers
// replicate the same set-split dispatch using TouchEvent sequences.
let _tspDrag = null;

function tspTouchStart(el, e) {
  if (e.touches.length !== 1) return;
  const touch = e.touches[0];
  const rect  = el.getBoundingClientRect();

  const ghost = el.cloneNode(true);
  Object.assign(ghost.style, {
    position: 'fixed', zIndex: '9999', pointerEvents: 'none',
    opacity: '0.85', width: rect.width + 'px',
    left: rect.left + 'px', top: rect.top + 'px',
    borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.25)',
    background: 'var(--bg, #fff)',
  });
  document.body.appendChild(ghost);

  _tspDrag = {
    jumper:      el.dataset.jumper,
    fromSubteam: el.closest('[data-subteam]')?.dataset.subteam || '',
    ghost,
    ox: touch.clientX - rect.left,
    oy: touch.clientY - rect.top,
  };
  e.preventDefault();
}

function _tspTouchMove(e) {
  if (!_tspDrag || e.touches.length !== 1) return;
  const t = e.touches[0];
  const { ghost, ox, oy } = _tspDrag;
  ghost.style.left = (t.clientX - ox) + 'px';
  ghost.style.top  = (t.clientY - oy) + 'px';

  // Highlight the drop target under the finger
  ghost.style.visibility = 'hidden';
  const under = document.elementFromPoint(t.clientX, t.clientY);
  ghost.style.visibility = '';
  const targetGroup = under?.closest('#teamSplitsContent [data-subteam]');
  document.querySelectorAll('#teamSplitsContent .tsp-group').forEach(g => {
    g.classList.toggle('tsp-drop-target',
      g === targetGroup && targetGroup.dataset.subteam !== _tspDrag.fromSubteam);
  });
  e.preventDefault();
}

function _tspTouchEnd(e) {
  if (!_tspDrag) return;
  const t = e.changedTouches[0];
  const { ghost, jumper, fromSubteam } = _tspDrag;

  ghost.remove();
  document.querySelectorAll('#teamSplitsContent .tsp-group').forEach(g => g.classList.remove('tsp-drop-target'));

  const under = document.elementFromPoint(t.clientX, t.clientY);
  const targetGroup = under?.closest('#teamSplitsContent [data-subteam]');
  const toSubteam = targetGroup?.dataset.subteam;
  _tspDrag = null;

  if (toSubteam && toSubteam !== fromSubteam) {
    const rnd = document.getElementById('teamSplitsRoundSelect')?.value || '';
    if (rnd && jumper) {
      dispatch({ type: 'set-split', payload: { round: rnd, jumper, subteam: toSubteam } });
      render();
    }
  }
}

function renderTeamSplits() {
  const content = document.getElementById('teamSplitsContent');
  const select = document.getElementById('teamSplitsRoundSelect');
  if (!content || !select) return;

  const state = SPA_STORE.getState();
  const { ui } = state;
  if (ui.activePanel !== 'team-splits') return;

  const data = getData();
  const allRounds = (data?.round_summary?.rounds || [])
    .filter(r => r.home_away !== 'B')
    .sort((a, b) => Number(a.round) - Number(b.round));

  // Populate selector
  select.innerHTML = allRounds.map(r =>
    `<option value="${escHtml(String(r.round))}">Round ${escHtml(String(r.round))}</option>`
  ).join('');
  select.disabled = allRounds.length === 0;

  if (allRounds.length === 0) {
    content.innerHTML = '<div class="tsp-empty">No rounds available.</div>';
    return;
  }

  // Resolve which round to show — default to first scheduled (feature round), then last
  const featureRound = allRounds.find(r => r.status !== 'confirmed') || allRounds[allRounds.length - 1];
  const activeRound = ui.teamSplitsRound && allRounds.some(r => String(r.round) === String(ui.teamSplitsRound))
    ? String(ui.teamSplitsRound)
    : String(featureRound.round);
  select.value = activeRound;

  const players = (data?.reference_data?.players || []);
  if (players.length === 0) {
    content.innerHTML = '<div class="tsp-empty">No player data — run the scheduler first to generate splits.</div>';
    return;
  }

  const splits = (data?.reference_data?.splits || []);
  const absences = (data?.reference_data?.absences || []);

  const splitMap = {};
  for (const s of splits) splitMap[`${s.round}|${s.jumper}`] = s.subteam;

  const absenceSet = new Set(
    absences.filter(a => String(a.round) === activeRound).map(a => String(a.jumper))
  );

  const sortedPlayers = [...players].sort((a, b) => Number(a.jumper) - Number(b.jumper));

  // Group players by effective subteam
  const groups = {};
  for (const p of sortedPlayers) {
    const subteam = splitMap[`${activeRound}|${p.jumper}`] || p.subteam || 'A';
    if (!groups[subteam]) groups[subteam] = [];
    groups[subteam].push(p);
  }

  const groupOrder = Object.keys(groups).sort((a, b) => {
    const order = ['A', 'B', 'shared'];
    const ai = order.indexOf(a); const bi = order.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  const currentRound = String(select.value || (allRounds[0] && allRounds[0].round) || '');
  content.innerHTML = groupOrder.map(subteam => {
    const rows = groups[subteam].map(p => {
      const absent = absenceSet.has(String(p.jumper));
      const absentBadge = absent ? ' <span class="tsp-out-badge">OUT</span>' : '';
      const jEsc = escHtml(String(p.jumper));
      const stEsc = escHtml(subteam);
      return `<div class="tsp-player-row${absent ? ' tsp-absent' : ''}" data-jumper="${jEsc}"
        draggable="true"
        ondragstart="event.dataTransfer.setData('text/plain',JSON.stringify({jumper:'${jEsc}',fromSubteam:'${stEsc}'}));event.dataTransfer.effectAllowed='move'"
        ontouchstart="tspTouchStart(this,event)">
        <span class="jumper-chip">#${escHtml(String(p.jumper))}</span>
        <span class="tsp-player-name">${escHtml(p.player_name || '')}</span>${absentBadge}
      </div>`;
    }).join('');
    const stEsc = escHtml(subteam);
    const playerCount = groups[subteam].length;
    const countLabel = `${playerCount} player${playerCount !== 1 ? 's' : ''}`;
    return `<div class="tsp-group" data-subteam="${stEsc}"
      ondragover="event.preventDefault();event.dataTransfer.dropEffect='move';this.classList.add('tsp-drop-target')"
      ondragleave="this.classList.remove('tsp-drop-target')"
      ondrop="(function(el,ev){ev.preventDefault();el.classList.remove('tsp-drop-target');try{var d=JSON.parse(ev.dataTransfer.getData('text/plain'));var toSt=el.dataset.subteam;if(d.fromSubteam===toSt)return;var roundSel=document.getElementById('teamSplitsRoundSelect');var rnd=roundSel?roundSel.value:'';if(!rnd)return;dispatch({type:'set-split',payload:{round:rnd,jumper:d.jumper,subteam:toSt}});render();}catch(e){console.error('tsp-drop',e);}})(this,event)">
      <div class="tsp-group-label">${escHtml(subteamLabel(subteam))}</div>
      ${rows}
      <div class="tsp-group-summary">${countLabel}</div>
    </div>`;
  }).join('');
}

function setupTeamSplits() {
  const select = document.getElementById('teamSplitsRoundSelect');
  if (select) {
    select.addEventListener('change', e => {
      dispatch({ type: 'set-team-splits-round', payload: { roundNum: e.target.value } });
      render();
    });
  }
  const btnSplits = document.getElementById('btnViewTeamSplits');
  if (btnSplits) {
    btnSplits.addEventListener('click', () => {
      const roundNum = getState().ui.selectedRound;
      if (roundNum != null) {
        dispatch({ type: 'set-team-splits-round', payload: { roundNum } });
      }
      switchPanel('team-splits');
    });
  }

  // Touch drag-and-drop: document-level listeners so events follow the finger
  // even when it moves outside the originating element.
  document.addEventListener('touchmove', _tspTouchMove, { passive: false });
  document.addEventListener('touchend',  _tspTouchEnd);
}

// ── Nav ───────────────────────────────────────────────────────────────────
function setupNav() {
  const navToggle = document.getElementById('sbNavToggle');
  if (navToggle) {
    navToggle.addEventListener('click', () => {
      _mobileNavOpen = !_mobileNavOpen;
      if (_mobileNavOpen) {
        markMobileNavHintSeen();
      }
      render();
    });
  }

  document.querySelectorAll('.sb-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isIphoneNavViewport()) {
        _mobileNavOpen = false;
        markMobileNavHintSeen();
      }
      try { switchPanel(btn.dataset.panel); } catch(err) {}
    });
  });
}

function setupSettings() {
  const clubSel  = document.getElementById('settingsClub');
  const nameInp  = document.getElementById('settingsTeamName');
  const footerInp = document.getElementById('printFooterInput');
  if (clubSel)   clubSel.addEventListener('change', saveUserTeam);
  if (nameInp)   nameInp.addEventListener('input', saveUserTeam);
  if (footerInp) footerInp.addEventListener('input', () => {
    dispatch({ type: 'set-ui-preference', payload: { key: 'print_footer', value: footerInp.value } });
    render();
  });

  // USP-030 / USP-031: EXPORT TM DATA (works in both admin and user builds)
  const exportBtn = document.getElementById('btnExportTmData');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportTmData);
  }

  // IMPORT TM DATA: file-picker import from settings panel
  const importFileInput = document.getElementById('importTmDataFile');
  if (importFileInput) {
    importFileInput.addEventListener('change', handleTmDataImport);
  }
}

function exportTmData() {
  const data = getData();
  if (!data) return;

  // Build roster for USER_SPA name resolution (OWDB: one source of truth).
  // Prefer existing roster; construct from volunteers.eligible when absent.
  const existingRoster = data.user_team?.roster || [];
  const roster = existingRoster.length > 0
    ? existingRoster
    : (data.volunteers?.eligible || []).map(v => ({
        jumper: String(v.jumper),
        name: v.volunteer || '',
      }));

  const snapshot = {
    user_team: { ...(data.user_team || {}), roster },
    round_summary: data.round_summary || { rounds: [] },
    reference_data: data.reference_data || {},
    volunteers:     data.volunteers    || { eligible: [], ineligible: [] },
    balance:        data.balance       || null,
    constraints:    data.constraints   || {},
    matrix:         data.matrix        || null,
    season_overview: data.season_overview || {},
    _exported_at: new Date().toISOString(),
    _schema_version: 1,
  };
  const teamSlug = (data.user_team?.team_name || 'team')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `tm-data-${teamSlug}-${dateStr}.json`;
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function handleTmDataImport() {
  const input = document.getElementById('importTmDataFile');
  const errEl = document.getElementById('importTmDataError');
  const file = input?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    let parsed;
    try {
      try {
        parsed = JSON.parse(e.target.result);
      } catch (_) {
        throw new Error('Could not parse file — make sure it is a valid tm-data JSON export');
      }
      if (!parsed.user_team) {
        throw new Error('Invalid file — missing required key: user_team');
      }
      if (!parsed.round_summary)  parsed.round_summary  = { rounds: [] };
      if (!parsed.reference_data) parsed.reference_data = {};

      // Ensure user_team.roster is populated for USER_SPA name resolution.
      // Old exports or admin exports may have volunteers but no roster.
      if (!parsed.user_team.roster || parsed.user_team.roster.length === 0) {
        parsed.user_team.roster = (parsed.volunteers?.eligible || []).map(v => ({
          jumper: String(v.jumper),
          name: v.volunteer || '',
        }));
      }

      if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }

      if (_idbAvailable && _idb && _idb.saveSnapshot) {
        await _idb.saveSnapshot(parsed);
      }
      dispatch({ type: 'load-report', payload: { filename: 'from-import', report: parsed } });
      render();
    } catch (err) {
      if (errEl) { errEl.textContent = err.message; errEl.style.display = ''; }
    }
    if (input) input.value = '';
  };
  reader.onerror = () => {
    if (errEl) { errEl.textContent = 'Could not read file'; errEl.style.display = ''; }
    if (input) input.value = '';
  };
  reader.readAsText(file);
}

function switchPanel(name) {
  dispatch({ type: 'set-active-panel', payload: { panel: name } });
  render();

  // Scroll content to top
  document.getElementById('content').scrollTop = 0;

  // Load data records when the Data panel is opened
  if (name === 'data') {
    loadAllDataRecords().catch(err => console.error('[roster-spa] loadAllDataRecords:', err));
  }
}

// ── Skin switcher ─────────────────────────────────────────────────────────
function setSkin(name) {
  document.body.setAttribute('data-skin', name);
  document.querySelectorAll('.skin-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.skin === name)
  );
  localStorage.setItem('roster-skin', name);
}

function restoreSkin() {
  const saved = localStorage.getItem('roster-skin');
  if (saved && ['dark', 'forest', 'sunset', 'nautical', 'cobalt', 'night-vision'].includes(saved)) setSkin(saved);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function colKey(c) {
  return `${c.job}|||${c.subteam}`;
}

function buildEntriesMap(entries) {
  const map = {};
  entries.forEach(e => {
    const k = colKey(e);
    if (!map[k]) map[k] = [];
    map[k].push(e);
  });
  return map;
}

function dashChipHtml(e) {
  if (e.slot_status === 'unfilled' || !e.jumper) {
    return `<span class="jumper-chip unfilled">⚠ unfilled</span>`;
  }
  const name = resolveVolunteerName(e);
  const num  = `<span class="dash-chip-num">#${escHtml(e.jumper)}</span> `;
  return `<span class="jumper-chip dash-chip">${num}${escHtml(name)}</span>`;
}

function chipHtml(e) {
  if (e.slot_status === 'unfilled' || !e.jumper) {
    return `<span class="jumper-chip unfilled">⚠ unfilled</span>`;
  }
  const name = resolveVolunteerName(e);
  return `<span class="jumper-chip" title="${escHtml(name)}">#${escHtml(e.jumper)}</span><span>${escHtml(name)}</span>`;
}

function getVolJumper(name) {
  const data = getData();
  if (!data) return '';
  const all = (data.volunteers?.eligible || []).concat(data.volunteers?.ineligible || []);
  const v = all.find(v => v.volunteer === name);
  if (v) return v.jumper;
  // USER_SPA: fall back to user_team roster
  const member = (data.user_team?.roster || []).find(m => m.name === name);
  return member ? String(member.jumper || '') : '';
}

function getVolunteerByJumper(jumper) {
  const data = getData();
  if (!data || !jumper) return '';
  // Admin/server data model: volunteers list
  const all = (data.volunteers?.eligible || []).concat(data.volunteers?.ineligible || []);
  const v = all.find(v => String(v.jumper) === String(jumper));
  if (v) return v.volunteer || '';
  // USER_SPA data model: user_team roster
  const member = (data.user_team?.roster || []).find(m => String(m.jumper) === String(jumper));
  return member ? (member.name || '') : '';
}

function resolveVolunteerName(entry) {
  if (!entry) return '';
  if (entry.jumper) return getVolunteerByJumper(entry.jumper) || entry.volunteer || '';
  return entry.volunteer || '';
}

function resolveLocation(round) {
  if (!round) return '—';
  if (round.location_id) {
    const data = getData();
    const loc = (data?.reference_data?.locations || []).find(
      l => String(l.location_id) === String(round.location_id)
    );
    if (loc) return loc.display_name || loc.name || round.location || '—';
  }
  return round.location || '—';
}

function resolveOpposition(round) {
  if (!round) return '—';
  if (round.opposition_club_id) {
    const data = getData();
    const club = (data?.reference_data?.clubs || []).find(
      c => String(c.club_id) === String(round.opposition_club_id)
    );
    if (club) return club.name || round.opposition || '—';
  }
  return round.opposition || '—';
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function fmtTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function homeAwayLabel(r) {
  if (r.home_away === 'h') return { text: 'HOME', cls: 'home' };
  if (r.home_away === 'a') return { text: 'AWAY', cls: 'away' };
  if (r.home_away === 'B') return { text: 'BYE',  cls: 'bye'  };
  return null;
}

// Returns an interactive HOME/AWAY pill (role=button, onclick) or a static BYE pill.
function haTogglePill(r) {
  const label = homeAwayLabel(r);
  if (!label) return '';
  if (r.home_away === 'B') {
    return `<span class="ha-pill bye">${label.text}</span>`;
  }
  return `<span class="ha-pill ${label.cls}" role="button" style="cursor:pointer;user-select:none" onclick="toggleHomeAway('${escHtml(String(r.round))}')">${label.text}</span>`;
}

function toggleHomeAway(roundNum) {
  const r = getRoundByNum(roundNum);
  if (!r || r.home_away === 'B') return;

  const data = getData();
  const preSnapshot = { home_away: r.home_away, location_id: r.location_id || '' };

  const newHa = r.home_away === 'h' ? 'a' : 'h';

  // opposition_club_id may live only in reference_data.rounds for unedited rounds
  const refRound = (data?.reference_data?.rounds || []).find(rr => String(rr.round) === String(roundNum));
  const oppositionClubId = String(r.opposition_club_id || refRound?.opposition_club_id || '');
  const userClubId = String(data?.user_team?.club_id || '');

  const locs = data?.reference_data?.locations || [];
  const newLocObj = newHa === 'a'
    ? locs.find(l => l.club_id === oppositionClubId) || null
    : locs.find(l => l.club_id === userClubId) || null;

  const updates = {
    home_away: newHa,
    location_id: newLocObj ? newLocObj.location_id : preSnapshot.location_id,
  };

  dispatch({ type: 'save-round-edit', payload: { roundNum: String(roundNum), updates } });

  // If the edit form is open, do a targeted DOM update only — no full render, no PUT
  const editForm = document.getElementById('roundEditForm');
  const inEditMode = editForm && editForm.style.display !== 'none' && editForm.innerHTML.length > 0;

  if (inEditMode) {
    const updatedR = getRoundByNum(roundNum);
    const haRow = document.getElementById('editHaRow');
    if (haRow) {
      haRow.innerHTML = `<span class="edit-form-label">Home/Away</span>${haTogglePill(updatedR)}`;
    }
    const locRow = document.getElementById('editLocationRow');
    if (locRow) {
      const targetClubId = newHa === 'a' ? oppositionClubId : userClubId;
      const newLocs = _editLocationsForClub(targetClubId);
      locRow.innerHTML = `<span class="edit-form-label">Location</span>${_locationField(newLocs, updates.location)}`;
    }
    return;
  }

  render();

  if (isAdmin()) {
    fetch(`/api/rounds/${encodeURIComponent(String(roundNum))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        home_away:          newHa,
        location_id:        updates.location_id,
        date:               r.date || '',
        opposition_club_id: oppositionClubId,
        time:               r.time || '',
      }),
    }).then(res => {
      if (!res.ok) {
        dispatch({ type: 'save-round-edit', payload: { roundNum: String(roundNum), updates: preSnapshot } });
        render();
        showSnapshotToast('Toggle failed: ' + res.status, 'err');
      }
    }).catch(() => {
      dispatch({ type: 'save-round-edit', payload: { roundNum: String(roundNum), updates: preSnapshot } });
      render();
      showSnapshotToast('Toggle failed: network error', 'err');
    });
  }
}

function saveUserTeam() {
  if (_renderingSettings) return;
  const data = getData();
  if (!data) return;
  const clubId   = document.getElementById('settingsClub')?.value || '';
  const teamName = document.getElementById('settingsTeamName')?.value || '';
  dispatch({
    type: 'set-user-team',
    payload: { clubId, teamName },
  });
  render();
  _writeMetadata();
}

function _writeMetadata() {
  if (!isAdmin()) return;
  const data = getData();
  if (!data) return;
  const body = {
    user_team: data.user_team || { club_id: '', team_name: '' },
    ui_preferences: data.ui_preferences || {},
  };
  fetch('/api/metadata', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ── Lineup (splits editor) ───────────────────────────────────────────────
function renderLineup() {
  const container = document.getElementById('lineupMatrix');
  if (!container) return;
  const data = getData();
  if (!data) {
    container.innerHTML = '<div class="lineup-empty">No roster loaded — select a file to view the lineup.</div>';
    return;
  }

  const splits = (data.reference_data && data.reference_data.splits) || [];
  const players = (data.reference_data && data.reference_data.players) || [];
  const rounds = ((data.round_summary && data.round_summary.rounds) || [])
    .filter(r => r.home_away !== 'B')
    .sort((a, b) => Number(a.round) - Number(b.round));

  if (players.length === 0) {
    container.innerHTML = '<div class="lineup-empty">No player data available. Run the scheduler to generate player data.</div>';
    return;
  }

  const splitMap = {};
  for (const s of splits) splitMap[`${s.round}|${s.jumper}`] = s.subteam;

  const absenceSet = new Set(
    ((data.reference_data && data.reference_data.absences) || [])
      .map(a => `${a.round}|${a.jumper}`)
  );

  const sortedPlayers = [...players].sort((a, b) => Number(a.jumper) - Number(b.jumper));

  const colHeaders = rounds.map(r => {
    const haClass = r.home_away === 'h' ? 'home' : r.home_away === 'a' ? 'away' : '';
    const haLabel = r.home_away === 'h' ? 'HOME' : r.home_away === 'a' ? 'AWAY' : '';
    return `<th class="lineup-th-round" title="${escHtml(resolveOpposition(r))}">
      <div>Rd ${escHtml(String(r.round))}</div>
      ${haLabel ? `<div class="ha-pill ${haClass}" style="font-size:9px;padding:1px 3px;">${haLabel}</div>` : ''}
    </th>`;
  }).join('');

  const bodyRows = sortedPlayers.map(p => {
    const cells = rounds.map(r => {
      const key = `${r.round}|${p.jumper}`;
      const absent = absenceSet.has(key);
      const current = absent ? 'OUT' : (splitMap[key] || 'A');
      const rEsc = escHtml(String(r.round));
      const jEsc = escHtml(String(p.jumper));
      let onclick;
      if (current === 'A') {
        onclick = `dispatch({type:'set-split',payload:{round:'${rEsc}',jumper:'${jEsc}',subteam:'B'}});renderLineup();`;
      } else if (current === 'B') {
        onclick = `dispatch({type:'toggle-player-absent',payload:{round:'${rEsc}',jumper:'${jEsc}'}});renderLineup();`;
      } else {
        onclick = `dispatch({type:'toggle-player-absent',payload:{round:'${rEsc}',jumper:'${jEsc}'}});dispatch({type:'set-split',payload:{round:'${rEsc}',jumper:'${jEsc}',subteam:'A'}});renderLineup();`;
      }
      const tdCls = absent ? ' lineup-td-out' : '';
      return `<td class="lineup-td-cell${tdCls}"><button
        class="lineup-cell-btn ${escHtml(current)}"
        data-round="${rEsc}"
        data-jumper="${jEsc}"
        onclick="${onclick}"
        title="Rd ${rEsc} · #${jEsc} ${escHtml(p.player_name || '')} — click to toggle"
      >${escHtml(current)}</button></td>`;
    }).join('');
    return `<tr>
      <td class="lineup-td-player"><span class="jumper-chip">#${escHtml(String(p.jumper))}</span> ${escHtml(p.player_name || '')}</td>
      ${cells}
    </tr>`;
  }).join('');

  container.innerHTML = `<button class="lineup-help-btn"
    onclick="var ol=document.getElementById('lineupGuideOverlay');if(ol)ol.style.display='flex'"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"
    title="How to use the lineup" aria-label="Show lineup instructions"
    aria-controls="lineupGuideOverlay">&#x1F4A1;</button>

  <div id="lineupGuideOverlay" class="lineup-guide-overlay" style="display:none"
    role="dialog" aria-modal="true" aria-label="Lineup instructions"
    onclick="this.style.display='none'">
    <div class="lineup-guide-card">
      <p><strong>Tap any cell</strong> to cycle a player's slot:</p>
      <p class="lineup-guide-cycle">A &rarr; B &rarr; OUT &rarr; A</p>
      <p><strong>A</strong> and <strong>B</strong> assign the player&rsquo;s subteam &mdash; used for Goal Umpire and Umpire Escort slots.</p>
      <p><strong>OUT</strong> marks the player absent. Their volunteer is excluded from all volunteer slots that round.</p>
      <p>Once the lineup is set, tap <strong>Re-allocate</strong> to apply your changes.</p>
      <p class="lineup-guide-dismiss">Tap anywhere to close.</p>
    </div>
  </div>

  <div class="lineup-scroll-wrap"><table class="lineup-table">
    <thead><tr><th class="lineup-th-player">Player</th>${colHeaders}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table></div>`;

  document.getElementById('lineupSubtitle').textContent =
    `${sortedPlayers.length} player${sortedPlayers.length !== 1 ? 's' : ''} · ${rounds.length} round${rounds.length !== 1 ? 's' : ''}`;

  const lineupReallocBtn = document.getElementById('btnReallocateLineup');
  if (lineupReallocBtn) lineupReallocBtn.onclick = () => reallocate(lineupReallocBtn);
}

// ── Volunteer swap overlay (SPA-RD-10, SPA-RD-12) ───────────────────────
function openVolSwap(roundNum, job, subteam, slotIndex) {
  const data = getData();
  if (!data) return;

  const eligibleVols = (data.volunteers && data.volunteers.eligible) || [];
  const splits = (data.reference_data && data.reference_data.splits) || [];
  const absences = (data.reference_data && data.reference_data.absences) || [];

  const splitMap = {};
  for (const s of splits) splitMap[`${s.round}|${s.jumper}`] = s.subteam;

  const candidates = eligibleVols.filter(v => {
    if ((v.avoid_jobs || []).includes(job)) return false;
    if (subteam && subteam !== 'shared') {
      const volSubteam = splitMap[`${roundNum}|${v.jumper}`];
      if (volSubteam !== subteam) return false;
    }
    // Exclude absent players from subteam-specific slots
    if (subteam && subteam !== 'shared') {
      if (absences.some(a => String(a.round) === String(roundNum) && String(a.jumper) === String(v.jumper))) {
        return false;
      }
    }
    return true;
  });

  const overlay  = document.getElementById('volSwapOverlay');
  const backdrop = document.getElementById('volSwapBackdrop');
  if (!overlay || !backdrop) return;

  document.getElementById('volSwapTitle').textContent =
    `Swap volunteer — ${job}${subteam && subteam !== 'shared' ? ` (${subteam})` : ''}`;

  const rounds = (data.round_summary && data.round_summary.rounds) || [];
  const currentRound = rounds.find(r => String(r.round) === String(roundNum));
  const currentEntry = currentRound && (currentRound.entries || []).find(e =>
    e.job === job && (e.subteam || 'shared') === subteam && (e.slot_index ?? 0) === slotIndex
  );
  const isManual = currentEntry && currentEntry.slot_status === 'manual';

  const unsetBtn = isManual
    ? `<button class="vol-swap-item vol-swap-item-unset" onclick="unsetVolSwap('${escHtml(String(roundNum))}','${escHtml(job)}','${escHtml(subteam)}',${Number(slotIndex)})">↩ Unset — revert to automatic allocation</button>`
    : '';

  const list = document.getElementById('volSwapList');
  list.innerHTML = unsetBtn + (candidates.length === 0
    ? '<p class="vol-swap-empty">No eligible volunteers available</p>'
    : candidates.map(v =>
        `<button class="vol-swap-item" onclick="confirmVolSwap('${escHtml(String(roundNum))}','${escHtml(job)}','${escHtml(subteam)}',${Number(slotIndex)},'${escHtml(v.volunteer)}','${escHtml(v.jumper)}')">#${escHtml(v.jumper)} ${escHtml(v.volunteer)}</button>`
      ).join(''));

  overlay.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

function unsetVolSwap(roundNum, job, subteam, slotIndex) {
  dispatch({
    type: 'unset-volunteer',
    payload: { roundNum: String(roundNum), job, subteam, slotIndex: Number(slotIndex) },
  });
  closeVolSwap();
  // In SPA mode: immediately re-run the allocator so the slot is auto-filled rather
  // than left as ⚠ unfilled. In server mode: render the unfilled state and let the
  // user trigger reallocate manually (avoids an unexpected network round-trip).
  const mode = localStorage.getItem('allocator-mode') ?? 'spa';
  if (mode === 'spa') {
    reallocate();
  } else {
    render();
  }
}

function closeVolSwap() {
  const overlay  = document.getElementById('volSwapOverlay');
  const backdrop = document.getElementById('volSwapBackdrop');
  if (overlay)  overlay.classList.add('hidden');
  if (backdrop) backdrop.classList.add('hidden');
}

function confirmVolSwap(roundNum, job, subteam, slotIndex, newVolunteer, newJumper) {
  dispatch({
    type: 'swap-volunteer',
    payload: {
      roundNum: String(roundNum),
      job,
      subteam,
      slotIndex: Number(slotIndex),
      newVolunteer,
      newJumper: String(newJumper || ''),
    },
  });
  closeVolSwap();
  render();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeVolSwap();
});

// ── Data Management Panel (DM-001–029) ────────────────────────────────────

// Module-level state for the Data panel
let _dataActiveSubpanel = 'rounds';
let _dataRecords = {};   // cache: { clubs: [...], locations: [...], ... }

const DATA_SCHEMAS = {
  rounds: {
    pk: 'round',
    label: 'Round',
    columns: ['round','home_away','date','location_id','opposition_club_id','time','extra_notes'],
    fields: [
      { name: 'round',              label: 'Round #',    type: 'text',   required: true  },
      { name: 'home_away',          label: 'Home/Away',  type: 'select', required: true,
        options: ['h','a','B']                                                            },
      { name: 'date',               label: 'Date',       type: 'date',   required: true  },
      { name: 'location_id',        label: 'Location ID',type: 'text',   required: false },
      { name: 'opposition_club_id', label: 'Club ID',    type: 'text',   required: false },
      { name: 'time',               label: 'Time',       type: 'text',   required: false },
      { name: 'extra_notes',        label: 'Notes',      type: 'text',   required: false },
    ],
  },
  clubs: {
    pk: 'club_id',
    label: 'Club',
    columns: ['club_id','name'],
    fields: [
      { name: 'name', label: 'Club name', type: 'text', required: true },
    ],
  },
  locations: {
    pk: 'location_id',
    label: 'Location',
    columns: ['location_id','club_id','display_name'],
    fields: [
      { name: 'display_name', label: 'Display name', type: 'text', required: true  },
      { name: 'club_id',      label: 'Club ID',      type: 'text', required: false },
    ],
  },
  jobs: {
    pk: 'job_name',
    label: 'Job',
    columns: ['job_name','volunteers_required','subteam','home_only'],
    fields: [
      { name: 'job_name',            label: 'Job name',    type: 'text', required: true  },
      { name: 'volunteers_required', label: 'Slots',       type: 'text', required: false },
      { name: 'subteam',             label: 'Subteam',     type: 'text', required: false },
      { name: 'home_only',           label: 'Home only',   type: 'text', required: false },
    ],
  },
  players: {
    pk: 'jumper',
    label: 'Player',
    columns: ['jumper','player_name'],
    fields: [
      { name: 'jumper',      label: 'Jumper #',   type: 'text', required: true },
      { name: 'player_name', label: 'Player name',type: 'text', required: true },
    ],
  },
  volunteers: {
    pk: 'jumper',
    label: 'Volunteer',
    columns: ['jumper','volunteer_name','eligible','preferred_job','avoid_jobs'],
    fields: [
      { name: 'jumper',          label: 'Jumper #',     type: 'text', required: true  },
      { name: 'volunteer_name',  label: 'Name',         type: 'text', required: true  },
      { name: 'eligible',        label: 'Eligible',     type: 'text', required: false },
      { name: 'preferred_job',   label: 'Prefers',      type: 'text', required: false },
      { name: 'avoid_jobs',      label: 'Avoids',       type: 'text', required: false },
    ],
  },
};

// Fetch records for a data type and cache them
async function fetchDataRecords(type) {
  if (!isAdmin()) {
    // USER_SPA: read from the store — no server call
    const data = getData();
    if (type === 'volunteers') {
      // volunteers live in data.volunteers.eligible, not reference_data
      _dataRecords[type] = (data?.volunteers?.eligible || []).map(v => ({
        jumper:         String(v.jumper),
        volunteer_name: v.volunteer || '',
        eligible:       'true',
        preferred_job:  (v.preferred_jobs || []).join(', '),
        avoid_jobs:     (v.avoid_jobs     || []).join(', '),
      }));
    } else {
      _dataRecords[type] = (data?.reference_data || {})[type] || [];
    }
    return _dataRecords[type];
  }
  const res = await fetch(`/api/data/${type}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  _dataRecords[type] = await res.json();
  return _dataRecords[type];
}

// Refresh counts in the sub-nav and re-render the active sub-panel
async function refreshDataSubpanel(type) {
  await fetchDataRecords(type);
  renderDataCounts();
  renderDataSubpanelContent(type);
}

function renderDataCounts() {
  Object.keys(DATA_SCHEMAS).forEach(type => {
    const el = document.getElementById(`dataCount-${type}`);
    if (el) {
      const count = (_dataRecords[type] || []).length;
      el.textContent = `(${count})`;
    }
  });
}

function renderDataSubpanelContent(type) {
  const schema = DATA_SCHEMAS[type];
  const records = _dataRecords[type] || [];
  const tableEl = document.getElementById(`dataTable-${type}`);
  const emptyEl = document.getElementById(`dataEmpty-${type}`);
  if (!tableEl) return;

  if (records.length === 0) {
    tableEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  const cols = schema.columns;
  const pk = schema.pk;

  const rows = records.map(rec => {
    const cells = cols.map(col =>
      `<td>${escHtml(String(rec[col] ?? ''))}</td>`
    ).join('');
    const id = encodeURIComponent(rec[pk] ?? '');
    return `<tr>
      ${cells}
      <td class="data-row-actions">
        <button class="btn data-edit-btn" data-type="${type}" data-id="${id}">Edit</button>
        <button class="btn data-delete-btn" data-type="${type}" data-id="${id}">Delete</button>
      </td>
    </tr>`;
  }).join('');

  const headerCells = [...cols.map(c => `<th>${escHtml(c)}</th>`), '<th></th>'].join('');
  tableEl.innerHTML = `
    <table class="data-table">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Wire edit buttons
  tableEl.querySelectorAll('.data-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openDataDialog(btn.dataset.type, btn.dataset.id));
  });
  // Wire delete buttons
  tableEl.querySelectorAll('.data-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => confirmDataDelete(btn.dataset.type, btn.dataset.id, btn));
  });
}

// Switch sub-panel tab
function switchDataSubpanel(type) {
  _dataActiveSubpanel = type;
  document.querySelectorAll('.data-subnav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.subpanel === type);
  });
  document.querySelectorAll('.data-subpanel').forEach(sp => {
    sp.classList.toggle('active', sp.dataset.subpanel === type);
  });
  if (!_dataRecords[type]) {
    fetchDataRecords(type).then(() => {
      renderDataCounts();
      renderDataSubpanelContent(type);
    });
  } else {
    renderDataSubpanelContent(type);
  }
}

// Open add/edit dialog
function openDataDialog(type, idEncoded = null) {
  const schema = DATA_SCHEMAS[type];
  const isEdit = idEncoded !== null;
  const id = idEncoded ? decodeURIComponent(idEncoded) : null;
  const existing = isEdit
    ? (_dataRecords[type] || []).find(r => String(r[schema.pk]) === id)
    : null;

  // Remove any existing dialog
  const old = document.getElementById('dataDialog');
  if (old) old.remove();

  const fields = schema.fields.map(f => {
    const val = existing ? escHtml(String(existing[f.name] ?? '')) : '';
    const req = f.required ? 'required' : '';
    if (f.type === 'select') {
      const opts = f.options.map(o =>
        `<option value="${o}" ${existing && existing[f.name] === o ? 'selected' : ''}>${o}</option>`
      ).join('');
      return `<div class="data-field">
        <label for="df-${f.name}">${escHtml(f.label)}${f.required ? ' *' : ''}</label>
        <select id="df-${f.name}" name="${f.name}" ${req}>${opts}</select>
      </div>`;
    }
    return `<div class="data-field">
      <label for="df-${f.name}">${escHtml(f.label)}${f.required ? ' *' : ''}</label>
      <input id="df-${f.name}" name="${f.name}" type="${f.type}" value="${val}" ${req}
             placeholder="${escHtml(f.label)}">
      <span class="data-field-error hidden" id="dfe-${f.name}"></span>
    </div>`;
  }).join('');

  const dlg = document.createElement('dialog');
  dlg.id = 'dataDialog';
  dlg.innerHTML = `
    <form id="dataDialogForm">
      <h3>${isEdit ? 'Edit' : 'Add'} ${escHtml(schema.label)}</h3>
      ${fields}
      <div class="data-dialog-error hidden" id="dataDialogError"></div>
      <div class="data-dialog-actions">
        <button type="button" class="btn" id="dataDialogCancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="dataDialogSave">Save</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  dlg.querySelector('#dataDialogCancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());

  dlg.querySelector('#dataDialogSave').addEventListener('click', async () => {
    await submitDataForm(type, isEdit, id, dlg, schema);
  });
}

async function submitDataForm(type, isEdit, id, dlg, schema) {
  const form = dlg.querySelector('#dataDialogForm');
  const errEl = dlg.querySelector('#dataDialogError');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  // Collect form values
  const body = {};
  schema.fields.forEach(f => {
    const el = form.querySelector(`[name="${f.name}"]`);
    if (el) body[f.name] = el.value;
  });

  // Client-side required validation
  let valid = true;
  schema.fields.forEach(f => {
    const errSpan = form.querySelector(`#dfe-${f.name}`);
    if (f.required && !body[f.name]?.trim()) {
      if (errSpan) { errSpan.textContent = 'This field is required'; errSpan.classList.remove('hidden'); }
      valid = false;
    } else {
      if (errSpan) errSpan.classList.add('hidden');
    }
  });
  if (!valid) return;
  if (!isAdmin()) {
    // USER_SPA: persist the record to the in-memory cache and the store
    const pk = schema.pk;
    if (isEdit) {
      const idx = (_dataRecords[type] || []).findIndex(r => String(r[pk]) === id);
      if (idx >= 0) _dataRecords[type][idx] = { ..._dataRecords[type][idx], ...body };
    } else {
      if (!_dataRecords[type]) _dataRecords[type] = [];
      _dataRecords[type].push(body);
    }
    if (type !== 'volunteers') {
      dispatch({ type: 'update-reference-data', payload: { key: type, records: _dataRecords[type] } });
    }
    dlg.close();
    await refreshDataSubpanel(type);
    return;
  }

  const url = isEdit
    ? `/api/data/${type}/${encodeURIComponent(id)}`
    : `/api/data/${type}`;
  const method = isEdit ? 'PUT' : 'POST';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    errEl.textContent = 'Network error — please try again';
    errEl.classList.remove('hidden');
    return;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    errEl.textContent = data.error || `Server error (${res.status})`;
    errEl.classList.remove('hidden');
    return;
  }

  dlg.close();
  await refreshDataSubpanel(type);
  dispatch({ type: 'update-reference-data', payload: { key: type, records: _dataRecords[type] } });
}

// Inline delete confirmation
function confirmDataDelete(type, idEncoded, btn) {
  // Prevent double-confirmation
  if (btn.parentElement.querySelector('.data-confirm-delete')) return;

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn data-confirm-delete';
  confirmBtn.textContent = 'Confirm';
  btn.parentElement.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  btn.parentElement.appendChild(cancelBtn);

  btn.style.display = 'none';

  cancelBtn.addEventListener('click', () => {
    confirmBtn.remove();
    cancelBtn.remove();
    btn.style.display = '';
  });

  confirmBtn.addEventListener('click', async () => {
    await executeDataDelete(type, idEncoded, btn.closest('tr'), confirmBtn);
  });
}

async function executeDataDelete(type, idEncoded, rowEl, confirmBtn) {
  if (!isAdmin()) {
    // USER_SPA: delete from in-memory cache and update store
    const schema = DATA_SCHEMAS[type];
    const id = decodeURIComponent(idEncoded);
    _dataRecords[type] = (_dataRecords[type] || []).filter(
      r => String(r[schema.pk]) !== id
    );
    if (type !== 'volunteers') {
      dispatch({ type: 'update-reference-data', payload: { key: type, records: _dataRecords[type] } });
    }
    await refreshDataSubpanel(type);
    return;
  }
  const url = `/api/data/${type}/${idEncoded}`;
  let res;
  try {
    res = await fetch(url, { method: 'DELETE' });
  } catch (err) {
    return;
  }

  if (res.status === 409) {
    // Referential integrity conflict — show warning and offer force
    const data = await res.json().catch(() => ({}));
    const affected = (data.affected_rounds || []).join(', ');
    const warning = document.createElement('span');
    warning.className = 'data-ri-warning';
    warning.textContent = `Used by round(s): ${affected}. `;
    const forceBtn = document.createElement('button');
    forceBtn.className = 'btn data-force-delete';
    forceBtn.textContent = 'Delete anyway';
    confirmBtn.parentElement.appendChild(warning);
    confirmBtn.parentElement.appendChild(forceBtn);
    confirmBtn.remove();
    forceBtn.addEventListener('click', async () => {
      const fRes = await fetch(`${url}?force=true`, { method: 'DELETE' });
      if (fRes.ok) {
        await refreshDataSubpanel(type);
        dispatch({ type: 'update-reference-data', payload: { key: type, records: _dataRecords[type] } });
      }
    });
    return;
  }

  if (res.ok) {
    await refreshDataSubpanel(type);
    dispatch({ type: 'update-reference-data', payload: { key: type, records: _dataRecords[type] } });
  }
}

// Initial load of all data types for the Data panel
async function loadAllDataRecords() {
  const types = Object.keys(DATA_SCHEMAS);
  await Promise.all(types.map(t => fetchDataRecords(t).catch(() => { _dataRecords[t] = []; })));
  renderDataCounts();
  renderDataSubpanelContent(_dataActiveSubpanel);
}

function setupDataPanel() {
  // Sub-nav switching
  document.querySelectorAll('.data-subnav-item').forEach(btn => {
    btn.addEventListener('click', () => switchDataSubpanel(btn.dataset.subpanel));
  });

  // Add+ buttons in sub-panel headers
  document.querySelectorAll('.data-add-btn').forEach(btn => {
    btn.addEventListener('click', () => openDataDialog(btn.dataset.type));
  });

  // Empty-state add buttons
  document.querySelectorAll('[data-add-type]').forEach(btn => {
    btn.addEventListener('click', () => openDataDialog(btn.dataset.addType));
  });
}
