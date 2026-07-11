'use strict';

// @front-end
// element: store-selectors
// philosophy: recognition-over-recall (view-models name exactly what a panel renders)
// paradigm: layered (render reads view-models; never reaches into raw state)
// intent: give every panel a single pure function that turns immutable store state
//         into the exact shape it renders, so rendering carries no data logic
// customer: developer
// binding: one-way (state in → view-model out; never mutates)
// breadcrumbs:
//   - "PURE module: imports only from store-reducer.mjs; zero DOM, zero window.*"
//   - "every selector takes `state` explicitly — index.js passes getState()"
//   - "resolveJumperByName/resolveNameByJumper take `data` (was global getData())"
// improve?: "selectVolunteersViewModel and selectBalanceViewModel both call
//            computeClientBalance — consider memoising per render"

import { initialUiState, deepClone } from './store-reducer.mjs';
import { isRoundLocked } from './round-status.mjs';

// ── Primitive selectors ────────────────────────────────────────────────────────

export function selectUiState(state) {
  return state?.ui || initialUiState();
}

export function selectStoreData(state) {
  return state?.data || null;
}

export function selectRounds(state) {
  return selectStoreData(state)?.round_summary?.rounds || [];
}

export function selectRoundByNum(roundNum, state) {
  if (roundNum == null) return null;
  const target = String(roundNum);
  return selectRounds(state).find(round => String(round.round) === target) || null;
}

export function selectSelectedRound(state) {
  const ui = selectUiState(state);
  if (!ui.roundDetailOpen || ui.selectedRound == null) return null;
  return selectRoundByNum(ui.selectedRound, state);
}

// ── Shared pure helpers (also imported by index.js render code) ─────────────────

export function colKey(c) {
  return `${c.job}|||${c.subteam}`;
}

export function buildEntriesMap(entries) {
  const map = {};
  entries.forEach(e => {
    const k = colKey(e);
    if (!map[k]) map[k] = [];
    map[k].push(e);
  });
  return map;
}

export function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

