'use strict';

// @front-end
// element: add-player-cascade
// philosophy: single-source-of-truth (reference_data is the one roster; a mid-season
//             add must derive every dependent row, never leave the app to guess)
// paradigm: pure functions (state in → replacement arrays out; zero DOM, zero window.*)
// intent: when a player joins after some rounds are locked, slot them into the season
//         correctly — OUT for locked/past rounds, INTO the remaining rounds (A/B for
//         SPLIT rounds keeping numbers balanced; IN for FULL_TEAM rounds)
// customer: developer
// binding: one-way
// breadcrumbs:
//   - "the 'current round' = highest non-BYE round that is confirmed/completed (locked)"
//   - "FULL_TEAM future rounds get NO split row — the whole team is in (allocator
//      collapses A/B jobs to shared for FULL_TEAM)"

const PRESERVED = new Set(['confirmed', 'completed']);
const isBye = r => !!r && r.home_away === 'B';
const roundNum = r => Number(r && r.round);
const isSplitRound = r => String((r && r.round_type) || 'SPLIT').toUpperCase() !== 'FULL_TEAM';

// Highest non-BYE round number whose status is confirmed/completed (locked). 0 if none.
export function computeCurrentRound(rounds) {
  return (rounds || [])
    .filter(r => !isBye(r) && PRESERVED.has(r && r.status) && Number.isFinite(roundNum(r)))
    .reduce((max, r) => Math.max(max, roundNum(r)), 0);
}

// The new player is OUT (absent) for every non-BYE round up to and including current.
export function computeAbsencesForNewPlayer(jumper, rounds, currentRound) {
  const j = String(jumper);
  return (rounds || [])
    .filter(r => !isBye(r) && Number.isFinite(roundNum(r)) && roundNum(r) <= currentRound)
    .map(r => ({ round: String(r.round), jumper: j }));
}

// For every future (> current) non-BYE SPLIT round, assign the new player to the
// smaller of subteam A/B (tie → 'A') to maintain numbers balance. FULL_TEAM rounds
// get NO split row (whole team is in). Returns [{ round, jumper, subteam }].
export function computeBalancedSplitsForNewPlayer(jumper, rounds, existingSplits, currentRound) {
  const j = String(jumper);
  const splits = existingSplits || [];
  const out = [];
  for (const r of (rounds || [])) {
    if (isBye(r) || !Number.isFinite(roundNum(r)) || roundNum(r) <= currentRound) continue;
    if (!isSplitRound(r)) continue; // FULL_TEAM → IN, no split needed
    let a = 0, b = 0;
    for (const s of splits) {
      if (String(s.round) !== String(r.round)) continue;
      const st = String(s.subteam || '').toUpperCase();
      if (st === 'A') a++;
      else if (st === 'B') b++;
    }
    out.push({ round: String(r.round), jumper: j, subteam: b < a ? 'B' : 'A' });
  }
  return out;
}

// Orchestrate the full cascade for adding one player. Returns full replacement arrays
// for reference_data (players, volunteers, splits, absences) — each is the existing
// array with the new player's rows folded in (idempotent: re-adding is a no-op for
// players/volunteers, and rebuilds splits/absences for that jumper).
export function buildAddPlayerCascade(data, { jumper, player_name }) {
  const ref = (data && data.reference_data) || {};
  const rounds = (data && data.round_summary && data.round_summary.rounds) || [];
  const j = String(jumper);
  const currentRound = computeCurrentRound(rounds);

  const players = [...(ref.players || [])];
  if (!players.some(p => String(p.jumper) === j)) players.push({ jumper: j, player_name });

  const volunteers = [...(ref.volunteers || [])];
  if (!volunteers.some(v => String(v.jumper) === j)) {
    volunteers.push({ jumper: j, volunteer_name: player_name || '', eligible: 'Y', preferred_job: '', avoid_jobs: '' });
  }

  const absences = [
    ...(ref.absences || []).filter(a => String(a.jumper) !== j),
    ...computeAbsencesForNewPlayer(j, rounds, currentRound),
  ];
  const splits = [
    ...(ref.splits || []).filter(s => String(s.jumper) !== j),
    ...computeBalancedSplitsForNewPlayer(j, rounds, ref.splits || [], currentRound),
  ];

  return { players, volunteers, splits, absences, currentRound };
}
