'use strict';
// USP-020..022, USP-053, USP-060: Onboarding wizard for USER_SPA

const REQUIRED_IMPORT_KEYS = ['user_team'];

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchClubs() {
  try {
    const res = await fetch('./data/clubs.json');
    if (!res.ok) throw new Error('clubs unavailable');
    return await res.json();
  } catch (_) {
    return [];
  }
}

async function fetchRoundsTemplate() {
  try {
    const res = await fetch('./data/rounds-template.json');
    if (!res.ok) throw new Error('rounds template unavailable');
    return await res.json();
  } catch (_) {
    return [];
  }
}

function validateImportFile(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    throw new Error('Invalid file — could not parse JSON');
  }
  for (const key of REQUIRED_IMPORT_KEYS) {
    if (!(key in parsed)) {
      throw new Error(`Import failed: missing required key '${key}'`);
    }
  }
  return parsed;
}

function showWizardEl() {
  const el = document.getElementById('wizard');
  if (el) el.style.display = 'flex';
}

function hideWizardEl() {
  const el = document.getElementById('wizard');
  if (el) el.style.display = 'none';
}

function setWizardContent(html) {
  const el = document.getElementById('wizardContent');
  if (el) el.innerHTML = html;
}

function showWizardError(msg) {
  const existing = document.querySelector('.wizard-error');
  if (existing) { existing.textContent = msg; return; }
  const el = document.getElementById('wizardContent');
  if (!el) return;
  const err = document.createElement('p');
  err.className = 'wizard-error';
  err.setAttribute('data-wizard-error', '');
  err.textContent = msg;
  err.style.cssText = 'color:#e55;margin-top:0.75rem;font-size:0.85rem';
  el.appendChild(err);
}

function clearWizardError() {
  document.querySelectorAll('.wizard-error').forEach(e => e.remove());
}

// ── Roster grid ───────────────────────────────────────────────────────────

function rosterGridHtml(rows = 5) {
  const rowsHtml = Array.from({ length: rows }, (_, i) => `
    <div class="wizard-roster-row">
      <input class="jumper-input" type="text" placeholder="#" aria-label="Jumper number row ${i + 1}" style="width:60px">
      <input class="name-input" type="text" placeholder="Player name" aria-label="Player name row ${i + 1}" style="flex:1">
    </div>`).join('');
  return `<div id="wizardRoster" style="display:flex;flex-direction:column;gap:4px;margin-top:8px">${rowsHtml}</div>`;
}

function getRosterValues() {
  const rows = document.querySelectorAll('#wizardRoster .wizard-roster-row');
  return Array.from(rows)
    .map(row => ({
      jumper: row.querySelector('.jumper-input')?.value?.trim() || '',
      name: row.querySelector('.name-input')?.value?.trim() || '',
    }))
    .filter(r => r.jumper || r.name);
}

// ── Start fresh flow ──────────────────────────────────────────────────────

async function showStartFresh(clubs, onComplete) {
  const clubOpts = clubs.map(c =>
    `<option value="${escHtml(String(c.club_id))}">${escHtml(c.name)}</option>`
  ).join('');

  setWizardContent(`
    <h2 style="margin-bottom:1rem">Set up your team</h2>
    <div style="margin-bottom:12px">
      <label style="display:block;margin-bottom:4px;font-size:0.85rem">Club</label>
      <select id="wizardClubPicker" style="width:100%">
        <option value="">— select club —</option>
        ${clubOpts}
      </select>
    </div>
    <div style="margin-bottom:12px">
      <label style="display:block;margin-bottom:4px;font-size:0.85rem">Team name</label>
      <input id="wizardTeamName" type="text" placeholder="e.g. Vermont U9 Purple" style="width:100%">
    </div>
    <div style="margin-bottom:12px">
      <label style="display:block;margin-bottom:4px;font-size:0.85rem">Roster (optional)</label>
      ${rosterGridHtml(5)}
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="wizardBack" class="btn" type="button">← Back</button>
      <button id="wizardConfirm" class="btn btn-primary" type="button">Confirm</button>
    </div>
  `);

  document.getElementById('wizardBack').addEventListener('click', () => showLanding(onComplete));

  document.getElementById('wizardConfirm').addEventListener('click', async () => {
    clearWizardError();
    const clubId = document.getElementById('wizardClubPicker')?.value || '';
    const teamName = document.getElementById('wizardTeamName')?.value?.trim() || '';
    if (!teamName) { showWizardError('Please enter a team name'); return; }

    const roster = getRosterValues();
    const state = {
      user_team: { club_id: clubId, team_name: teamName, roster },
      round_summary: { rounds: [] },
      reference_data: { clubs, locations: [], jobs: [], players: [], volunteers: [], splits: [] },
    };

    // Offer rounds template seeding
    await showSeedRoundsPrompt(teamName, state, onComplete);
  });
}

// ── Rounds template seeding ───────────────────────────────────────────────

