'use strict';
// USP-020..022, USP-053, USP-060: Onboarding wizard for USER_SPA
// 4-step progressive flow: Club → Grade → Player count → Team name → "Let's Go!"
//
// ═══════════════════════════════════════════════════════════════════════════
// This file is organised into three bounded sections (WIZ2-003):
//   • WizardLogic     — pure functions: draft schema, import validation,
//                       roster/jumper generation, round seeding. No DOM.
//   • WizardTemplates — functions that produce/inject HTML into the wizard.
//   • WizardEvents    — functions that wire listeners and drive the flow.
// The WizardLogic functions are exported for unit testing (wizard-logic.test.mjs).
// ═══════════════════════════════════════════════════════════════════════════

const DRAFT_KEY = 'footy-wizard-draft';
const DRAFT_SCHEMA_VERSION = 1;            // WIZ2-004/006/007
const REQUIRED_IMPORT_KEYS = ['user_team'];

// ════════════════════════ WizardLogic (pure, exported) ════════════════════

export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} unavailable`);
    return await res.json();
  } catch (_) {
    return [];
  }
}

// ── Draft persistence (schema-versioned) ──────────────────────────────────

// WIZ2-006: every saved draft carries the current schemaVersion.
export function saveDraft(draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ schemaVersion: DRAFT_SCHEMA_VERSION, ...draft }));
  } catch (_) {}
}

// WIZ2-004/007: a draft with a missing or incompatible schemaVersion is
// discarded rather than silently resumed into a broken state.
export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.schemaVersion !== DRAFT_SCHEMA_VERSION) {
      if (parsed) clearDraft();
      return null;
    }
    return parsed;
  } catch (_) { clearDraft(); return null; }
}

export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
}

// WIZ2-008: seed a round_summary from the fixture template for the chosen grade.
// Returns [] when the template has no fixtures for that grade (83 of 84 grades),
// so callers can surface a reassurance message instead of a silent empty season.
export function seedRoundsForGrade(roundsTemplate, gradeName, clubName) {
  const club = (clubName || '').toLowerCase();
  return (roundsTemplate || [])
    .filter(r => r.grade === gradeName)
    .map(r => ({
      round:              r.round,
      date:               r.date,
      time:               r.time || '08:45 AM',
      home_away:          club && r.team1?.toLowerCase().includes(club) ? 'h'
                        : club && r.team2?.toLowerCase().includes(club) ? 'a'
                        : '',
      opposition_club_id: '',
      location_id:        '',
      extra_notes:        '',
    }));
}

// ════════════════════════ WizardTemplates ═════════════════════════════════
// Functions below build/inject the wizard's HTML and manage its DOM chrome.

// ── Wizard DOM helpers ────────────────────────────────────────────────────

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
  // WIZ2-001: move focus to the first interactive control of the new screen so
  // keyboard and screen-reader users land where they can act.
  focusFirstInteractive(el);
}

function focusFirstInteractive(container) {
  if (!container || typeof container.querySelector !== 'function') return;
  const target = container.querySelector('select, input, button, a[href], [tabindex]:not([tabindex="-1"])');
  if (target && typeof target.focus === 'function') {
    requestAnimationFrame(() => target.focus());
  }
}

function showWizardError(msg) {
  const existing = document.querySelector('.wizard-error');
  if (existing) { existing.textContent = msg; return; }
  const el = document.getElementById('wizardContent');
  if (!el) return;
  const err = document.createElement('p');
  err.className = 'wizard-error';
  err.setAttribute('data-wizard-error', '');
  err.setAttribute('role', 'alert');   // WIZ2: import errors announced to AT
  err.textContent = msg;
  err.style.cssText = 'color:#e55;margin-top:0.75rem;font-size:0.85rem';
  el.appendChild(err);
}

function clearWizardError() {
  document.querySelectorAll('.wizard-error').forEach(e => e.remove());
}

// ── Wizard chrome (Back + Start over, outside wizardContent) ──────────────

function setWizardChrome({ showBack = false, onBack = null }) {
  let chrome = document.getElementById('wizardChrome');
  if (!chrome) {
    chrome = document.createElement('div');
    chrome.id = 'wizardChrome';
    chrome.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding-top:12px;border-top:1px solid var(--border,#333)';
    const box = document.getElementById('wizardBox');
    if (box) box.appendChild(chrome);
  }
  chrome.innerHTML = `
    ${showBack ? '<button id="wizardBackBtn" class="btn" type="button" style="font-size:0.8rem">← Back</button>' : '<span></span>'}
    <button id="wizardStartOver" class="btn" type="button" style="font-size:0.75rem;color:var(--muted,#888)">Start over</button>
  `;
  if (showBack && onBack) {
    chrome.querySelector('#wizardBackBtn').addEventListener('click', onBack);
  }
  // Start over confirms first (WIZ2-011), then clears the draft and restarts.
  chrome.querySelector('#wizardStartOver').addEventListener('click', () => {
    showConfirmDestructive('Discard your setup progress and start over?', () => {
      clearDraft();
      // Will be re-assigned by the outer showWizard closure — use event to signal
      document.dispatchEvent(new CustomEvent('wizard-restart'));
    });
  });
}

function removeWizardChrome() {
  const chrome = document.getElementById('wizardChrome');
  if (chrome) chrome.remove();
}

// WIZ2-011: a confirm overlay shown before any destructive draft-discard action,
// so a mis-tap on a phone cannot silently wipe in-progress setup. Rendered as an
// overlay (not a content replacement) so Cancel leaves the underlying screen intact.
function showConfirmDestructive(message, onConfirm) {
  const existing = document.getElementById('wizardConfirm');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'wizardConfirm';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'Confirm discard');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  ov.innerHTML = `<div style="background:var(--bg2,#17171b);border:1px solid var(--border,#333);border-radius:8px;padding:20px;max-width:300px;text-align:center">
      <p style="margin-bottom:16px;font-size:0.9rem">${escHtml(message)}</p>
      <div style="display:flex;gap:8px">
        <button id="wizardConfirmYes" class="btn btn-primary" type="button" style="flex:1">Yes, discard</button>
        <button id="wizardConfirmNo" class="btn" type="button" style="flex:1">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  document.getElementById('wizardConfirmYes').addEventListener('click', () => { ov.remove(); onConfirm(); });
  document.getElementById('wizardConfirmNo').addEventListener('click', () => ov.remove());
  requestAnimationFrame(() => document.getElementById('wizardConfirmNo')?.focus());
}

