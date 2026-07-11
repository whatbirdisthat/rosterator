'use strict';

/**
 * Pure ES module for client-side allocation engine.
 * Ports the Python scheduling algorithm from footymanager/domain/scheduling/
 * No DOM dependencies, no network calls — pure functions and data structures.
 */

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

export const SEARCH_STATE_BUDGET = 2000;

const REPEAT_PENALTY = 50;
const NON_PREFERRED_REPEAT_PENALTY = 500;
const UNFILLED_VOLUNTEER = '*** UNFILLED ***';

// ────────────────────────────────────────────────────────────────────────────
// RNG (seeded for deterministic testing)
// ────────────────────────────────────────────────────────────────────────────

function makeRng(seedRng) {
  if (seedRng !== undefined) {
    // Deterministic LCG seeded by seedRng
    let state = seedRng;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }
  return () => Math.random();
}

// ────────────────────────────────────────────────────────────────────────────
// Model Parsing
// ────────────────────────────────────────────────────────────────────────────

function cleanMetadata(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normaliseCertToken(token) {
  const raw = cleanMetadata(token);
  if (!raw) return '';
  return /^\d+$/.test(raw) ? raw : raw.toUpperCase();
}

function parseCertifications(raw) {
  const parts = String(raw || '').split(';');
  const result = new Set();
  for (const part of parts) {
    const norm = normaliseCertToken(part);
    if (norm) result.add(norm);
  }
  return result;
}

function normaliseSubteam(value) {
  return cleanMetadata(value).toUpperCase();
}

// RLK: a 'confirmed' OR 'completed' (locked) round is preserved unchanged by the
// allocator — its assignments never get rebalanced.
function isPreservedStatus(status) {
  return status === 'confirmed' || status === 'completed';
}

function splitSemicolonField(raw) {
  const parts = String(raw || '').split(';');
  const result = new Set();
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) result.add(trimmed);
  }
  return result;
}

export function parseVolunteer(row) {
  return {
    name: cleanMetadata(row.volunteer_name),
    jumper: cleanMetadata(row.jumper),
    eligible: cleanMetadata(row.eligible).toLowerCase() === 'y',
    preferred_jobs: splitSemicolonField(row.preferred_job),
    avoid_jobs: splitSemicolonField(row.avoid_jobs),
    certifications: parseCertifications(row.certifications || ''),
  };
}

export function parseJob(row) {
  const rawHomeOnly = cleanMetadata(row.home_only || '');
  return {
    name: cleanMetadata(row.job_name),
    volunteers_required: parseInt(cleanMetadata(row.volunteers_required), 10),
    subteam: cleanMetadata(row.subteam),
    required_certifications: parseCertifications(row.certifications_required || ''),
    home_only: rawHomeOnly.toLowerCase() === 'y',
  };
}

function isJobApplicableForRound(job, homeAway) {
  if (job.home_only && homeAway.trim().toUpperCase() === 'A') {
    return false;
  }
  return true;
}

function* jobSlots(job) {
  for (let i = 0; i < job.volunteers_required; i++) {
    yield {
      job_name: job.name,
      subteam_tag: job.subteam,
      required_certs: job.required_certifications,
      is_bbq: job.name.toUpperCase() === 'BBQ',
    };
  }
}

export function parseSplit(row) {
  return {
    round_id: cleanMetadata(row.round),
    jumper: cleanMetadata(row.jumper),
    subteam: normaliseSubteam(row.subteam),
  };
}