async function showSeedRoundsPrompt(teamName, state, onComplete) {
  const template = await fetchRoundsTemplate();
  const matching = template.filter(r =>
    r.team1 === teamName || r.team2 === teamName
  );

  if (matching.length === 0) {
    hideWizardEl();
    onComplete(state);
    return;
  }

  setWizardContent(`
    <h2 style="margin-bottom:0.75rem">Seed rounds from template?</h2>
    <p style="margin-bottom:1rem;font-size:0.9rem">
      Found <strong>${matching.length}</strong> games for <em>${escHtml(teamName)}</em>
      in the 2026 season fixture. Pre-fill your rounds list?
    </p>
    <div id="wizardSeedRounds" style="display:block">
      <div style="display:flex;gap:8px">
        <button id="wizardSeedDecline" class="btn" type="button">No thanks</button>
        <button id="wizardSeedAccept" class="btn btn-primary" type="button">Yes, seed rounds</button>
      </div>
    </div>
  `);

  document.getElementById('wizardSeedDecline').addEventListener('click', () => {
    hideWizardEl();
    onComplete(state);
  });

  document.getElementById('wizardSeedAccept').addEventListener('click', () => {
    const seeded = matching.map((r, idx) => {
      const roundNum = idx + 1;
      const isHome = r.team1 === teamName;
      const opposition = isHome ? r.team2 : r.team1;
      // parse "Sunday, 19 April 2026" → "2026-04-19"
      const dateStr = parseFixtureDate(r.date);
      const venue = r.venue ? r.venue.split('/')[0].trim() : '';
      return {
        round: roundNum,
        date: dateStr,
        time: r.time || '',
        home_away: isHome ? 'h' : 'a',
        opposition,
        location: venue,
        opposition_club_id: '',
        location_id: '',
      };
    });
    state.round_summary = { rounds: seeded };
    hideWizardEl();
    onComplete(state);
  });
}

function parseFixtureDate(raw) {
  if (!raw) return '';
  // already ISO: "2026-04-19" → return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // "Sunday, 19 April 2026" or "19 April 2026" → "2026-04-19"
  const months = {
    January: '01', February: '02', March: '03', April: '04',
    May: '05', June: '06', July: '07', August: '08',
    September: '09', October: '10', November: '11', December: '12',
  };
  const m = raw.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!m) return '';
  const day = m[1].padStart(2, '0');
  const month = months[m[2]] || '01';
  const year = m[3];
  return `${year}-${month}-${day}`;
}

// ── Import flow ───────────────────────────────────────────────────────────

function showImport(onComplete) {
  setWizardContent(`
    <h2 style="margin-bottom:1rem">Import team data</h2>
    <p style="font-size:0.9rem;margin-bottom:1rem">
      Choose a <code>tm-data-*.json</code> file exported from any FootyManager instance.
    </p>
    <div id="wizardImportZone" style="border:2px dashed var(--border,#444);padding:2rem;text-align:center;border-radius:6px;margin-bottom:12px">
      <input id="wizardImportFile" type="file" accept=".json" style="display:none">
      <label for="wizardImportFile" style="cursor:pointer;font-size:0.9rem">
        Click to choose a file <br><span style="font-size:0.8rem;color:var(--muted,#888)">or drop it here</span>
      </label>
    </div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button id="wizardBack" class="btn" type="button">← Back</button>
    </div>
  `);

  const zone = document.getElementById('wizardImportZone');
  const fileInput = document.getElementById('wizardImportFile');

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) processImportFile(fileInput.files[0], onComplete);
  });

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.borderColor = 'var(--accent,#4f8)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.style.borderColor = '';
    const file = e.dataTransfer?.files?.[0];
    if (file) processImportFile(file, onComplete);
  });

  document.getElementById('wizardBack').addEventListener('click', () => showLanding(onComplete));
}

function processImportFile(file, onComplete) {
  clearWizardError();
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = validateImportFile(e.target.result);
      // Ensure required sub-structures exist
      if (!parsed.round_summary) parsed.round_summary = { rounds: [] };
      if (!parsed.reference_data) parsed.reference_data = {};
      hideWizardEl();
      onComplete(parsed);
    } catch (err) {
      showWizardError(err.message);
    }
  };
  reader.onerror = () => showWizardError('Could not read file');
  reader.readAsText(file);
}

// ── Landing screen ────────────────────────────────────────────────────────

async function showLanding(onComplete) {
  const clubs = await fetchClubs();

  setWizardContent(`
    <h2 style="margin-bottom:0.5rem">Welcome to FootyManager</h2>
    <p style="margin-bottom:1.5rem;font-size:0.9rem;color:var(--muted,#aaa)">
      How would you like to get started?
    </p>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <button id="wizardStartFresh" class="btn btn-primary" type="button" style="flex:1;min-width:140px">
        ✦ Start fresh<br>
        <span style="font-size:0.75rem;font-weight:400">Enter my team details</span>
      </button>
      <button id="wizardImportBtn" class="btn" type="button" style="flex:1;min-width:140px">
        ↑ Import<br>
        <span style="font-size:0.75rem;font-weight:400">Load from a saved file</span>
      </button>
    </div>
  `);

  document.getElementById('wizardStartFresh').addEventListener('click', () => showStartFresh(clubs, onComplete));
  document.getElementById('wizardImportBtn').addEventListener('click', () => showImport(onComplete));
}

// ── Public API ────────────────────────────────────────────────────────────

export async function showWizard(onComplete) {
  showWizardEl();
  await showLanding(onComplete);
}