// ── Random name + jumper generation ──────────────────────────────────────

export function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

export function buildRoster(randomNames, count) {
  const names = pickRandom(randomNames, Math.min(count, randomNames.length));
  const jumpers = pickRandom(Array.from({ length: 51 }, (_, i) => i + 1), count);
  return names.map((name, i) => ({ jumper: String(jumpers[i] ?? (i + 1)), name }));
}

// ════════════════════════ WizardEvents ════════════════════════════════════
// Functions below wire listeners and drive the step-by-step flow.

// ── Import flow ───────────────────────────────────────────────────────────

// WIZ2-002: parse + validate an imported file, throwing a human-readable error.
export function validateImportFile(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    throw new Error('Invalid file — could not parse JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Import failed: file is not a team-data object');
  }
  for (const key of REQUIRED_IMPORT_KEYS) {
    if (!(key in parsed)) {
      throw new Error(`Import failed: missing required key '${key}'`);
    }
  }
  return parsed;
}

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
}

function processImportFile(file, onComplete) {
  clearWizardError();
  const reader = new FileReader();
  reader.onload = (e) => {
    let parsed;
    try {
      parsed = validateImportFile(e.target.result);
      if (!parsed.round_summary) parsed.round_summary = { rounds: [] };
      if (!parsed.reference_data) parsed.reference_data = {};
    } catch (err) {
      showWizardError(err.message);   // WIZ2-002: validation errors keep the wizard open
      return;
    }
    // Hide immediately so the customer sees no lingering wizard; if the async
    // completion fails, re-show with an error rather than dead-ending (WIZ2-009).
    clearDraft();
    hideWizardEl();
    removeWizardChrome();
    Promise.resolve(onComplete(parsed)).catch((err) => {
      showWizardEl();
      showWizardError(`Import failed to load: ${err?.message || err}`);
    });
  };
  reader.onerror = () => showWizardError('Could not read file');
  reader.readAsText(file);
}

// ── Completion screen ─────────────────────────────────────────────────────