export function parseRound(row) {
  const rawType = cleanMetadata(row.round_type || '').toUpperCase();
  return {
    round_id: cleanMetadata(row.round),
    date: cleanMetadata(row.date),
    home_away: cleanMetadata(row.home_away),
    // RT-001: SPLIT (default) vs FULL_TEAM. Blank/legacy/unknown → SPLIT.
    round_type: rawType === 'FULL_TEAM' ? 'FULL_TEAM' : 'SPLIT',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Fairness Load
// ────────────────────────────────────────────────────────────────────────────

export function fairnessLoadFromConfirmed(state) {
  const load = {};
  const volunteers = state.reference_data?.volunteers || [];
  const jumperToName = {};
  for (const v of volunteers) {
    const jumper = cleanMetadata(v.jumper);
    const name = cleanMetadata(v.volunteer_name || v.name || '');
    if (jumper && name) jumperToName[jumper] = name;
  }
  const rounds = state.round_summary?.rounds || [];
  for (const roundEntry of rounds) {
    if (isPreservedStatus(roundEntry.status)) {
      const entries = roundEntry.entries || [];
      for (const entry of entries) {
        const jumper = cleanMetadata(entry.jumper);
        if (!jumper) continue;
        const name = jumperToName[jumper] || entry.volunteer || '';
        if (name && name !== UNFILLED_VOLUNTEER) {
          load[name] = (load[name] || 0) + 1;
        }
      }
    }
  }
  return load;
}

// ────────────────────────────────────────────────────────────────────────────
// Candidate Filtering
// ────────────────────────────────────────────────────────────────────────────

export function filterCandidatesForSlot(
  slot,
  volunteers,
  roundId,
  volunteerSubteamByRound,
  avoidJobsByVolunteer,
  bbqAssignedThisSeason,
  consecutiveJobMap,
) {
  const candidates = [];
  for (const volunteer of volunteers) {
    const name = volunteer.name;

    // Rule 1: avoid_jobs
    if (avoidJobsByVolunteer[name]?.has(slot.job_name)) {
      continue;
    }

    // Rule 2: subteam matching
    if (slot.subteam_tag !== 'shared') {
      const actualSubteam = volunteerSubteamByRound[[roundId, name]];
      if (actualSubteam !== slot.subteam_tag) {
        continue;
      }
    }

    // Rule 3: certification
    if (slot.required_certs.size > 0) {
      let hasCerts = true;
      for (const cert of slot.required_certs) {
        if (!volunteer.certifications.has(cert)) {
          hasCerts = false;
          break;
        }
      }
      if (!hasCerts) {
        continue;
      }
    }

    // Rule 4: BBQ once per season
    if (slot.is_bbq && bbqAssignedThisSeason.has(name)) {
      continue;
    }

    // Rule 5: 3-round consecutive limit
    const streakInfo = consecutiveJobMap[name];
    if (streakInfo) {
      const [streakJob, streakLen] = streakInfo;
      if (streakJob === slot.job_name && streakLen >= 3) {
        continue;
      }
    }

    candidates.push(volunteer);
  }
  return candidates;
}

// ────────────────────────────────────────────────────────────────────────────
// Scoring
// ────────────────────────────────────────────────────────────────────────────

function scoreNoise(rng) {
  return rng() * 0.001;
}

export function slotScore(
  volunteer,
  jobName,
  fairnessLoad,
  preferredJobsByVolunteer,
  previousJobMap,
  rng,
) {
  const name = volunteer.name;
  let score = fairnessLoad[name] || 0;

  const isPreferred = (preferredJobsByVolunteer[name] || new Set()).has(jobName);
  if (isPreferred) {
    score -= 0.5;
  }

  if (previousJobMap[name] === jobName) {
    score += REPEAT_PENALTY;
    if (!isPreferred) {
      score += NON_PREFERRED_REPEAT_PENALTY;
    }
  }

  score += scoreNoise(rng);
  return score;
}

// ────────────────────────────────────────────────────────────────────────────
// Search Objective
// ────────────────────────────────────────────────────────────────────────────

export function optimisticVarianceBound(loadValues, remainingAssignments) {
  if (loadValues.length === 0) {
    return 0;
  }
  const counts = [...loadValues].sort((a, b) => a - b);
  const n = counts.length;
  for (let i = 0; i < remainingAssignments; i++) {
    counts[0] += 1;
    let idx = 0;
    while (idx + 1 < n && counts[idx] > counts[idx + 1]) {
      [counts[idx], counts[idx + 1]] = [counts[idx + 1], counts[idx]];
      idx += 1;
    }
  }
  const avg = counts.reduce((a, b) => a + b, 0) / n;
  return counts.reduce((sum, c) => sum + (c - avg) ** 2, 0);
}

function greedySimulateRound(spec, simLoad) {
  const newLoad = { ...simLoad };
  const used = new Set();
  for (const candidates of spec.candidates_per_slot) {
    let bestName = null;
    let bestScore = Infinity;
    for (const name of candidates) {
      if (used.has(name)) continue;
      const score = newLoad[name] || 0;
      if (score < bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    if (bestName !== null) {
      newLoad[bestName] = (newLoad[bestName] || 0) + 1;
      used.add(bestName);
    }
  }
  return newLoad;
}

export function objective(postRoundLoad, pendingRounds) {
  let simLoad = { ...postRoundLoad };
  for (const spec of pendingRounds) {
    simLoad = greedySimulateRound(spec, simLoad);
  }
  const counts = Object.values(simLoad);
  if (counts.length === 0) {
    return 0;
  }
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  return counts.reduce((sum, c) => sum + (c - avg) ** 2, 0);
}

function objectiveCached(postRoundLoad, pendingRounds, cache) {
  const key = JSON.stringify([postRoundLoad, pendingRounds.length]);
  if (key in cache) {
    return cache[key];
  }
  const result = objective(postRoundLoad, pendingRounds);
  cache[key] = result;
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Search Context Building
// ────────────────────────────────────────────────────────────────────────────

export function buildRoundSearchContext(
  roundId,
  isHomeRound,
  slots,
  eligibleVolunteers,
  volunteerSubteamByRound,
  preferredJobsByVolunteer,
  avoidJobsByVolunteer,
  fairnessLoad,
  previousJobMap,
  bbqAssignedThisSeason,
  consecutiveJobMap,
  pendingRounds,
  rng,
  volunteerToJumper = {},
  lockedVolunteers = new Set(),
) {
  // Normalise load so every eligible volunteer has an entry
  const normalisedLoad = {};
  for (const volunteer of eligibleVolunteers) {
    normalisedLoad[volunteer.name] = fairnessLoad[volunteer.name] || 0;
  }
  // Retain any confirmed-only volunteers not in eligible list
  for (const [name, count] of Object.entries(fairnessLoad)) {
    if (!(name in normalisedLoad)) {
      normalisedLoad[name] = count;
    }
  }

  const candidatesPerSlot = [];
  for (const slot of slots) {
    const cands = filterCandidatesForSlot(
      slot,
      eligibleVolunteers,
      roundId,
      volunteerSubteamByRound,
      avoidJobsByVolunteer,
      bbqAssignedThisSeason,
      consecutiveJobMap,
    ).filter(v => !lockedVolunteers.has(v.name));

    // Sort ascending by score — best candidate first
    cands.sort(
      (v1, v2) =>
        slotScore(v1, slot.job_name, normalisedLoad, preferredJobsByVolunteer, previousJobMap, rng) -
        slotScore(v2, slot.job_name, normalisedLoad, preferredJobsByVolunteer, previousJobMap, rng),
    );

    candidatesPerSlot.push(cands.map(v => v.name));
  }

  return {
    round_id: roundId,
    is_home_round: isHomeRound,
    slots,
    candidates_per_slot: candidatesPerSlot,
    fairness_load: normalisedLoad,
    previous_job_map: previousJobMap,
    bbq_assigned_this_season: bbqAssignedThisSeason,
    consecutive_job_map: consecutiveJobMap,
    preferred_jobs: preferredJobsByVolunteer,
    pending_rounds: pendingRounds,
    volunteer_to_jumper: volunteerToJumper,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// DFS Search
// ────────────────────────────────────────────────────────────────────────────

function greedyFallbackNames(ctx) {
  const names = [];
  const currentLoad = { ...ctx.fairness_load };
  const used = new Set();

  for (const candidates of ctx.candidates_per_slot) {
    const chosen = candidates.find(c => !used.has(c));
    names.push(chosen || null);
    if (chosen) {
      used.add(chosen);
      currentLoad[chosen] = (currentLoad[chosen] || 0) + 1;
    }
  }

  return [names, objective(currentLoad, ctx.pending_rounds)];
}

function searchBestAssignment(ctx, maxStates, cache) {
  const nSlots = ctx.slots.length;
  const lookaheadSlots = ctx.pending_rounds.reduce((sum, spec) => sum + spec.slots.length, 0);

  let bestNames = null;
  let bestScore = Infinity;
  let exploredStates = 0;

  const initialLoad = { ...ctx.fairness_load };
  const stack = [[0, [], initialLoad, new Set()]];

  while (stack.length > 0) {
    if (maxStates !== null && exploredStates >= maxStates) {
      break;
    }

    const [slotIdx, partialNames, currentLoad, used] = stack.pop();
    exploredStates += 1;

    if (slotIdx === nSlots) {
      const score = objectiveCached(currentLoad, ctx.pending_rounds, cache);
      if (score < bestScore) {
        bestScore = score;
        bestNames = [...partialNames];
      }
      continue;
    }

    const candidates = ctx.candidates_per_slot[slotIdx];

    if (candidates.length === 0) {
      // No candidates — slot is structurally unfillable
      stack.push([slotIdx + 1, [...partialNames, null], currentLoad, used]);
      continue;
    }

    let placedAny = false;
    // Reverse iteration so first (best-score) candidate is popped first
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (used.has(candidate)) continue;

      placedAny = true;
      const newLoad = { ...currentLoad };
      newLoad[candidate] = (newLoad[candidate] || 0) + 1;

      // Optimistic bound pruning
      if (bestScore < Infinity) {
        const remaining = nSlots - slotIdx - 1 + lookaheadSlots;
        const bound = optimisticVarianceBound(Object.values(newLoad), remaining);
        if (bound >= bestScore) {
          continue;
        }
      }

      const newUsed = new Set(used);
      newUsed.add(candidate);
      stack.push([slotIdx + 1, [...partialNames, candidate], newLoad, newUsed]);
    }

    if (!placedAny) {
      // All pre-filtered candidates already used
      stack.push([slotIdx + 1, [...partialNames, null], currentLoad, used]);
    }
  }

  return [bestNames, bestScore, stack.length > 0, exploredStates];
}

export function searchRoundAssignment(ctx, maxStates = SEARCH_STATE_BUDGET) {
  const nSlots = ctx.slots.length;
  if (nSlots === 0) {
    return { assignments: [], errors: [], objective_score: 0, explored_states: 0, exhausted: false };
  }

  const cache = {};
  const [bestNames, bestScore, exhausted, exploredStates] = searchBestAssignment(ctx, maxStates, cache);

  let names;
  if (exhausted) {
    if (bestNames === null) {
      const [fallbackNames, fallbackScore] = greedyFallbackNames(ctx);
      names = fallbackNames;
      return {
        assignments: buildAssignments(ctx, names),
        errors: [],
        objective_score: fallbackScore,
        explored_states: exploredStates,
        exhausted: true,
      };
    }
    names = bestNames;
  } else {
    names = bestNames || Array(nSlots).fill(null);
  }

  return {
    assignments: buildAssignments(ctx, names),
    errors: [],
    objective_score: bestScore,
    explored_states: exploredStates,
    exhausted,
  };
}

function buildAssignments(ctx, names) {
  const assignments = [];
  for (let i = 0; i < ctx.slots.length; i++) {
    const slot = ctx.slots[i];
    const volunteer = (i < names.length && names[i]) || UNFILLED_VOLUNTEER;
    const jumper = volunteer !== UNFILLED_VOLUNTEER ? (ctx.volunteer_to_jumper[volunteer] || '') : '';
    assignments.push({
      job: slot.job_name,
      subteam: slot.subteam_tag,
      volunteer,
      jumper,
    });
  }
  return assignments;
}

// ────────────────────────────────────────────────────────────────────────────
// Slot Building
// ────────────────────────────────────────────────────────────────────────────

// RT-002: collapse subteam A/B variants of a job into a single `shared` slot.
// For FULL_TEAM rounds the team is not split, so Umpire Escort + Goal Umpire need
// only one volunteer each (subteam `shared` → any eligible). `shared` jobs pass through.
function collapseSplitJobs(jobs) {
  const collapsed = [];
  const seenSplit = new Set();
  for (const job of jobs) {
    const st = String(job.subteam || '').trim().toLowerCase();
    if (st === 'a' || st === 'b') {
      if (seenSplit.has(job.name)) continue;
      seenSplit.add(job.name);
      collapsed.push({ ...job, subteam: 'shared' });
    } else {
      collapsed.push(job);
    }
  }
  return collapsed;
}

function slotsForRound(jobs, homeAway, roundType = 'SPLIT') {
  if (homeAway.trim().toUpperCase() === 'B') {
    return [];
  }
  const effectiveJobs = String(roundType || 'SPLIT').toUpperCase() === 'FULL_TEAM'
    ? collapseSplitJobs(jobs)
    : jobs;
  const result = [];
  for (const job of effectiveJobs) {
    if (!isJobApplicableForRound(job, homeAway)) {
      continue;
    }
    for (const slot of jobSlots(job)) {
      result.push(slot);
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Consecutive Job Tracking
// ────────────────────────────────────────────────────────────────────────────

function updateConsecutiveJobMap(consecutiveJobMap, assignments, jumperToName = {}) {
  const newMap = { ...consecutiveJobMap };
  const assignedNow = {};

  for (const assignment of assignments) {
    const name = assignment.volunteer || (assignment.jumper && jumperToName[assignment.jumper]) || '';
    if (name && name !== UNFILLED_VOLUNTEER) {
      assignedNow[name] = assignment.job;
    }
  }

  // Update all tracked and newly assigned volunteers
  const allVols = new Set([...Object.keys(newMap), ...Object.keys(assignedNow)]);
  for (const vol of allVols) {
    const currentJob = assignedNow[vol];
    if (currentJob === undefined) {
      // Not assigned this round — streak broken
      delete newMap[vol];
    } else {
      const prev = newMap[vol];
      if (prev && prev[0] === currentJob) {
        newMap[vol] = [currentJob, prev[1] + 1];
      } else {
        newMap[vol] = [currentJob, 1];
      }
    }
  }

  return newMap;
}

// ────────────────────────────────────────────────────────────────────────────
// BBQ Tracking
// ────────────────────────────────────────────────────────────────────────────

function updateBBQAssigned(bbqSet, assignments, jumperToName = {}) {
  const result = new Set(bbqSet);
  for (const assignment of assignments) {
    const name = assignment.volunteer || (assignment.jumper && jumperToName[assignment.jumper]) || '';
    if (name && name !== UNFILLED_VOLUNTEER && assignment.job.toUpperCase() === 'BBQ') {
      result.add(name);
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Assignment Context
// ────────────────────────────────────────────────────────────────────────────

export function buildAssignmentContext(players, volunteers, splits, absences = []) {
  const volunteerSubteamByRound = {};
  const playerSubteam = {};

  // Build player_subteam map
  for (const split of splits) {
    playerSubteam[[split.round_id, split.jumper]] = split.subteam;
  }

  // Build absent set
  const absentSet = new Set();
  for (const absence of absences) {
    absentSet.add([String(absence.round), String(absence.jumper)].join('|'));
  }

  // Build volunteer_subteam_by_round
  for (const volunteer of volunteers) {
    const profile = parseVolunteer(volunteer);
    if (!profile.eligible) continue;

    for (const [playerKey, subteam] of Object.entries(playerSubteam)) {
      const [roundId, jumper] = playerKey.split(',');
      if (jumper === profile.jumper) {
        const absentKey = [roundId, jumper].join('|');
        if (!absentSet.has(absentKey)) {
          volunteerSubteamByRound[[roundId, profile.name]] = subteam;
        }
      }
    }
  }

  const eligibleVolunteers = volunteers
    .map(v => parseVolunteer(v))
    .filter(p => p.eligible);

  const preferredJobsByVolunteer = {};
  const avoidJobsByVolunteer = {};

  for (const profile of eligibleVolunteers) {
    preferredJobsByVolunteer[profile.name] = profile.preferred_jobs;
    avoidJobsByVolunteer[profile.name] = profile.avoid_jobs;
  }

  const jumperToPlayer = {};
  for (const player of players) {
    const jumper = cleanMetadata(player.jumper);
    const playerName = cleanMetadata(player.player_name);
    jumperToPlayer[jumper] = playerName;
  }

  const volunteerToJumper = {};
  const jumperToVolunteer = {};
  for (const profile of eligibleVolunteers) {
    volunteerToJumper[profile.name] = profile.jumper;
    jumperToVolunteer[profile.jumper] = profile.name;
  }

  return {
    player_subteam: playerSubteam,
    volunteer_subteam_by_round: volunteerSubteamByRound,
    absent_set: absentSet,
    eligible_volunteers: eligibleVolunteers,
    preferred_jobs_by_volunteer: preferredJobsByVolunteer,
    avoid_jobs_by_volunteer: avoidJobsByVolunteer,
    jumper_to_player: jumperToPlayer,
    volunteer_to_jumper: volunteerToJumper,
    jumper_to_volunteer: jumperToVolunteer,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Pending Round Specs
// ────────────────────────────────────────────────────────────────────────────

function buildPendingRoundSpec(
  roundId,
  isHomeRound,
  slots,
  eligibleVolunteers,
  volunteerSubteamByRound,
  avoidJobsByVolunteer,
  bbqAssignedThisSeason,
  consecutiveJobMap,
) {
  const candidatesPerSlot = [];
  for (const slot of slots) {
    const cands = filterCandidatesForSlot(
      slot,
      eligibleVolunteers,
      roundId,
      volunteerSubteamByRound,
      avoidJobsByVolunteer,
      bbqAssignedThisSeason,
      consecutiveJobMap,
    );
    candidatesPerSlot.push(cands.map(v => v.name));
  }

  return {
    round_id: roundId,
    is_home_round: isHomeRound,
    slots,
    candidates_per_slot: candidatesPerSlot,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main Allocation
// ────────────────────────────────────────────────────────────────────────────

export function rebalanceFutureRounds(data, options = {}) {
  const { seedRng } = options;
  const rng = makeRng(seedRng);

  const referenceData = data.reference_data || {};
  const roundSummary = data.round_summary || {};
  const rounds = referenceData.rounds || [];
  const jobs = (referenceData.jobs || []).map(j => parseJob(j));
  const volunteers = referenceData.volunteers || [];
  const splits = (referenceData.splits || []).map(s => parseSplit(s));
  const absences = referenceData.absences || [];
  const players = referenceData.players || [];

  const ctx = buildAssignmentContext(players, volunteers, splits, absences);

  // An OUT player cannot be assigned ANY job that round — filter them from the
  // candidate pool per round (shared AND subteam slots). Absence only gated A/B
  // slots before (via a missing subteam mapping), leaving shared jobs open.
  const eligibleForRound = (rid) =>
    ctx.eligible_volunteers.filter(v => !ctx.absent_set.has(`${rid}|${v.jumper}`));

  const existingRounds = roundSummary.rounds || [];
  const existingRoundMap = {};
  for (const roundEntry of existingRounds) {
    existingRoundMap[roundEntry.round] = roundEntry;
  }

  const fairnessLoad = fairnessLoadFromConfirmed(data);
  const updatedRounds = [];
  let bbqAssignedThisSeason = new Set();
  let consecutiveJobMap = {};
  let prevEntry = null;

  // Build pending round definitions
  const pendingRoundDefs = [];
  for (const rnd of rounds) {
    const roundDef = parseRound(rnd);
    const existingSchedule = existingRoundMap[roundDef.round_id];
    if (!existingSchedule || !isPreservedStatus(existingSchedule.status)) {
      pendingRoundDefs.push(rnd);
    }
  }

  // Process all rounds
  for (const rnd of rounds) {
    const roundDef = parseRound(rnd);
    const roundId = roundDef.round_id;
    const existingEntry = existingRoundMap[roundId];

    // Confirmed AND completed (locked) rounds pass through unchanged
    if (existingEntry && isPreservedStatus(existingEntry.status)) {
      updatedRounds.push(existingEntry);
      prevEntry = existingEntry;

      // Update consecutive and BBQ tracking from confirmed rounds
      consecutiveJobMap = updateConsecutiveJobMap(consecutiveJobMap, existingEntry.entries || [], ctx.jumper_to_volunteer);
      bbqAssignedThisSeason = updateBBQAssigned(bbqAssignedThisSeason, existingEntry.entries || [], ctx.jumper_to_volunteer);
      continue;
    }

    // Pending rounds: allocate
    const isHome = roundDef.home_away.trim().toLowerCase() === 'h';
    const slots = slotsForRound(jobs, roundDef.home_away, roundDef.round_type);

    // Build look-ahead specs for remaining pending rounds
    const pendingSpecs = [];
    const currentIdx = pendingRoundDefs.findIndex(
      r => cleanMetadata(r.round) === roundId,
    );
    if (currentIdx >= 0) {
      for (let i = currentIdx + 1; i < pendingRoundDefs.length; i++) {
        const futureRound = pendingRoundDefs[i];
        const futureDef = parseRound(futureRound);
        const futureSlots = slotsForRound(jobs, futureDef.home_away, futureDef.round_type);
        const futureIsHome = futureDef.home_away.trim().toLowerCase() === 'h';
        pendingSpecs.push(
          buildPendingRoundSpec(
            futureDef.round_id,
            futureIsHome,
            futureSlots,
            eligibleForRound(futureDef.round_id),
            ctx.volunteer_subteam_by_round,
            ctx.avoid_jobs_by_volunteer,
            bbqAssignedThisSeason,
            consecutiveJobMap,
          ),
        );
      }
    }

    // Get previous round job map
    const previousJobMap = prevEntry
      ? buildPreviousRoundJobMap(prevEntry, ctx)
      : {};

    // Identify volunteers already manually locked into a slot for this round.
    // They must not be assigned to any other slot by the allocator.
    const lockedVolunteers = new Set();
    for (const e of (existingEntry?.entries || [])) {
      if (e.slot_status === 'manual' && e.jumper) {
        const name = ctx.jumper_to_volunteer[String(e.jumper)];
        if (name) lockedVolunteers.add(name);
      }
    }

    // Build search context
    const searchCtx = buildRoundSearchContext(
      roundId,
      isHome,
      slots,
      eligibleForRound(roundId),
      ctx.volunteer_subteam_by_round,
      ctx.preferred_jobs_by_volunteer,
      ctx.avoid_jobs_by_volunteer,
      fairnessLoad,
      previousJobMap,
      bbqAssignedThisSeason,
      consecutiveJobMap,
      pendingSpecs,
      rng,
      ctx.volunteer_to_jumper,
      lockedVolunteers,
    );

    // Search for assignments
    const result = searchRoundAssignment(searchCtx);

    // Update fairness load — include locked volunteers so future-round fairness is correct
    for (const assignment of result.assignments) {
      if (assignment.volunteer && assignment.volunteer !== UNFILLED_VOLUNTEER) {
        fairnessLoad[assignment.volunteer] = (fairnessLoad[assignment.volunteer] || 0) + 1;
      }
    }
    for (const name of lockedVolunteers) {
      fairnessLoad[name] = (fairnessLoad[name] || 0) + 1;
    }

    // Update consecutive and BBQ tracking
    consecutiveJobMap = updateConsecutiveJobMap(consecutiveJobMap, result.assignments);
    bbqAssignedThisSeason = updateBBQAssigned(bbqAssignedThisSeason, result.assignments);

    // Build round entry — jumper is canonical; volunteer name is resolved at display time
    const roundEntry = {
      ...rnd,
      status: 'scheduled',
      entries: result.assignments.map((assignment, idx) => {
        const existingEntry = (existingRoundMap[roundId]?.entries || [])[idx];
        return {
          round: roundId,
          job: assignment.job,
          subteam: assignment.subteam,
          jumper: assignment.jumper,
          slot_index: idx,
          slot_status: existingEntry?.slot_status === 'manual'
            ? 'manual'
            : (!assignment.jumper ? 'unfilled' : 'filled'),
          certifications: [],
        };
      }),
    };

    updatedRounds.push(roundEntry);
    prevEntry = roundEntry;
  }

  return {
    round_summary: {
      rounds: updatedRounds,
    },
  };
}

function buildPreviousRoundJobMap(roundEntry, ctx) {
  const map = {};
  const jumperToVolunteer = ctx?.jumper_to_volunteer || {};
  const entries = roundEntry.entries || [];
  for (const entry of entries) {
    if (!entry.jumper) continue;
    const name = jumperToVolunteer[entry.jumper] || entry.volunteer || '';
    if (name && name !== UNFILLED_VOLUNTEER) {
      map[name] = entry.job;
    }
  }
  return map;
}

/**
 * Main export: allocate() wraps rebalanceFutureRounds for use in the SPA.
 * This function is called by the reallocate() handler in index.js.
 */
export function allocate(rosterData, options = {}) {
  return rebalanceFutureRounds(rosterData, options);
}

export default {
  SEARCH_STATE_BUDGET,
  allocate,
  rebalanceFutureRounds,
  buildAssignmentContext,
  fairnessLoadFromConfirmed,
  filterCandidatesForSlot,
  slotScore,
  objective,
  optimisticVarianceBound,
  parseVolunteer,
  parseJob,
  parseSplit,
  parseRound,
};