export function buildSeasonLabel(rounds) {
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

// Resolve a jumper number from a volunteer display name, using the given data model.
// (Was getVolJumper(name), which read the global getData().)
export function resolveJumperByName(data, name) {
  if (!data) return '';
  const hit = deriveCanonicalRoster(data).all.find(e => e.volunteer === name);
  return hit ? String(hit.jumper) : '';
}

// Resolve a volunteer display name from a jumper number, using the given data model.
// (Was getVolunteerByJumper(jumper), which read the global getData().)
export function resolveNameByJumper(data, jumper) {
  if (!data || !jumper) return '';
  const hit = deriveCanonicalRoster(data).byJumper[String(jumper)];
  return hit ? (hit.volunteer || '') : '';
}

// Parse the allocator's semicolon-joined job field into a trimmed string array.
function splitSemis(raw) {
  return String(raw || '').split(';').map(s => s.trim()).filter(Boolean);
}

function rosterShape(all, eligible, ineligible) {
  return { all, eligible, ineligible, byJumper: Object.fromEntries(all.map(e => [String(e.jumper), e])) };
}

// SINGLE SOURCE OF TRUTH for "who is on this team and can volunteer".
// Derived from reference_data.players (jumper → name) + reference_data.volunteers
// (eligibility + preferred/avoid jobs). This is what every panel + the allocator should
// agree on, so a player added to reference_data can never be invisible to a screen.
//
// Back-compat: when reference_data has NO volunteer rows (legacy / wizard-only data),
// fall back to the old volunteers.eligible/ineligible + user_team.roster shape so
// pre-reference_data fixtures keep working. reference_data.volunteers being the switch
// (not players) matters: some legacy fixtures carry players but hold the authoritative
// volunteer list in the legacy keys.
export function deriveCanonicalRoster(data) {
  const players = data?.reference_data?.players || [];
  const volunteers = data?.reference_data?.volunteers || [];

  if (volunteers.length === 0) {
    // Legacy fallback path.
    const eligible = (data?.volunteers?.eligible || []).map(v => ({ ...v, eligible: true }));
    const ineligible = (data?.volunteers?.ineligible || []).map(v => ({ ...v, eligible: false }));
    if (eligible.length === 0 && ineligible.length === 0) {
      const roster = (data?.user_team?.roster || []).filter(m => m.jumper).map(m => ({
        jumper: String(m.jumper), volunteer: m.name || String(m.jumper),
        player_name: m.name || String(m.jumper), eligible: true,
        preferred_jobs: [], avoid_jobs: [], certifications: [],
      }));
      return rosterShape(roster, roster, []);
    }
    return rosterShape(eligible.concat(ineligible), eligible, ineligible);
  }

  const nameByJumper = {};
  for (const p of players) nameByJumper[String(p.jumper)] = p.player_name;
  const volByJumper = {};
  for (const v of volunteers) volByJumper[String(v.jumper)] = v;

  const jumpers = [...new Set([
    ...players.map(p => String(p.jumper)),
    ...volunteers.map(v => String(v.jumper)),
  ])];

  const all = jumpers.map(jumper => {
    const v = volByJumper[jumper];
    const name = nameByJumper[jumper] || (v && v.volunteer_name) || jumper;
    return {
      jumper,
      volunteer: name,
      player_name: name,
      eligible: v ? String(v.eligible ?? '').trim().toLowerCase() === 'y' : true,
      preferred_jobs: v ? splitSemis(v.preferred_job) : [],
      avoid_jobs: v ? splitSemis(v.avoid_jobs) : [],
      certifications: v && Array.isArray(v.certifications) ? v.certifications : [],
    };
  }).sort((a, b) => Number(a.jumper) - Number(b.jumper));

  return rosterShape(all, all.filter(e => e.eligible), all.filter(e => !e.eligible));
}

export function selectCanonicalRoster(state) {
  return deriveCanonicalRoster(selectStoreData(state));
}

export function computeClientBalance(data) {
  // The volunteer list is the canonical eligible roster (single source of truth).
  const volList = deriveCanonicalRoster(data).eligible
    .filter(v => v.jumper)
    .map(v => ({ jumper: String(v.jumper), name: v.volunteer || String(v.jumper) }));

  if (volList.length === 0) return null;

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

export function serializeSnapshotModel(state) {
  const data = selectStoreData(state);
  if (!data) return null;
  return { ...deepClone(data), _schema_version: '1.1' };
}

// ── Panel view-models ──────────────────────────────────────────────────────────

export function selectDashboardViewModel(state) {
  const data = selectStoreData(state);
  if (!data) return null;
  const rounds = selectRounds(state);
  // A 'completed' (locked) round is finished — it is not the actionable feature
  // round, and it counts as confirmed for totals (consistent with the reducer).
  const isDone = round => round.status === 'confirmed' || round.status === 'completed';
  const featureRound = rounds.find(round => !isDone(round)) || rounds[rounds.length - 1] || null;
  const totalRounds = rounds.length;
  const confirmedRounds = rounds.filter(isDone).length;
  const completedRounds = rounds.filter(round => round.status === 'completed').length;
  return {
    rounds,
    featureRound,
    totalRounds,
    confirmedRounds,
    completedRounds,
    scheduledRounds: Math.max(totalRounds - confirmedRounds, 0),
    columns: data.matrix?.columns || [],
  };
}

export function selectMatrixViewModel(state) {
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

export function selectRoundsViewModel(state) {
  const rounds = selectRounds(state);
  return {
    rounds,
    roundCount: rounds.length,
    selectedRound: selectSelectedRound(state),
  };
}

export function selectRoundDetailViewModel(state) {
  const round = selectSelectedRound(state);
  if (!round) return null;
  const rounds = selectRounds(state);
  return {
    round,
    rounds,
    totalRounds: rounds.length,
    locked: isRoundLocked(round),   // RLK-003: render reads one boolean
  };
}

export function selectSettingsViewModel(state) {
  const data = selectStoreData(state);
  if (!data) return null;
  const ov = data.season_overview || {};
  const roster = deriveCanonicalRoster(data);
  const eligibleCount = roster.eligible.length;
  const ineligibleCount = roster.ineligible.length;
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
    emailPrefix: data.ui_preferences?.email_prefix ?? '',
    emailSuffix: data.ui_preferences?.email_suffix ?? '',
  };
}

export function selectSidebarViewModel(state) {
  const data = selectStoreData(state);
  if (!data) return null;
  const rounds = selectRounds(state);
  // Eligible/total counts come from the canonical roster (single source of truth).
  const canon = deriveCanonicalRoster(data);
  const eligible = canon.eligible;
  const total = canon.all.length;
  const roster = data.user_team?.roster || [];
  const teamName = data.user_team?.team_name || 'Volunteer Roster';
  const playerCount = roster.length;
  const playerLabel = 'player';
  const roundCount = rounds.length;
  const initials = getInitials(teamName);
  return {
    teamName,
    initials,
    seasonYear: buildSeasonLabel(rounds),
    eligibleCount: eligible.length,
    totalCount: total,
    modeLabel: 'USER MODE',
    modeIcon: '👤',
    modeStats: `${playerCount} ${playerLabel}${playerCount !== 1 ? 's' : ''} · ${roundCount} round${roundCount !== 1 ? 's' : ''}`,
    userAv: initials.slice(0, 2) || 'U',
    userName: teamName || 'User view',
    userRole: 'Local data · browser-only',
  };
}

export function selectFairnessViewModel(state) {
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
      jumper: entry.jumper || resolveJumperByName(data, entry.volunteer),
      volunteer: entry.volunteer || resolveNameByJumper(data, entry.jumper),
      count: entry.count,
      delta: entry.delta || 0,
      opacity: 0.5 + (entry.fraction_of_max !== undefined ? entry.fraction_of_max : entry.count / maxCount) * 0.5,
    })),
  };
}