function showCompletionScreen(state, onComplete, opts = {}) {
  const { user_team } = state;
  const roster = user_team.roster || [];
  const previewRows = roster.slice(0, 5).map(r =>
    `<div style="display:flex;justify-content:space-between;padding:2px 0">
       <span>${escHtml(r.name)}</span>
       <span style="color:var(--muted,#888)">#${escHtml(r.jumper)}</span>
     </div>`
  ).join('');
  const more = roster.length > 5 ? `<div style="color:var(--muted,#888);font-size:0.8rem;margin-top:4px">… and ${roster.length - 5} more</div>` : '';

  // WIZ2-008: reassurance when the grade has no fixture template.
  const emptyRoundsNote = opts.emptyRounds
    ? `<p class="wizard-empty-rounds" role="alert" style="background:var(--warn-bg,#2c270a);color:var(--warn-fg,#f5c842);padding:10px 12px;border-radius:6px;font-size:0.82rem;margin-bottom:14px">
         No fixture template exists yet for ${escHtml(opts.gradeName || 'this grade')} — your season starts empty.
         You can add rounds any time under DATA → Rounds.
       </p>`
    : '';

  setWizardContent(`
    <div class="wizard-completion">
      <h2 style="margin-bottom:0.25rem">✦ ${escHtml(user_team.team_name)}</h2>
      <p style="font-size:0.85rem;color:var(--muted,#888);margin-bottom:1rem">
        ${escHtml(user_team.club_name)} · ${escHtml(user_team.grade_name)} · ${escHtml(user_team.age_group)}
        ${user_team.gender ? ' · ' + escHtml(user_team.gender) : ''}
        · ${roster.length} player${roster.length !== 1 ? 's' : ''}
      </p>
      ${emptyRoundsNote}
      <div class="wizard-roster-preview">${previewRows}${more}</div>
      <p class="wizard-hint" style="margin-bottom:16px">
        You can edit player names and numbers any time in the App under DATA.
      </p>
      <p class="wizard-error" role="alert" id="wizardCompletionError" style="display:none;color:#e55;margin-bottom:12px;font-size:0.85rem"></p>
      <button id="wizardLetsGo" class="btn btn-primary" type="button"
              style="width:100%;padding:14px;font-size:1.05rem">
        ✦ Let's Go!
      </button>
    </div>
  `);

  // WIZ2-009: disable on first click (no double-submit); wrap the async
  // completion so an IDB/persist failure surfaces instead of dead-ending with
  // the wizard already hidden and the app never shown.
  const letsGo = document.getElementById('wizardLetsGo');
  letsGo.addEventListener('click', async () => {
    if (letsGo.disabled) return;
    letsGo.disabled = true;
    letsGo.textContent = 'Setting up…';
    try {
      clearDraft();
      await onComplete(state);
      hideWizardEl();
      removeWizardChrome();
    } catch (err) {
      const errEl = document.getElementById('wizardCompletionError');
      if (errEl) { errEl.textContent = `Setup failed: ${err?.message || err}. Please try again.`; errEl.style.display = 'block'; }
      letsGo.disabled = false;
      letsGo.textContent = "✦ Let's Go!";
    }
  });
}

// ── 4-step progressive flow ───────────────────────────────────────────────

