'use strict';

// @front-end
// element: data-records
// philosophy: recognition-over-recall / structural-honesty
// paradigm: layered (pure data helpers under the data-panel CRUD UI)
// intent: own the fiddly data-panel record logic (home-ground lookup, robust row
//         identity for pk-less tables, and lossless job-name normalisation) as pure
//         functions so the dialog wiring can't reintroduce the wrong-row and
//         comma-garbage bugs
// customer: developer
// binding: one-way
// breadcrumbs:
//   - "PURE module: zero DOM, zero window.*, zero side effects"
//   - "jobs reference rows have NO job_id — job_name is the only stable key"
//   - "the allocator reads volunteer prefs as semicolon-delimited job-NAME strings"
//   - "row identity prefers 'pk:<id>' but falls back to 'ix:<index>' when pk is absent/dup"
// improve?: "if a real job_id is ever added to the data, prefer it over job_name here"

// ── RLOC: home grounds for a club ──────────────────────────────────────────────

// All locations whose club_id matches, sorted by display name (string-safe compare).
export function homeGroundsForClub(locations, clubId) {
  return (locations || [])
    .filter(l => String(l.club_id) === String(clubId))
    .slice()
    .sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
}

export function firstHomeGroundId(locations, clubId) {
  return homeGroundsForClub(locations, clubId)[0]?.location_id ?? '';
}

export function firstHomeGroundName(locations, clubId) {
  return homeGroundsForClub(locations, clubId)[0]?.display_name ?? '';
}

// ── DJE: robust row identity for the data dialog ───────────────────────────────

// A stable per-row reference. Prefers the schema primary key; falls back to the
// row index when the pk is absent/empty (jobs have no job_id) OR when the pk value is
// DUPLICATED in the list (two volunteers on one jumper would otherwise both resolve
// to the first row) — so every Edit/Delete acts on its OWN row.
export function encodeRowRef(record, schema, index, pkIsDuplicated = false) {
  const pkVal = record == null ? undefined : record[schema.pk];
  if (!pkIsDuplicated && pkVal != null && String(pkVal) !== '') {
    return 'pk:' + encodeURIComponent(String(pkVal));
  }
  return 'ix:' + index;
}

// Resolve the exact record an edit button belongs to.
export function resolveRecordForEdit(records, schema, idEncoded) {
  if (idEncoded == null) return null;
  const list = records || [];
  if (idEncoded.startsWith('ix:')) {
    const i = Number(idEncoded.slice(3));
    return list[i] ?? null;
  }
  if (idEncoded.startsWith('pk:')) {
    const id = decodeURIComponent(idEncoded.slice(3));
    return list.find(r => String(r[schema.pk]) === id) ?? null;
  }
  // Legacy bare id (no prefix) — treat as a pk value.
  const id = decodeURIComponent(idEncoded);
  return list.find(r => String(r[schema.pk]) === id) ?? null;
}

// ── DVE: job-name preference normalisation (allocator-safe) ────────────────────

// Normalise any stored value (semicolon/comma string, array of names, null) into a
// clean array of job NAMES — never NaN, never empty tokens, never comma garbage.
// When `jobs` is supplied, tokens are validated against the known job_name set.
export function normalizeJobNames(value, jobs = []) {
  const known = new Set((jobs || []).map(j => String(j.job_name)));
  const hasKnown = known.size > 0;

  let tokens;
  if (value == null) {
    tokens = [];
  } else if (Array.isArray(value)) {
    tokens = value;
  } else {
    tokens = String(value).split(/[;,]/);
  }

  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name) continue;
    if (hasKnown && !known.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Serialise a job-name array back to the canonical semicolon string the allocator
// reads. Empty → '' (never ',,' / ',,,,,,').
export function serializeJobNames(names) {
  return normalizeJobNames(names).join(';');
}