export function selectAlertsViewModel(state) {
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

export function selectVolunteersViewModel(filter = '', state) {
  const data = selectStoreData(state);
  if (!data) return null;
  // Single source of truth: eligible/ineligible come from the canonical roster
  // (reference_data), so a mid-season player is never missing here.
  const roster = deriveCanonicalRoster(data);
  const eligible = roster.eligible;
  const ineligible = roster.ineligible;

  const lower = String(filter || '').toLowerCase();
  const absences = data.reference_data?.absences || [];

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
      const totalAssignments       = b.count     ?? v.total_assignments     ?? 0;
      const confirmedAssignments   = b.confirmed  ?? v.confirmed_assignments ?? 0;
      const scheduledAssignments   = b.scheduled  ?? v.scheduled_assignments ?? 0;
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

export function selectBalanceViewModel(state) {
  const data = selectStoreData(state);
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

export function selectConstraintsViewModel(state) {
  const data = selectStoreData(state);
  if (!data) return null;

  const storedAvoids = data.constraints?.avoid_jobs;
  let avoids = [...(storedAvoids || [])];

  if (!storedAvoids) {
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

export function selectNavigationViewModel(state) {
  const ui = selectUiState(state);
  return {
    activePanel: ui.activePanel,
    showRoundDetail: ui.activePanel === 'rounds' && !!selectSelectedRound(state),
  };
}

// ── New selectors (CLM-007): team-splits and lineup no longer read data directly ─

export function selectTeamSplitsViewModel(state) {
  const ui = selectUiState(state);
  const data = selectStoreData(state);
  const allRounds = (data?.round_summary?.rounds || [])
    .filter(r => r.home_away !== 'B')
    .sort((a, b) => Number(a.round) - Number(b.round));

  if (allRounds.length === 0) {
    return { allRounds, activeRound: null, players: [], splitMap: {}, absenceSet: new Set(), groups: {}, groupOrder: [] };
  }

  const featureRound = allRounds.find(r => r.status !== 'confirmed') || allRounds[allRounds.length - 1];
  const activeRound = ui.teamSplitsRound && allRounds.some(r => String(r.round) === String(ui.teamSplitsRound))
    ? String(ui.teamSplitsRound)
    : String(featureRound.round);

  const players = (data?.reference_data?.players || []);
  const splits = (data?.reference_data?.splits || []);
  const absences = (data?.reference_data?.absences || []);

  const splitMap = {};
  for (const s of splits) splitMap[`${s.round}|${s.jumper}`] = s.subteam;

  const absenceSet = new Set(
    absences.filter(a => String(a.round) === activeRound).map(a => String(a.jumper))
  );

  const sortedPlayers = [...players].sort((a, b) => Number(a.jumper) - Number(b.jumper));

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

  return { allRounds, activeRound, players, splitMap, absenceSet, groups, groupOrder };
}

export function selectLineupViewModel(state) {
  const data = selectStoreData(state);
  if (!data) return null;

  const splits = (data.reference_data && data.reference_data.splits) || [];
  const players = (data.reference_data && data.reference_data.players) || [];
  const rounds = ((data.round_summary && data.round_summary.rounds) || [])
    .filter(r => r.home_away !== 'B')
    .sort((a, b) => Number(a.round) - Number(b.round));

  const splitMap = {};
  for (const s of splits) splitMap[`${s.round}|${s.jumper}`] = s.subteam;

  const absenceSet = new Set(
    ((data.reference_data && data.reference_data.absences) || [])
      .map(a => `${a.round}|${a.jumper}`)
  );

  const sortedPlayers = [...players].sort((a, b) => Number(a.jumper) - Number(b.jumper));

  return { rounds, players, sortedPlayers, splitMap, absenceSet };
}
