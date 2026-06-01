'use strict';

// @front-end
// element: store-reducer
// philosophy: one-way-data-binding
// paradigm: layered (render ← intent ← state)
// intent: own every state transition as a pure, testable function so the SPA's
//         data flow is auditable and reproducible without a browser
// customer: developer
// binding: one-way
// breadcrumbs:
//   - "PURE module: zero DOM access, zero window.* references, zero side effects"
//   - "reduceState(currentState, action) returns a new frozen state; never mutates"
//   - "action shape is { type, payload } — payload carries all operands"
// improve?: "consider normalising action creators so callers can't hand-build payloads"

// ── Immutability primitives ───────────────────────────────────────────────────

export function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.getOwnPropertyNames(value).forEach(key => {
    deepFreeze(value[key]);
  });
  return value;
}

// ── Report model assembly ──────────────────────────────────────────────────────

export function mergeReportModel(serverSnapshot, clientOverrides) {
  if (!serverSnapshot) return null;
  const merged = deepClone(serverSnapshot);
  Object.entries(clientOverrides || {}).forEach(([key, value]) => {
    if (value !== undefined) merged[key] = deepClone(value);
  });
  return deepFreeze(merged);
}

export function initialUiState() {
  return {
    activePanel: 'dashboard',
    loadedFilename: null,
    selectedRound: null,
    roundDetailOpen: false,
    teamSplitsRound: null,
    // CLM-006: UI render-cycle state now lives in the store so it survives
    // an IDB persist/reload cycle instead of resetting on every reload.
    balanceSortKey: 'most-loaded',   // Balance panel sort (was module-global _balanceSort)
    expandedVolJumpers: [],          // Expanded volunteer rows (was module-global _expandedVols Set)
  };
}

export function normalizeUiState(ui, data) {
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

export function buildStoreState(serverSnapshot, clientOverrides, ui) {
  const overrides = clientOverrides || {};
  const data = mergeReportModel(serverSnapshot, overrides);
  return {
    serverSnapshot,
    clientOverrides: overrides,
    ui: normalizeUiState(ui, data),
    data,
  };
}

export function replaceStoreData(currentState, nextReport, ui = currentState.ui) {
  if (!nextReport) return currentState;
  return buildStoreState(deepFreeze(deepClone(nextReport)), {}, ui);
}

export function updateSeasonOverviewCounts(seasonOverview, rounds) {
  if (!seasonOverview) return seasonOverview;
  // RLK-004: a 'completed' (locked) round is finalised, so it counts toward
  // confirmed_rounds (keeping scheduled_rounds correct), plus its own count.
  const confirmedRounds = rounds.filter(round => round.status === 'confirmed' || round.status === 'completed').length;
  const completedRounds = rounds.filter(round => round.status === 'completed').length;
  return {
    ...deepClone(seasonOverview),
    confirmed_rounds: confirmedRounds,
    completed_rounds: completedRounds,
    scheduled_rounds: Math.max(rounds.length - confirmedRounds, 0),
  };
}

export function updateMatrixRoundStatuses(matrix, rounds) {
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

// ── The reducer ────────────────────────────────────────────────────────────────

export function reduceState(currentState, action) {
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
    case 'set-balance-sort':
      // CLM-006: Balance sort key persists in the store (was module-global _balanceSort).
      return buildStoreState(currentState.serverSnapshot, currentState.clientOverrides, {
        ...currentState.ui,
        balanceSortKey: action.payload.sortKey,
      });
    case 'toggle-vol-expanded': {
      // CLM-006: Volunteer row expansion persists in the store (was module-global _expandedVols Set).
      const jumper = String(action.payload.jumper);
      const current = currentState.ui.expandedVolJumpers || [];
      const expandedVolJumpers = current.includes(jumper)
        ? current.filter(j => j !== jumper)
        : [...current, jumper];
      return buildStoreState(currentState.serverSnapshot, currentState.clientOverrides, {
        ...currentState.ui,
        expandedVolJumpers,
      });
    }
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
    case 'toggle-round-locked': {
      // RLK-001/002: the lock control flips confirmed↔completed. A 'completed'
      // round is locked/read-only (gating lives in the selector/handler layer).
      if (!currentState.data) return currentState;
      const roundNum = String(action.payload.roundNum);
      const rounds = ((currentState.data.round_summary && currentState.data.round_summary.rounds) || []).map(round =>
        String(round.round) === roundNum
          ? { ...deepClone(round), status: round.status === 'completed' ? 'confirmed' : 'completed' }
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