async function showStartFresh(refData, draft, onComplete) {
  const { clubs, grades, randomNames, roundsTemplate, jobs, locations } = refData;

  // State
  let selectedClub   = draft?.selectedClub  || null;
  let selectedGrade  = draft?.selectedGrade || null;
  let playerCount    = draft?.playerCount   || null;
  let roster         = draft?.roster        || null;
  let teamName       = draft?.teamName      || '';

  const clubOpts = clubs
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${escHtml(String(c.club_id))}"
      ${selectedClub && String(selectedClub.club_id) === String(c.club_id) ? 'selected' : ''}>
      ${escHtml(c.name)}</option>`).join('');

  const gradeOpts = grades
    .map(g => `<option value="${escHtml(String(g.grade_id))}"
      ${selectedGrade && String(selectedGrade.grade_id) === String(g.grade_id) ? 'selected' : ''}>
      ${escHtml(g.grade_name)}</option>`).join('');

  setWizardContent(`
    <div class="wizard-step-counter" id="wzCounter" role="status" aria-live="polite" aria-label="Wizard step">1 / 4</div>

    <!-- Step 1: Club -->
    <div class="wizard-step" id="wzStep1">
      <label style="display:block;margin-bottom:6px;font-size:0.85rem">Which club are you from?</label>
      <select id="wzClub" style="width:100%">
        <option value="">— select your club —</option>
        ${clubOpts}
      </select>
      <p class="wizard-hint" style="margin-top:8px">
        <a href="#" id="wzImportLink" style="color:var(--muted,#888);font-size:0.8rem">Already have a file? Import instead ↑</a>
      </p>
    </div>

    <!-- Step 2: Grade -->
    <div class="wizard-step wizard-hidden" id="wzStep2">
      <label style="display:block;margin-bottom:6px;font-size:0.85rem">What grade do you play in?</label>
      <select id="wzGrade" style="width:100%">
        <option value="">— select your grade —</option>
        ${gradeOpts}
      </select>
      <p class="wizard-hint" id="wzDayHint" style="margin-top:4px"></p>
    </div>

    <!-- Step 3: Player count -->
    <div class="wizard-step wizard-hidden" id="wzStep3">
      <label style="display:block;margin-bottom:6px;font-size:0.85rem">How many players on your team?</label>
      <input id="wzPlayerCount" type="number" min="1" max="30" style="width:80px"
             value="${playerCount || ''}">
      <p class="wizard-hint" style="margin-top:4px">We'll pre-fill their names — you can edit them any time under DATA.</p>
      <div style="margin-top:12px">
        <button id="wzPlayerNext" class="btn btn-primary wizard-hidden" type="button" style="width:100%">Next →</button>
      </div>
    </div>

    <!-- Step 4: Team name -->
    <div class="wizard-step wizard-hidden" id="wzStep4">
      <label style="display:block;margin-bottom:6px;font-size:0.85rem">Team name</label>
      <input id="wzTeamName" type="text" style="width:100%" placeholder="e.g. Vermont U9 Purple"
             value="${escHtml(teamName)}">
      <p class="wizard-comms-hint" id="wzCommsHint"></p>
      <div style="margin-top:12px">
        <button id="wzConfirm" class="btn btn-primary wizard-hidden" type="button" style="width:100%">
          Confirm name →
        </button>
      </div>
    </div>
  `);

  // Helper: reveal a step (WIZ2-001: move focus to the new step's first control)
  function revealStep(id, counterText) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('wizard-hidden'); focusFirstInteractive(el); }
    const counter = document.getElementById('wzCounter');
    if (counter && counterText) counter.textContent = counterText;
  }

  function hideStepsFrom(fromId) {
    const ids = ['wzStep2', 'wzStep3', 'wzStep4'];
    const idx = ids.indexOf(fromId);
    if (idx >= 0) ids.slice(idx).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('wizard-hidden');
    });
    const confirm = document.getElementById('wzConfirm');
    if (confirm) confirm.classList.add('wizard-hidden');
    const playerNext = document.getElementById('wzPlayerNext');
    if (playerNext) playerNext.classList.add('wizard-hidden');
  }

  function updateCommsHint() {
    const hint = document.getElementById('wzCommsHint');
    if (!hint) return;
    const name = document.getElementById('wzTeamName')?.value?.trim() || '';
    const club = selectedClub?.name || '(Club)';
    const age  = selectedGrade?.age_group || '(Age)';
    hint.textContent = name
      ? `Your comms will say: "${club} ${age} ${name}"`
      : '';
  }

  // Restore state from draft
  if (selectedClub) {
    revealStep('wzStep2', '2 / 4');
    if (selectedGrade) {
      const hint = document.getElementById('wzDayHint');
      if (hint) hint.textContent = selectedGrade.day ? `${selectedGrade.day} games` : '';
      revealStep('wzStep3', '3 / 4');
      if (playerCount && roster) {
        revealStep('wzStep4', '4 / 4');
        updateCommsHint();
        if (teamName) {
          const confirm = document.getElementById('wzConfirm');
          if (confirm) confirm.classList.remove('wizard-hidden');
        }
      }
    }
  }

  // Wire chrome
  function backHandler() {
    if (document.getElementById('wzStep4') && !document.getElementById('wzStep4').classList.contains('wizard-hidden')) {
      hideStepsFrom('wzStep4');
      setWizardChrome({ showBack: true, onBack: backHandler });
      document.getElementById('wzCounter').textContent = '3 / 4';
    } else if (document.getElementById('wzStep3') && !document.getElementById('wzStep3').classList.contains('wizard-hidden')) {
      hideStepsFrom('wzStep3');
      setWizardChrome({ showBack: true, onBack: backHandler });
      document.getElementById('wzCounter').textContent = '2 / 4';
    } else if (document.getElementById('wzStep2') && !document.getElementById('wzStep2').classList.contains('wizard-hidden')) {
      hideStepsFrom('wzStep2');
      setWizardChrome({ showBack: false, onBack: null });
      document.getElementById('wzCounter').textContent = '1 / 4';
    }
  }
  setWizardChrome({ showBack: !!selectedClub, onBack: backHandler });

  // ── Step 1: Club selection
  document.getElementById('wzClub').addEventListener('change', (e) => {
    const clubId = e.target.value;
    selectedClub = clubs.find(c => String(c.club_id) === clubId) || null;
    selectedGrade = null; roster = null; playerCount = null; teamName = '';
    hideStepsFrom('wzStep2');
    if (selectedClub) {
      revealStep('wzStep2', '2 / 4');
      setWizardChrome({ showBack: true, onBack: backHandler });
      saveDraft({ selectedClub, selectedGrade, playerCount, roster, teamName });
    }
  });

  // ── Import link
  document.getElementById('wzImportLink').addEventListener('click', (e) => {
    e.preventDefault();
    showImport(onComplete);
    setWizardChrome({ showBack: true, onBack: () => showStartFresh(refData, loadDraft(), onComplete) });
  });

  // ── Step 2: Grade selection
  document.getElementById('wzGrade').addEventListener('change', (e) => {
    const gradeId = e.target.value;
    selectedGrade = grades.find(g => String(g.grade_id) === gradeId) || null;
    roster = null; playerCount = null; teamName = '';
    hideStepsFrom('wzStep3');
    const hint = document.getElementById('wzDayHint');
    if (hint) hint.textContent = selectedGrade?.day ? `${selectedGrade.day} games` : '';
    if (selectedGrade) {
      revealStep('wzStep3', '3 / 4');
      saveDraft({ selectedClub, selectedGrade, playerCount, roster, teamName });
    }
  });

  // ── Step 3: Player count
  function onPlayerCountInput() {
    const val = parseInt(document.getElementById('wzPlayerCount')?.value, 10);
    const btn = document.getElementById('wzPlayerNext');
    if (!val || val < 1 || val > 30) {
      if (btn) btn.classList.add('wizard-hidden');
      return;
    }
    if (btn) btn.classList.remove('wizard-hidden');
  }
  document.getElementById('wzPlayerCount').addEventListener('input',  onPlayerCountInput);
  document.getElementById('wzPlayerCount').addEventListener('change', onPlayerCountInput);
  document.getElementById('wzPlayerCount').addEventListener('blur',   onPlayerCountInput);
  document.getElementById('wzPlayerNext').addEventListener('click', () => {
    const val = parseInt(document.getElementById('wzPlayerCount')?.value, 10);
    if (!val || val < 1 || val > 30) return;
    playerCount = val;
    roster = buildRoster(randomNames, playerCount);
    teamName = '';
    const confirm = document.getElementById('wzConfirm');
    if (confirm) confirm.classList.add('wizard-hidden');
    revealStep('wzStep4', '4 / 4');
    updateCommsHint();
    saveDraft({ selectedClub, selectedGrade, playerCount, roster, teamName });
  });

  // ── Step 4: Team name
  document.getElementById('wzTeamName').addEventListener('input', () => {
    teamName = document.getElementById('wzTeamName')?.value?.trim() || '';
    updateCommsHint();
    const confirm = document.getElementById('wzConfirm');
    if (confirm) {
      if (teamName.length >= 1) confirm.classList.remove('wizard-hidden');
      else confirm.classList.add('wizard-hidden');
    }
    if (teamName) saveDraft({ selectedClub, selectedGrade, playerCount, roster, teamName });
  });

  // ── Confirm name → completion screen
  document.getElementById('wzConfirm').addEventListener('click', () => {
    teamName = document.getElementById('wzTeamName')?.value?.trim() || '';
    if (!teamName) return;

    const seededRounds = seedRoundsForGrade(roundsTemplate, selectedGrade?.grade_name, selectedClub?.name);

    const state = {
      user_team: {
        club_id:    selectedClub.club_id,
        club_name:  selectedClub.name,
        team_name:  teamName,
        age_group:  selectedGrade.age_group,
        gender:     selectedGrade.gender,
        grade_id:   selectedGrade.grade_id,
        grade_name: selectedGrade.grade_name,
        roster,
      },
      round_summary: { rounds: seededRounds },
      reference_data: {
        clubs,
        locations: locations || [],
        jobs: jobs || [],
        players: roster.map(r => ({ jumper: r.jumper, player_name: r.name })),
        volunteers: roster.map(r => ({
          jumper:        r.jumper,
          volunteer_name: r.name,
          preferred_job: '',
          avoid_jobs:    '',
        })),
        splits: [],
      },
    };

    saveDraft({ selectedClub, selectedGrade, playerCount, roster, teamName });
    setWizardChrome({ showBack: true, onBack: () => showStartFresh(refData, loadDraft(), onComplete) });
    // WIZ2-008: most grades have no fixture template — tell the customer rather
    // than dropping them into a silent empty season.
    showCompletionScreen(state, onComplete, { emptyRounds: seededRounds.length === 0, gradeName: selectedGrade.grade_name });
  });
}

// ── Resume / start-over landing ───────────────────────────────────────────

async function showResumeLanding(refData, draft, onComplete) {
  const club = draft.selectedClub?.name || '?';
  const grade = draft.selectedGrade?.grade_name || '';
  const teamName = draft.teamName || '';
  const summary = [club, grade, teamName].filter(Boolean).join(' · ');

  setWizardContent(`
    <h2 style="margin-bottom:0.75rem">Welcome back</h2>
    <p style="font-size:0.85rem;color:var(--muted,#888);margin-bottom:1.25rem">${escHtml(summary)}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button id="wzContinue" class="btn btn-primary" type="button" style="flex:1;min-width:140px">
        Continue →
      </button>
      <button id="wzNewSetup" class="btn" type="button" style="flex:1;min-width:140px">
        Start fresh
      </button>
    </div>
  `);
  removeWizardChrome();

  document.getElementById('wzContinue').addEventListener('click', () => {
    showStartFresh(refData, draft, onComplete);
  });
  document.getElementById('wzNewSetup').addEventListener('click', () => {
    showConfirmDestructive('Discard your saved setup and start fresh?', () => {
      clearDraft();
      showStartFresh(refData, null, onComplete);
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────

// WIZ2-010: keep Tab focus inside the wizard, and route Escape through the
// discard-confirm rather than letting it close the modal silently.
function wizardFocusTrap(e) {
  if (document.getElementById('wizardConfirm')) return; // the confirm owns focus
  const wiz = document.getElementById('wizard');
  if (!wiz || wiz.style.display === 'none') return;
  if (e.key === 'Escape') {
    e.preventDefault();
    showConfirmDestructive('Discard your setup progress and start over?', () => {
      clearDraft();
      document.dispatchEvent(new CustomEvent('wizard-restart'));
    });
    return;
  }
  if (e.key !== 'Tab') return;
  const list = Array.from(wiz.querySelectorAll('select, input, button, a[href], [tabindex]:not([tabindex="-1"])'))
    .filter(el => el.offsetParent !== null);
  if (list.length === 0) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export async function showWizard(onComplete) {
  showWizardEl();
  document.removeEventListener('keydown', wizardFocusTrap);
  document.addEventListener('keydown', wizardFocusTrap);

  // Load all reference data concurrently
  const [clubs, grades, randomNames, roundsTemplate, jobs, locations] = await Promise.all([
    fetchJson('./data/clubs.json'),
    fetchJson('./data/grades.json'),
    fetchJson('./data/random-names.json'),
    fetchJson('./data/rounds-template.json'),
    fetchJson('./data/jobs.json'),
    fetchJson('./data/locations.json'),
  ]);
  const refData = { clubs, grades, randomNames, roundsTemplate, jobs, locations };

  let restartListener = null;

  function start(draft) {
    if (restartListener) {
      document.removeEventListener('wizard-restart', restartListener);
    }
    restartListener = () => {
      clearDraft();
      showStartFresh(refData, null, onComplete);
    };
    document.addEventListener('wizard-restart', restartListener, { once: true });

    const existingDraft = loadDraft();
    if (existingDraft && existingDraft.selectedClub) {
      showResumeLanding(refData, existingDraft, onComplete);
    } else {
      showStartFresh(refData, null, onComplete);
    }
  }

  start(loadDraft());
}
