'use strict';

// @front-end
// element: tm-data
// intent: ONE validated path for TM_DATA snapshots — shared by file export/import AND the
//         Beam P2P transfer. Pure: no DOM, no window.*, dependencies injected.
// customer: developer
// binding: one-way
// breadcrumbs:
//   - "buildTmSnapshot mirrors the old exportTmData body (roster back-filled from volunteers.eligible)"
//   - "applyTmSnapshot takes an optional best-effort backup() for undo before it overwrites"

// Build the export snapshot from store data. Roster is back-filled from volunteers.eligible
// when user_team.roster is absent (USER_SPA name resolution).
export function buildTmSnapshot(data, now = new Date()) {
  if (!data) return null;
  const existingRoster = data.user_team?.roster || [];
  const roster = existingRoster.length > 0
    ? existingRoster
    : (data.volunteers?.eligible || []).map(v => ({ jumper: String(v.jumper), name: v.volunteer || '' }));
  return {
    user_team: { ...(data.user_team || {}), roster },
    round_summary: data.round_summary || { rounds: [] },
    reference_data: data.reference_data || {},
    volunteers: data.volunteers || { eligible: [], ineligible: [] },
    balance: data.balance || null,
    constraints: data.constraints || {},
    matrix: data.matrix || null,
    season_overview: data.season_overview || {},
    _exported_at: now.toISOString(),
    _schema_version: 1,
  };
}

// Validate + normalize a parsed snapshot. Returns { ok, error?, normalized? }.
export function validateTmSnapshot(parsed) {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Invalid file — not a tm-data object' };
  }
  if (!parsed.user_team) {
    return { ok: false, error: 'Invalid file — missing required key: user_team' };
  }
  const normalized = { ...parsed };
  if (!normalized.round_summary)  normalized.round_summary  = { rounds: [] };
  if (!normalized.reference_data) normalized.reference_data = {};
  const ut = { ...(normalized.user_team || {}) };
  if (!ut.roster || ut.roster.length === 0) {
    ut.roster = (normalized.volunteers?.eligible || []).map(v => ({ jumper: String(v.jumper), name: v.volunteer || '' }));
  }
  normalized.user_team = ut;
  return { ok: true, normalized };
}

// Apply a normalized snapshot to the store. Deps injected. An optional best-effort
// backup() runs BEFORE the overwrite so the import can be undone.
export async function applyTmSnapshot(normalized, { persist, whenPersisted, dispatch, backup } = {}) {
  if (typeof backup === 'function') { try { await backup(); } catch (_) { /* best effort */ } }
  persist(normalized);
  if (whenPersisted) await whenPersisted();
  dispatch({ type: 'load-report', payload: { filename: 'from-import', report: normalized } });
}

// Download filename for a snapshot, e.g. tm-data-vermont-u9-purple-2026-07-11.json.
export function tmDataFilename(snapshot, now = new Date()) {
  const slug = String(snapshot?.user_team?.team_name || 'team')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `tm-data-${slug}-${now.toISOString().slice(0, 10)}.json`;
}

// Small human summary used by the Beam confirm card (incoming vs local).
export function summariseSnapshot(snap) {
  const rounds = (snap?.round_summary?.rounds || []).filter(r => r && r.home_away !== 'B').length;
  const players = (snap?.reference_data?.players || []).length;
  return {
    team_name: snap?.user_team?.team_name || '—',
    exported_at: snap?._exported_at || null,
    rounds,
    players,
  };
}
