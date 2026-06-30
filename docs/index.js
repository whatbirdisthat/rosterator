window.__APP_VERSION = "0.31.62";
'use strict';

// ── Module imports (CLM-004/005/006: single source of truth) ──────────────
// index.js is loaded as an ES module (<script type="module"> in index.html).
// The pure state logic lives in store-reducer.mjs; the view-model derivation in
// store-selectors.mjs; the HTML-escape utility in utils.mjs. The wrappers below
// inject getState() so this file's call sites stay unchanged.
import { escHtml, copyToastMessage, pluralizeJob } from './utils.mjs';
import { reduceState, initialUiState, buildStoreState, deepClone, deepFreeze } from './store-reducer.mjs';
import * as Sel from './store-selectors.mjs';
import { isRoundLocked, nextLockStatus, roundStatusPill } from './round-status.mjs';
import {
  homeGroundsForClub, firstHomeGroundName,
  encodeRowRef, resolveRecordForEdit,
  normalizeJobNames, serializeJobNames,
} from './data-records.mjs';
import { createPersistenceCoordinator } from './persistence-coordinator.mjs';

// ── Allocator global (loaded in index.html as ES module) ──────────────────
// Read lazily at call time — the ES module may not have executed yet at load.
function _getAllocator() { return window.__allocator; }

// ── Module-level UI state (not in store — render-cycle local) ─────────────
// NOTE (CLM-006): _balanceSort and _expandedVols now live in SPA_STORE.ui
// (ui.balanceSortKey, ui.expandedVolJumpers) so they survive an IDB reload.
let _renderingSettings = false;            // Guard: prevents saveUserTeam() during DOM rebuild
let _mobileNavOpen = false;                // iPhone drawer state
let _mobileNavHintSeen = false;            // One-time affordance state

const MOBILE_NAV_HINT_KEY = 'roster-mobile-nav-hint-seen';

// ── Offline mode state ─────────────────────────────────────────────────────
let _unsyncedWriteCount = 0;               // Counter for unsynced PUT failures
let _idb = null;                           // Reference to idb module when available
let _idbAvailable = false;                 // Whether IndexedDB is available

// ── Store foundation ──────────────────────────────────────────────────────
// The pure reducer and immutability helpers live in store-reducer.mjs.
// createStore holds the single mutable `state` reference and persistence is
// wired in the module-level dispatch() below.
function createStore() {
  let state = buildStoreState(null, {}, initialUiState());
  function getState() { return state; }
  function getData() { return state.data; }
  function dispatch(action) { state = reduceState(state, action); return state; }
  return { getState, getData, dispatch };
}

const SPA_STORE = createStore();

function getState() {
  return SPA_STORE.getState();
}

function getData() {
  return SPA_STORE.getData();
}

// ── Persistence coordinator (OFF-005a/c/d/e/f) ─────────────────────────────
// Serializes + coalesces snapshot writes (latest wins, never interleaved),
// exposes a settle signal, and surfaces persistent failures — replacing the old
// fire-and-forget save that lost the last write on an immediate reload. Lazily
// bound to the active persistence impl (set on window.__dataLayer before this
// module runs).
let _persistCoordinator = null;
function _getPersistCoordinator() {
  if (_persistCoordinator) return _persistCoordinator;
  const _persist = window.__dataLayer?.persistence;
  if (!_persist) return null;
  _persistCoordinator = createPersistenceCoordinator(
    (data) => _persist.save(data),
    { onError: onPersistFailure },
  );
  return _persistCoordinator;
}

// OFF-005a/c: queue the latest snapshot for a durable write (non-blocking).
function persist(data) {
  const co = _getPersistCoordinator();
  if (co && data) co.enqueue(data);
}

// OFF-005d: resolves once the latest mutation is durably persisted (or given up).
function whenPersisted() {
  return _persistCoordinator ? _persistCoordinator.whenSettled() : Promise.resolve();
}

// OFF-005e: force-drain pending writes (used on tab hide / close).
function flushPersistence() {
  return _persistCoordinator ? _persistCoordinator.flush() : Promise.resolve();
}

// OFF-005f: surface a persistent save failure to the user (don't swallow it).
let _lastPersistErrorAt = 0;
function onPersistFailure(err, failures) {
  console.warn('[offline] IDB save failed after dispatch', err, `(failure #${failures})`);
  // Throttle so a burst of failures shows at most one toast per 4s.
  const now = Date.now();
  if (now - _lastPersistErrorAt > 4000) {
    _lastPersistErrorAt = now;
    try { showToast("Couldn't save your latest change — it may be lost if you reload", 'error'); } catch (_) {}
  }
}

function dispatch(action) {
  const result = SPA_STORE.dispatch(action);
  // OFF-005a/c: persist the new snapshot via the coordinator (serialized + coalesced).
  persist(getData());
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
  const _prefChecks = [
    ['print_footer', 'printFooterInput'],
    ['email_prefix', 'emailPrefixInput'],
    ['email_suffix', 'emailSuffixInput'],
  ];
  for (const [key, inputId] of _prefChecks) {
    const stored = data.ui_preferences?.[key] ?? '';
    const el = document.getElementById(inputId);
    if (el && el.value !== stored) {
      mismatches.push({ field: `ui_preferences.${key}`, displayed: el.value, stored });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

window.__rosterSpa = { getState, getData, dispatch, assertConsistency, whenPersisted, flushPersistence };

// ── Global surface (CLM-008) ───────────────────────────────────────────────
// index.js is an ES module, so its top-level functions are module-scoped rather
// than implicit globals. The Playwright suite drives the app through these
// functions via page.evaluate(), and a few are reachable from markup, so we
// republish the app's public surface onto window explicitly. (Function
// declarations are hoisted, so names defined later in the file resolve here.)
Object.assign(window, {
  getState, getData, dispatch, assertConsistency,
  render, switchPanel, restoreSkin,
  loadFile, showPicker, saveSnapshot, reallocate,
  openRoundDetail, closeRoundDetail, openEditMode, saveRoundEdit, updateEditLocation,
  toggleConfirmRound, getRoundByNum,
  openVolSwap, showVolPopup, saveUserTeam,
  renderAlerts, renderConstraints, renderFairness, renderVolunteers,
  buildEmailText, copyToClipboard, fmtDate, showSnapshotToast,
  selectStoreData, selectRoundByNum, serializeSnapshotModel,
  selectDashboardViewModel, selectRoundsViewModel, selectRoundDetailViewModel,
  selectSettingsViewModel,
});

// ── Selector wrappers (CLM-005) ───────────────────────────────────────────
// The view-model logic lives in store-selectors.mjs. These wrappers inject
// getState() so existing call sites in this file remain unchanged. The module
// is the single, unit-tested source of truth.
function selectUiState(state = getState()) { return Sel.selectUiState(state); }
function selectStoreData(state = getState()) { return Sel.selectStoreData(state); }
function selectRounds(state = getState()) { return Sel.selectRounds(state); }
function selectRoundByNum(roundNum, state = getState()) { return Sel.selectRoundByNum(roundNum, state); }
function selectSelectedRound(state = getState()) { return Sel.selectSelectedRound(state); }
function selectDashboardViewModel(state = getState()) { return Sel.selectDashboardViewModel(state); }
function selectMatrixViewModel(state = getState()) { return Sel.selectMatrixViewModel(state); }
function selectRoundsViewModel(state = getState()) { return Sel.selectRoundsViewModel(state); }
function selectRoundDetailViewModel(state = getState()) { return Sel.selectRoundDetailViewModel(state); }
function selectSettingsViewModel(state = getState()) { return Sel.selectSettingsViewModel(state); }
function selectSidebarViewModel(state = getState()) { return Sel.selectSidebarViewModel(state); }
function selectFairnessViewModel(state = getState()) { return Sel.selectFairnessViewModel(state); }
function selectAlertsViewModel(state = getState()) { return Sel.selectAlertsViewModel(state); }
function selectVolunteersViewModel(filter = '', state = getState()) { return Sel.selectVolunteersViewModel(filter, state); }
function selectBalanceViewModel(state = getState()) { return Sel.selectBalanceViewModel(state); }
function selectConstraintsViewModel(state = getState()) { return Sel.selectConstraintsViewModel(state); }
function selectNavigationViewModel(state = getState()) { return Sel.selectNavigationViewModel(state); }
function serializeSnapshotModel(state = getState()) { return Sel.serializeSnapshotModel(state); }

// Shared pure helpers consumed by render code (logic in store-selectors.mjs).
const { colKey, buildEntriesMap, getInitials, buildSeasonLabel, computeClientBalance } = Sel;

function normalizeRoundRef(roundOrNum) {
  return roundOrNum && typeof roundOrNum === 'object' ? roundOrNum.round : roundOrNum;
}

function isIphoneNavViewport() {
  return document.body?.dataset?.deviceTarget === 'iphone'
    || window.matchMedia('(max-width: 430px)').matches;
}

// CSS-006: the mobile layout lives entirely in the .mobile-layout / .mobile-mini
// classes (iphone.css). Apply them from BOTH triggers — the max-width media
// query and the data-device-target attribute — so the rules never drift.
function syncMobileLayoutClass() {
  const t = document.body?.dataset?.deviceTarget;
  const mobile = t === 'iphone' || t === 'iphone-mini'
    || window.matchMedia('(max-width: 430px)').matches;
  const mini = t === 'iphone-mini'
    || window.matchMedia('(max-width: 375px)').matches;
  document.body.classList.toggle('mobile-layout', mobile);
  document.body.classList.toggle('mobile-mini', mini);
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
  window.scrollTo(0, 0);
}

async function initOfflineMode() {
  // OFF-008: Check if IndexedDB is available via the data layer persistence impl.
  _idbAvailable = window.__dataLayer?.persistence?.isAvailable?.() ?? false;
  _idb = window.__idb; // kept for external compatibility only

  if (!_idbAvailable) {
    console.warn('[offline] IndexedDB unavailable (private browsing or blocked)');
    // USP-054: SPA requires IDB — show blocking error, do not proceed
    showIdbUnavailableError();
    return;
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

  const _dl = window.__dataLayer;
  const _persist = _dl?.persistence;
  const _net = _dl?.network;


  // OFF-003: Try IndexedDB first (if available)
  if (_idbAvailable && _persist) {
    try {
      const snapshot = await _persist.load();
      if (snapshot) {
        // OFF-003: Hydrate from IDB
        dispatch({ type: 'load-report', payload: { filename: 'from-idb', report: snapshot } });
        migrateLegacyPrintFooter();
        render();
        document.getElementById('app').classList.add('show');
        hideLoading();

        return;
      }
    } catch (err) {
      console.warn('[offline] IDB load failed', err);
    }
  }

  // Cold start with empty IDB — try server if network is available (dev/test),
  // then fall through to onboarding wizard. In production there is no server
  // so the fetch fails quickly and the wizard shows.
  if (_net) {
    try {
      const data = await _net.get('/api/roster-data');
      if (data && data.round_summary) {
        dispatch({ type: 'load-report', payload: { filename: 'from-server', report: data } });
        migrateLegacyPrintFooter();
        render();
        document.getElementById('app').classList.add('show');
        hideLoading();
        persist(data);   // route through the coordinator (OFF-005c)
        return;
      }
    } catch (_) { /* no server — fall through to wizard */ }
  }

  // USP-020: No IDB state and no server data — show onboarding wizard
  if (!_idbAvailable) return;
  hideLoading();
  window.__showWizard(async (state) => {
    persist(state); await whenPersisted();   // durable before continuing (OFF-005a/d)
    dispatch({ type: 'load-report', payload: { filename: 'from-wizard', report: state } });
    render();
    document.getElementById('app').classList.add('show');
    window.scrollTo(0, 0);
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  setupGlobalDelegation();
  syncMobileLayoutClass();
  window.addEventListener('resize', syncMobileLayoutClass);
  // OFF-005e: best-effort flush of pending IDB writes when the tab is hidden or
  // closed, so the last change isn't lost if the user navigates away immediately.
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersistence();
  });
  window.addEventListener('pagehide', () => { flushPersistence(); });
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
  const net = window.__dataLayer?.network;
  if (!net) { showPicker([]); return; }
  net.get('/api/roster-files')
    .then(files => showPicker(files || []))
    .catch(() => showPicker([]));
}

// ── Save snapshot ────────────────────────────────────────────────────────
async function saveSnapshot() {
  const data = serializeSnapshotModel();
  if (!data) return;
  const btn = document.getElementById('btnSaveSnapshot');
  if (btn) btn.disabled = true;
  try {
    const net = window.__dataLayer?.network;
    if (!net) { showSnapshotToast('Save failed: no network layer', 'err'); return; }
    const res = await net.rawFetch('/api/roster-files', {
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
  // Update only the label span so a leading SVG icon is preserved (falls back to
  // textContent for buttons without a .btn-label span, e.g. the lineup button).
  const _setBtnLabel = (b, text) => { const l = b && b.querySelector('.btn-label'); if (l) l.textContent = text; else if (b) b.textContent = text; };
  if (btn) { btn.disabled = true; _setBtnLabel(btn, '⟳ Working…'); }

  try {
    // Check allocator mode from localStorage (default: 'spa')
    const mode = localStorage.getItem('allocator-mode') ?? 'spa';

    if (mode === 'spa') {
      // ALC-004: Invoke JS allocator via data layer
      try {
        const _allocLayer = window.__dataLayer?.allocator;
        if (!_allocLayer) throw new Error('Allocator not available');

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

        const result = await _allocLayer.allocate(data);

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
        showSnapshotToast('Re-allocated successfully', 'ok');
      } catch (err) {
        // ALC-024: Show error toast, do not update state
        showSnapshotToast(`Allocation failed: ${err.message}`, 'err');
      }
    }
  } catch (err) {
    showSnapshotToast('Re-allocate failed: network error', 'err');
  } finally {
    if (btn) { btn.disabled = false; _setBtnLabel(btn, 'Re-allocate'); }
  }
}


// ── Round edit mode ───────────────────────────────────────────────────────
function _editOppositions() {
  const data = getData();
  return (data?.reference_data?.clubs || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

function _editLocationsForClub(clubId) {
  // RLOC: delegate to the pure, string-safe home-grounds selector.
  return homeGroundsForClub(getData()?.reference_data?.locations, clubId);
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
        <select id="editOpposition" data-action="update-edit-location">
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
      ${round.home_away === 'B' ? '' : `<div id="editTypeRow" class="edit-form-row">
        <span class="edit-form-label">Round type</span>
        ${roundTypePill(round)}
      </div>`}
      <div class="edit-form-row">
        <span class="edit-form-label">Time</span>
        <input type="time" id="editTime" value="${timeVal}">
      </div>
      <div class="edit-form-row">
        <span class="edit-form-label">Date</span>
        <input type="date" id="editDate" value="${escHtml(round.date || '')}">
      </div>
      <div class="edit-form-actions">
        <button class="btn" data-action="close-edit">Cancel</button>
        <button class="btn btn-primary" data-action="save-round-edit" data-round="${escHtml(String(round.round))}">Save</button>
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
  // RLOC-001/002: when the club changes, pre-select that club's FIRST home ground
  // (and, when there are several, list them all with the first selected).
  const locs = _editLocationsForClub(clubId);
  const firstName = firstHomeGroundName(getData()?.reference_data?.locations, clubId);
  const row  = document.getElementById('editLocationRow');
  if (!row) return;
  row.innerHTML = `<span class="edit-form-label">Location</span>${_locationField(locs, firstName)}`;
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
}

// ── Load & render ────────────────────────────────────────────────────────
async function loadFile(filename) {
  const net = window.__dataLayer?.network;
  if (!net) throw new Error('No network layer');
  const report = await net.get(`/roster-data/${filename}`);
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

// ERG-003: apply the persisted density preference to the body. Density lives in
// ui_preferences (part of the report) so it survives an IDB reload.
function applyDensity() {
  const density = getData()?.ui_preferences?.density || 'moderate';
  document.body.dataset.density = density;
  document.querySelectorAll('[data-action="set-density"]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.density === density));
}

function render() {
  try { renderLineup();       } catch(e) { console.error('[spa] renderLineup:', e); }
  if (!getData()) return;
  try { applyDensity();       } catch(e) { console.error('[spa] applyDensity:', e); }
  try { renderNavigation();   } catch(e) { console.error('[spa] renderNavigation:', e); }
  try { renderSidebar();      } catch(e) { console.error('[spa] renderSidebar:', e); }
  try { renderDashboard();    } catch(e) { console.error('[spa] renderDashboard:', e); }
  try { renderRoster();       } catch(e) { console.error('[spa] renderRoster:', e); }
  try { renderRoundsList();   } catch(e) { console.error('[spa] renderRoundsList:', e); }
  try { renderRoundDetail();  } catch(e) { console.error('[spa] renderRoundDetail:', e); }
  try { renderVolunteers();   } catch(e) { console.error('[spa] renderVolunteers:', e); }
  try { renderBalance();      } catch(e) { console.error('[spa] renderBalance:', e); }
  try { renderConstraints();  } catch(e) { console.error('[spa] renderConstraints:', e); }
  try { renderSettings();     } catch(e) { console.error('[spa] renderSettings:', e); }
  try { renderTeamSplits();   } catch(e) { console.error('[spa] renderTeamSplits:', e); }
  try { renderDataCounts();   } catch(e) { console.error('[spa] renderDataCounts:', e); }
}

// @front-end { element: navigation-panel, intent: "drive panel switching and reflect the active panel + round-detail state", customer: developer, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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
// @front-end { element: sidebar-panel, intent: "show team identity, season label, and volunteer counts at a glance", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
function renderSidebar() {
  const viewModel = selectSidebarViewModel();
  if (!viewModel) return;

  document.getElementById('sbClubName').textContent = viewModel.teamName;
  document.getElementById('sbInitials').textContent = viewModel.initials;
  document.getElementById('sbSeason').textContent = viewModel.seasonYear || '—';
  document.getElementById('sbModeIcon').textContent = viewModel.modeIcon;
  document.getElementById('sbModeLabel').textContent = viewModel.modeLabel;
  const _statsEl = document.getElementById('sbModeStats');
  if (_statsEl) _statsEl.textContent = viewModel.modeStats;
  document.getElementById('sbUserAv').textContent = viewModel.userAv;
  document.getElementById('sbUserName').textContent = viewModel.userName;
  document.getElementById('sbUserRole').textContent = viewModel.userRole;
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.dataset.mode = 'user';
}

// ── Dashboard ────────────────────────────────────────────────────────────
// @front-end { element: dashboard-panel, intent: "surface the next actionable round and season totals on landing", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
// RT-007: collapse SPLIT-shaped matrix columns (A/B) into one `shared` column per
// job — used so the dashboard renders a FULL_TEAM round as per FULL_TEAM. Mirrors
// collapseSplitJobs (allocator.js).
function collapseColumnsForFullTeam(cols) {
  const out = [];
  const seen = new Set();
  for (const col of (cols || [])) {
    const st = String(col.subteam || '').toLowerCase();
    if (st === 'a' || st === 'b') {
      if (seen.has(col.job)) continue;
      seen.add(col.job);
      out.push({ ...col, subteam: 'shared', label: col.job });
    } else {
      out.push(col);
    }
  }
  return out;
}

function renderDashboard() {
  const viewModel = selectDashboardViewModel();
  if (!viewModel) return;
  const { rounds, featureRound: featRound, totalRounds, confirmedRounds, scheduledRounds, columns: rawCols } = viewModel;
  if (!featRound) return;

  // RT-007: the season-wide matrix columns are SPLIT-shaped (separate A/B columns).
  // For a FULL_TEAM feature round, collapse them to one shared column per job so the
  // grid matches that round's collapsed `shared` entries (otherwise A/B tiles show
  // as "⚠ unfilled" and the real allocation is dropped).
  const cols = String(featRound.round_type || '').toUpperCase() === 'FULL_TEAM'
    ? collapseColumnsForFullTeam(rawCols)
    : rawCols;

  // Headline
  const dateObj = featRound.date ? new Date(featRound.date + 'T00:00:00') : null;
  const dayName = dateObj ? dateObj.toLocaleDateString('en-AU', { weekday: 'long' }) : '';
  document.getElementById('dashHeadline').textContent =
    `${dayName} looks ${ featRound.status === 'confirmed' ? 'handled.' : 'scheduled.' }`;
  document.getElementById('dashMeta').textContent =
    `Round ${featRound.round} of ${totalRounds} · vs. ${resolveOpposition(featRound)} · ${resolveLocation(featRound)} · ${fmtArrival(featRound.time)}`;

  // Hero
  const thisLabel = dateObj ? dateObj.toLocaleDateString('en-AU', { weekday: 'long' }).toUpperCase() : 'THIS ROUND';
  document.getElementById('dashThisLabel').textContent = thisLabel;
  document.getElementById('dashRoundChip').textContent = `Round ${featRound.round}`;
  document.getElementById('dashHeroTitle').textContent = fmtDate(featRound.date);
  document.getElementById('dashHeroMeta').textContent =
    `vs. ${resolveOpposition(featRound)} · ${resolveLocation(featRound)} · ${fmtArrival(featRound.time)}`;
  document.getElementById('dashHeroPill').innerHTML =
    `<span class="status-pill ${featRound.status === 'confirmed' ? 'ok' : 'warn'}">${featRound.status === 'confirmed' ? 'Confirmed' : 'Scheduled'}</span>` +
    (homeAwayLabel(featRound) ? ` ${haTogglePill(featRound)}` : '');

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
    return `<span class="round-pill ${cls}" role="button" tabindex="0" data-action="open-round" data-round="${escHtml(String(r.round))}" title="Round ${r.round} · ${r.date}${_pillHaSuffix}" aria-label="Open round ${escHtml(String(r.round))} detail">${pillLabel}</span>`;
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

// @front-end { element: fairness-panel, intent: "show workload-spread health as one glanceable score plus per-volunteer squares", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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

// @front-end { element: alerts-panel, intent: "summarise data issues (errors/warnings) behind a single status pill", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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
// @front-end { element: roster-panel, intent: "present the season matrix of rounds x jobs for scanning coverage", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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
// @front-end { element: roundslist-panel, intent: "offer a browseable list of rounds as the entry point to round detail", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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
    // The card holds focusable controls (confirm + home/away pills), so the card
    // itself must NOT be a button — nested interactive elements are invalid ARIA.
    // The round-number span is the keyboard-focusable "open round" affordance
    // (a leaf, sibling to the pills); the card keeps data-action only so a mouse
    // click anywhere on it still opens the round via the delegated handler.
    // Both regular and BYE rounds are openable (BYE detail shows the bye info).
    const openLabel = isBye ? `Open bye round ${escHtml(String(r.round))} detail` : `Open round ${escHtml(String(r.round))} detail`;
    const roundNumSpan = isBye
      ? `<span class="round-card-num bye-label" role="button" tabindex="0" data-action="open-round" data-round="${escHtml(String(r.round))}" aria-label="${openLabel}">BYE</span>`
      : `<span class="round-card-num" role="button" tabindex="0" data-action="open-round" data-round="${escHtml(String(r.round))}" aria-label="${openLabel}">Round ${escHtml(String(r.round))}</span>`;
    const haWrap = isBye
      ? `<span class="ha-pill bye">BYE</span>`
      : haTogglePill(r);
    const oppHtml = isBye ? '' : `<div class="round-card-opp">vs. ${escHtml(resolveOpposition(r))}</div>`;
    return `<div class="round-card" data-action="open-round" data-round="${escHtml(String(r.round))}">
      <div class="round-card-head">
        ${roundNumSpan}
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
          <span class="status-pill ${isConfirmed ? 'ok' : 'warn'}" role="button" tabindex="0" style="cursor:pointer;user-select:none" title="Click to ${isConfirmed ? 'unconfirm' : 'confirm'} this round" aria-label="${isConfirmed ? 'Unconfirm' : 'Confirm'} round ${escHtml(String(r.round))}" data-action="confirm-round" data-round="${escHtml(String(r.round))}">${isConfirmed ? '&#x2713; Confirmed' : '&#x7E; Scheduled'}</span>
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

// @front-end { element: rounddetail-panel, intent: "show everything about one round: assignments, print preview, email text", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
function renderRoundDetail() {
  const viewModel = selectRoundDetailViewModel();
  if (!viewModel) return;
  const { round: r, totalRounds, locked } = viewModel;

  document.getElementById('roundsListView').classList.add('hidden');
  document.getElementById('roundDetail').classList.add('active');

  document.getElementById('detailBreadcrumb').textContent =
    `Round ${r.round} of ${totalRounds}`;

  const dateStr = fmtDate(r.date);
  const dayStr  = r.date ? new Date(r.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short' }) : '';
  document.getElementById('detailTitle').textContent = `${dayStr} ${dateStr} · vs. ${resolveOpposition(r)}`;
  document.getElementById('detailSub').textContent =
    `${resolveLocation(r)} · ${fmtArrival(r.time)}`;
  // The round note is shown only inside the A4 print preview (.pp-notes); the former
  // inline #detailNotes element (between date/time and the buttons) was a duplicate.
  // RLK-006: status pill (Completed / Confirmed / Scheduled) via the pure helper.
  const pill = roundStatusPill(r.status);
  document.getElementById('detailPill').innerHTML =
    `<span class="status-pill ${pill.cls}">${pill.label}</span>` +
    (homeAwayLabel(r) ? ` ${haTogglePill(r)}` : '');

  // Build print preview
  buildPrintPreview(r);

  // Build the mobile/narrow manual-allocation panel (mirrors the preview's swaps)
  buildManualAllocPanel(r);

  // Build email text
  const plainText = buildEmailText(r);
  const cb = document.getElementById('detailCopyblock');
  cb.textContent = plainText;

  // CPT-001: copy + success toast.
  document.getElementById('btnCopyDetail').onclick = async () => {
    if (await copyToClipboard(plainText)) showSnapshotToast(copyToastMessage(), 'ok');
    cb.classList.add('flash');
    setTimeout(() => cb.classList.remove('flash'), 600);
  };

  // RLK-003: a completed (locked) round is read-only — edit/confirm/reallocate disabled.
  const editBtn = document.getElementById('btnEditRound');
  editBtn.onclick = () => openEditMode(r.round);
  editBtn.disabled = locked;

  const isConfirmed = r.status === 'confirmed';
  const confirmBtn = document.getElementById('btnConfirmRound');
  confirmBtn.textContent = isConfirmed ? 'Unconfirm Round' : 'Confirm Round';
  confirmBtn.className = isConfirmed ? 'btn' : 'btn btn-primary';
  confirmBtn.onclick = () => toggleConfirmRound(r.round);
  confirmBtn.disabled = locked;

  const reallocBtn = document.getElementById('btnReallocate');
  reallocBtn.onclick = () => reallocate();
  reallocBtn.disabled = locked;

  // RLK-001/002: the lock control toggles completed↔confirmed.
  const lockBtn = document.getElementById('btnLockRound');
  if (lockBtn) {
    lockBtn.textContent = locked ? '🔓 Unlock round' : '🔒 Lock (match done)';
    lockBtn.onclick = () => {
      dispatch({ type: 'toggle-round-locked', payload: { roundNum: r.round } });
      dispatch({ type: 'set-round-detail', payload: { roundNum: r.round, open: true } });
      render();
    };
  }
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
      // Delegated swap trigger: data-action + the four slot-identifying attributes.
      const swapAttrs = `data-action="open-vol-swap" data-round="${roundEsc}" data-job="${jobEsc}" data-subteam="${subteamEsc}" data-slot="${slotIdx}"`;
      if (e.slot_status === 'unfilled' || !e.jumper) {
        return { volHtml: '', swapHtml: `<button class="vol-swap-btn unfilled" ${swapAttrs} title="Click to assign">⚠ unfilled</button>` };
      }
      const manualBadge = e.slot_status === 'manual' ? '<span class="manual-badge">M</span>' : '';
      return {
        volHtml: `<span style="display:inline-block;margin:0 6px 0 0;cursor:pointer" data-action="show-vol-popup" data-jumper="${escHtml(String(e.jumper))}">
          <span class="pp-jumper-big">#${escHtml(e.jumper)}</span>
          <span class="pp-vol-name">${escHtml(resolveVolunteerName(e))}${manualBadge}</span>
        </span>`,
        swapHtml: `<button class="vol-swap-btn vol-swap-btn-small" ${swapAttrs} title="Swap volunteer">&#8644;</button>`,
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
      <span>Generated ${today} · spa</span>
      <span>${escHtml(_printFooter)}</span>
    </div>`;
}

// P3: manual-allocation panel — one row per slot with a swap control, reusing the
// same `open-vol-swap` flow as the A4 preview. Gives a way to change allocations on
// mobile/narrow screens where the print-preview panel is hidden.
function buildManualAllocPanel(r) {
  const el = document.getElementById('manualAllocPanel');
  if (!el) return;
  const entries = (r && r.home_away !== 'B' && r.entries) ? r.entries : [];
  if (entries.length === 0) { el.innerHTML = ''; return; }
  const locked = isRoundLocked(r);
  const rows = entries.map(e => {
    const roundEsc   = escHtml(String(r.round));
    const jobEsc     = escHtml(e.job || '');
    const subteamEsc = escHtml(e.subteam || 'shared');
    const slotIdx    = e.slot_index ?? 0;
    const labelExtra = (e.subteam && e.subteam !== 'shared') ? ` (${escHtml(e.subteam)})` : '';
    const filled = e.slot_status !== 'unfilled' && e.jumper;
    const who = filled
      ? `<span class="ma-jumper">#${escHtml(String(e.jumper))}</span> <span class="ma-vol">${escHtml(resolveVolunteerName(e))}</span>`
      : '<span class="ma-unfilled">⚠ unfilled</span>';
    const swapAttrs = `data-action="open-vol-swap" data-round="${roundEsc}" data-job="${jobEsc}" data-subteam="${subteamEsc}" data-slot="${slotIdx}"`;
    const swapBtn = locked
      ? ''
      : `<button class="vol-swap-btn ma-swap${filled ? '' : ' unfilled'}" ${swapAttrs} title="Change volunteer">${filled ? '&#8644; swap' : 'assign'}</button>`;
    return `<div class="ma-row">
      <div class="ma-job">${escHtml(e.job)}${labelExtra}</div>
      <div class="ma-who">${who}</div>
      ${swapBtn}
    </div>`;
  }).join('');
  el.innerHTML = `<div class="detail-panel-label">Manual allocation</div>
    <div class="ma-list">${rows}</div>`;
}

function buildEmailText(r) {
  // User-configurable prefix/suffix wrap every email (Settings → email prefix/suffix).
  const _prefs = getData()?.ui_preferences || {};
  const _prefix = (_prefs.email_prefix || '').trim() ? [_prefs.email_prefix, ''] : [];
  const _suffix = (_prefs.email_suffix || '').trim() ? ['', _prefs.email_suffix] : [];

  if (r.home_away === 'B') {
    return [
      ..._prefix,
      `Round ${r.round} · ${fmtDate(r.date)} · BYE`,
      '',
      'No game this round. No volunteers required.',
      ..._suffix,
    ].join('\n');
  }

  // Group by base job name so SPLIT umpire A+B (and BBQ's two slots) collapse into
  // one header; the header is then pluralised to match the slot count (RT/plurality).
  const entries = r.entries || [];
  const jobMap = new Map();
  entries.forEach(e => {
    const key = e.job || e.job_label || '(unknown job)';
    if (!jobMap.has(key)) jobMap.set(key, []);
    jobMap.get(key).push(e);
  });

  const dateStr = fmtDate(r.date);
  const _haText = r.home_away === 'h' ? 'HOME' : r.home_away === 'a' ? 'AWAY' : '';
  const header  = `R${r.round} · vs ${resolveOpposition(r)}${_haText ? ' · ' + _haText : ''} · (${(r.status || '').toLowerCase()})`;
  const dateLine = `${dateStr}${r.time ? ' ' + fmtArrival(r.time) : ''}`;
  const locLine  = resolveLocation(r) || null;

  const lines = [];
  jobMap.forEach((slots, jobName) => {
    lines.push(pluralizeJob(jobName, slots.length) + ':');
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
    ..._prefix,
    header,
    dateLine,
    ...(locLine  ? [locLine]  : []),
    '',
    ...(r.extra_notes ? [r.extra_notes, ''] : []),
  ];
  return [...preamble, ...lines, ..._suffix].join('\n');
}

async function copyRoundText(r) {
  // CPT-001/002: success toast (ok style, emoji label) only after the write resolves.
  if (await copyToClipboard(buildEmailText(r))) {
    showSnapshotToast(copyToastMessage(), 'ok');
  }
}

// ── Volunteers ────────────────────────────────────────────────────────────
// @front-end { element: volunteers-panel, intent: "list volunteers with live assignment counts and an expandable timeline", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
function renderVolunteers(filter = document.getElementById('volSearch')?.value || '') {
  const viewModel = selectVolunteersViewModel(filter);
  if (!viewModel) return;

  document.getElementById('volSubtitle').textContent =
    `${viewModel.eligibleCount} active · names live in your browser only`;

  // CLM-006: expanded-rows state lives in the store (survives IDB reload).
  const expandedSet = new Set((getState().ui.expandedVolJumpers || []).map(String));
  const tbody = document.getElementById('volTableBody');
  tbody.innerHTML = viewModel.filtered.map(v => {
    const certs  = (v.certifications || []).map(c => `<span class="cert-chip">${escHtml(c)}</span>`).join('');
    const prefs  = (v.preferred_jobs || []).map(j => `<span class="vtag vtag-pref">★ ${escHtml(j)}</span>`).join('');
    const avoids = (v.avoid_jobs     || []).map(j => `<span class="vtag vtag-avoid">✕ ${escHtml(j)}</span>`).join('');
    const isExpanded = expandedSet.has(String(v.jumper));
    const expandIcon = isExpanded ? '&#9650;' : '&#9660;';

    const mainRow = `<tr>
      <td><span class="jumper-chip">#${escHtml(v.jumper)}</span></td>
      <td>
        <div class="vol-name-main vol-expandable" role="button" tabindex="0" aria-expanded="${isExpanded ? 'true' : 'false'}" data-action="toggle-vol-expand" data-jumper="${escHtml(String(v.jumper))}" aria-label="Toggle assignment timeline for ${escHtml(v.volunteer)}">
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
// @front-end { element: balance-panel, intent: "show sortable workload bars measured against the ideal allocation", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
function renderBalance() {
  const viewModel = selectBalanceViewModel();
  if (!viewModel) return;
  document.getElementById('idealCount').textContent = viewModel.ideal;

  // CLM-006: balance sort key lives in the store (survives IDB reload).
  const balanceSort = getState().ui.balanceSortKey || 'most-loaded';
  const sortedRows = viewModel.rows.slice().sort((a, b) => {
    if (balanceSort === 'name')        return (a.volunteer || '').localeCompare(b.volunteer || '');
    if (balanceSort === 'least-loaded') return a.delta - b.delta;
    return b.delta - a.delta; // 'most-loaded' default
  });

  const sortHtml = `<div class="balance-sort">
    <button data-action="set-balance-sort" data-sort="name" class="${balanceSort === 'name' ? 'active' : ''}">Name A–Z</button>
    <button data-action="set-balance-sort" data-sort="most-loaded" class="${balanceSort === 'most-loaded' ? 'active' : ''}">Most loaded</button>
    <button data-action="set-balance-sort" data-sort="least-loaded" class="${balanceSort === 'least-loaded' ? 'active' : ''}">Least loaded</button>
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
// @front-end { element: constraints-panel, intent: "list avoid-job rules per volunteer so conflicts are visible", customer: reader, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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
// @front-end { element: settings-panel, intent: "gather team identity, theme, print footer, and data tools in one panel", customer: writer, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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

  const _epInput = document.getElementById('emailPrefixInput');
  if (_epInput && _epInput.value !== viewModel.emailPrefix) _epInput.value = viewModel.emailPrefix;
  const _esInput = document.getElementById('emailSuffixInput');
  if (_esInput && _esInput.value !== viewModel.emailSuffix) _esInput.value = viewModel.emailSuffix;

  const _sdEl = document.getElementById('screenDims');
  if (_sdEl) _sdEl.textContent = `${window.innerWidth} × ${window.innerHeight}px`;

  const vEl = document.getElementById('appVersionLabel');
  if (vEl) {
    const ver = window.__APP_VERSION || 'dev';
    vEl.textContent = `v${ver}`;
  }

  // SPA-DNG-001 / SPA-DNG-002: sync delete button with download flag
  const _deleteBtn = document.getElementById('btnDeleteData');
  if (_deleteBtn) {
    _deleteBtn.disabled = localStorage.getItem('footy-manager-has-downloaded') !== '1';
  }
  // SPA-DNG-003 / SPA-DNG-006: reset inline confirmation on each render
  const _confirmBtn = document.getElementById('btnConfirmDeleteData');
  if (_deleteBtn && _confirmBtn) {
    _deleteBtn.style.display = '';
    _confirmBtn.style.display = 'none';
  }
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

// @front-end { element: teamsplits-panel, intent: "let the user drag or tap players between subteams for a round", customer: writer, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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

  const backBtn = document.getElementById('btnBackToRound');
  const backLbl = document.getElementById('btnBackToRoundLabel');
  if (backBtn && backLbl) {
    backBtn.hidden = false;
    backLbl.textContent = `Round ${activeRound}`;
    backBtn.onclick = () => openRoundDetail(activeRound);
  }

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

  // RT-006: FULL_TEAM round → one flat IN/OUT roster (no A/B groups, no drag).
  const activeRoundObj = allRounds.find(r => String(r.round) === activeRound);
  if (String(activeRoundObj?.round_type || '').toUpperCase() === 'FULL_TEAM') {
    const rows = sortedPlayers.map(p => {
      const absent = absenceSet.has(String(p.jumper));
      const jEsc = escHtml(String(p.jumper));
      return `<div class="tsp-player-row${absent ? ' tsp-absent' : ''}" data-jumper="${jEsc}">
        <span class="jumper-chip">#${jEsc}</span>
        <span class="tsp-player-name">${escHtml(p.player_name || '')}</span>
        <button class="tsp-inout-btn ${absent ? 'out' : 'in'}" data-action="tsp-toggle-inout" data-round="${escHtml(activeRound)}" data-jumper="${jEsc}">${absent ? 'OUT' : 'IN'}</button>
      </div>`;
    }).join('');
    content.innerHTML = `<div class="tsp-fullteam-note">Full-team round — no A/B split. Tap a player to toggle IN / OUT.</div>
      <div class="tsp-group" data-subteam="full">
        <div class="tsp-group-label">Full team</div>
        ${rows}
        <div class="tsp-group-summary">${sortedPlayers.length} player${sortedPlayers.length !== 1 ? 's' : ''}</div>
      </div>`;
    return;
  }

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
      // Drag/touch handled by delegated listeners on #teamSplitsContent
      // (wired once in setupTeamSplits). The row carries its jumper and its
      // current subteam so the handler can build the drag payload.
      return `<div class="tsp-player-row${absent ? ' tsp-absent' : ''}" data-jumper="${jEsc}" data-subteam="${stEsc}"
        draggable="true">
        <span class="jumper-chip">#${escHtml(String(p.jumper))}</span>
        <span class="tsp-player-name">${escHtml(p.player_name || '')}</span>${absentBadge}
      </div>`;
    }).join('');
    const stEsc = escHtml(subteam);
    const playerCount = groups[subteam].length;
    const countLabel = `${playerCount} player${playerCount !== 1 ? 's' : ''}`;
    return `<div class="tsp-group" data-subteam="${stEsc}">
      <div class="tsp-group-label">${escHtml(subteamLabel(subteam))}</div>
      ${rows}
      <div class="tsp-group-summary">${countLabel}</div>
    </div>`;
  }).join('');
}

// ── Global delegated event handling (CLM-001) ──────────────────────────────
// A single click + keydown listener replaces every former inline on* handler.
// Each interactive element declares its intent via data-action plus the data-*
// attributes that action needs. event.target.closest('[data-action]') resolves
// the innermost actionable element, so nested pills never trigger their parent.
function cycleLineupCell(round, jumper, current) {
  // RT-005: FULL_TEAM rounds toggle IN ⇄ OUT only (no subteam).
  if (roundTypeOf(round) === 'FULL_TEAM') {
    dispatch({ type: 'toggle-player-absent', payload: { round, jumper } });
    renderLineup();
    return;
  }
  if (current === 'A') {
    dispatch({ type: 'set-split', payload: { round, jumper, subteam: 'B' } });
  } else if (current === 'B') {
    dispatch({ type: 'toggle-player-absent', payload: { round, jumper } });
  } else { // 'OUT' → back to A
    dispatch({ type: 'toggle-player-absent', payload: { round, jumper } });
    dispatch({ type: 'set-split', payload: { round, jumper, subteam: 'A' } });
  }
  renderLineup();
}

function handleGlobalClick(ev) {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const d = el.dataset;
  switch (d.action) {
    // Navigation / rounds
    case 'open-round':       openRoundDetail(d.round); break;
    case 'confirm-round':    confirmRoundFromList(d.round); break;
    case 'toggle-ha':        toggleHomeAway(d.round); break;
    case 'toggle-round-type': toggleRoundType(d.round); break;
    case 'tsp-toggle-inout': dispatch({ type: 'toggle-player-absent', payload: { round: d.round, jumper: d.jumper } }); renderTeamSplits(); break;
    case 'close-edit':       closeEditMode(); break;
    case 'save-round-edit':  saveRoundEdit(d.round); break;
    // Volunteers
    case 'show-vol-popup':   showVolPopup(d.jumper); break;
    case 'toggle-vol-expand':
      dispatch({ type: 'toggle-vol-expanded', payload: { jumper: d.jumper } });
      renderVolunteers();
      break;
    case 'open-vol-swap':    openVolSwap(d.round, d.job, d.subteam, Number(d.slot)); break;
    case 'confirm-vol-swap': confirmVolSwap(d.round, d.job, d.subteam, Number(d.slot), d.volunteer, d.jumper); break;
    case 'unset-vol-swap':   unsetVolSwap(d.round, d.job, d.subteam, Number(d.slot)); break;
    case 'close-vol-popup':  closeVolPopup(); break;
    case 'close-vol-swap':   closeVolSwap(); break;
    // Balance
    case 'set-balance-sort':
      dispatch({ type: 'set-balance-sort', payload: { sortKey: d.sort } });
      renderBalance();
      break;
    // Lineup
    case 'cycle-lineup':     cycleLineupCell(d.round, d.jumper, d.current); break;
    case 'show-lineup-guide': { const ol = document.getElementById('lineupGuideOverlay'); if (ol) ol.style.display = 'flex'; break; }
    case 'hide-lineup-guide': { const ol = document.getElementById('lineupGuideOverlay'); if (ol) ol.style.display = 'none'; break; }
    // Settings / app
    case 'set-skin':         setSkin(d.skin); break;
    case 'set-density':
      dispatch({ type: 'set-ui-preference', payload: { key: 'density', value: d.density } });
      applyDensity();
      break;
    case 'print':            window.print(); break;
    case 'open-picker':      openPicker(); break;
    case 'save-snapshot':    saveSnapshot(); break;
    default: break;
  }
}

function handleGlobalChange(ev) {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'update-edit-location': updateEditLocation(el.value); break;
    case 'set-skin-select':      setSkin(el.value); break;
    default: break;
  }
}

// Keyboard activation for non-native-button actionable elements (Enter/Space).
// Native <button>/<a> already fire click on Enter/Space, so they are skipped.
function handleGlobalKeydown(ev) {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
  ev.preventDefault();
  el.click();
}

function setupGlobalDelegation() {
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('change', handleGlobalChange);
  document.addEventListener('input', handleGlobalInput);
  document.addEventListener('keydown', handleGlobalKeydown);
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

  // Delegated desktop drag-and-drop + touch start on the team-splits board.
  // Attached once to the container; survives innerHTML re-renders of children.
  const content = document.getElementById('teamSplitsContent');
  if (content) {
    content.addEventListener('dragstart', e => {
      const row = e.target.closest('.tsp-player-row');
      if (!row) return;
      e.dataTransfer.setData('text/plain', JSON.stringify({
        jumper: row.dataset.jumper, fromSubteam: row.dataset.subteam,
      }));
      e.dataTransfer.effectAllowed = 'move';
    });
    content.addEventListener('dragover', e => {
      const group = e.target.closest('.tsp-group');
      if (!group) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      group.classList.add('tsp-drop-target');
    });
    content.addEventListener('dragleave', e => {
      const group = e.target.closest('.tsp-group');
      if (group) group.classList.remove('tsp-drop-target');
    });
    content.addEventListener('drop', e => {
      const group = e.target.closest('.tsp-group');
      if (!group) return;
      e.preventDefault();
      group.classList.remove('tsp-drop-target');
      try {
        const d = JSON.parse(e.dataTransfer.getData('text/plain'));
        const toSt = group.dataset.subteam;
        if (d.fromSubteam === toSt) return;
        const roundSel = document.getElementById('teamSplitsRoundSelect');
        const rnd = roundSel ? roundSel.value : '';
        if (!rnd) return;
        dispatch({ type: 'set-split', payload: { round: rnd, jumper: d.jumper, subteam: toSt } });
        render();
      } catch (err) { console.error('tsp-drop', err); }
    });
    content.addEventListener('touchstart', e => {
      const row = e.target.closest('.tsp-player-row');
      if (row) tspTouchStart(row, e);
    }, { passive: false });
  }
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
  const prefixInp = document.getElementById('emailPrefixInput');
  if (prefixInp) prefixInp.addEventListener('input', () => {
    dispatch({ type: 'set-ui-preference', payload: { key: 'email_prefix', value: prefixInp.value } });
    render();
  });
  const suffixInp = document.getElementById('emailSuffixInput');
  if (suffixInp) suffixInp.addEventListener('input', () => {
    dispatch({ type: 'set-ui-preference', payload: { key: 'email_suffix', value: suffixInp.value } });
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

  // SPA-DNG-003 / SPA-DNG-004: danger zone handlers
  const deleteBtn  = document.getElementById('btnDeleteData');
  const confirmBtn = document.getElementById('btnConfirmDeleteData');
  if (deleteBtn)  deleteBtn.addEventListener('click', handleDeleteDataClick);
  if (confirmBtn) confirmBtn.addEventListener('click', handleConfirmDeleteData);
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

  // SPA-DNG-002: mark that a backup has been downloaded
  try {
    localStorage.setItem('footy-manager-has-downloaded', '1');
    const _db = document.getElementById('btnDeleteData');
    if (_db) _db.disabled = false;
  } catch (_) {}
}

// SPA-DNG-003: first click — show inline confirmation
function handleDeleteDataClick() {
  const deleteBtn  = document.getElementById('btnDeleteData');
  const confirmBtn = document.getElementById('btnConfirmDeleteData');
  if (!deleteBtn || !confirmBtn) return;
  deleteBtn.style.display  = 'none';
  confirmBtn.style.display = '';
}

// SPA-DNG-004: second click — execute deletion
async function handleConfirmDeleteData() {
  try { await window.__idb.clearSnapshot(); } catch (_) {}
  try {
    localStorage.removeItem('footy-manager-has-downloaded');
    localStorage.removeItem('footy-wizard-draft');
  } catch (_) {}
  location.reload();
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

      persist(parsed); await whenPersisted();   // durable before continuing (OFF-005a/d)
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
    loadAllDataRecords().catch(err => console.error('[spa] loadAllDataRecords:', err));
  }
}

// ── Skin switcher ─────────────────────────────────────────────────────────
// Apply a skin to the DOM without persisting (used by the OS-preference default).
function applySkin(name) {
  document.body.setAttribute('data-skin', name);
  const picker = document.getElementById('skinPicker');
  if (picker && picker.value !== name) picker.value = name;
}

function setSkin(name) {
  applySkin(name);
  localStorage.setItem('roster-skin', name); // explicit user choice → persist
}

const VALID_SKINS = ['dark', 'forest', 'sunset', 'nautical', 'cobalt', 'night-vision', 'native', 'chrome', 'sports', 'parallax', 'forest-shadows', 'saturn', 'andres-de-poitrein', 'gundam'];

function restoreSkin() {
  const saved = localStorage.getItem('roster-skin');
  if (saved && VALID_SKINS.includes(saved)) {
    applySkin(saved);
    return;
  }
  // CSS-007: no stored preference → honour the OS colour-scheme each load
  // (not persisted, so it keeps following the OS until the user picks a skin).
  // prefers light → the light skin (forest); otherwise the dark default.
  const prefersLight = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches;
  applySkin(prefersLight ? 'forest' : 'dark');
}

// ── Helpers ───────────────────────────────────────────────────────────────

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

// Thin wrappers: resolution logic lives in store-selectors.mjs; inject getData().
function getVolJumper(name) { return Sel.resolveJumperByName(getData(), name); }
function getVolunteerByJumper(jumper) { return Sel.resolveNameByJumper(getData(), jumper); }

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

// Format the round time shifted by deltaMin (tz-consistent with fmtTime).
function fmtTimeShifted(isoStr, deltaMin) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return '—';
  d.setMinutes(d.getMinutes() + deltaMin);
  return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// Arrival/start line: "{30 min before} ({start} start)" — players arrive 30 min early.
function fmtArrival(isoStr) {
  if (!isoStr) return '';
  return `${fmtTimeShifted(isoStr, -30)} (${fmtTime(isoStr)} start)`;
}

// CPT: resolves true when the copy succeeds, false otherwise — so callers can
// show the success toast only on a real write.
async function copyToClipboard(text) {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  document.body.removeChild(ta);
  return ok;
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
  return `<span class="ha-pill ${label.cls}" role="button" tabindex="0" style="cursor:pointer;user-select:none" data-action="toggle-ha" data-round="${escHtml(String(r.round))}" aria-label="Toggle home/away for round ${escHtml(String(r.round))} (currently ${label.text})">${label.text}</span>`;
}

// RT-001: a round's split type (default SPLIT). FULL_TEAM rounds need only one
// Goal Umpire + Umpire Escort and use IN/OUT (no A/B) in the lineup/splits UIs.
function roundTypeOf(roundNum) {
  const r = getRoundByNum(roundNum);
  return String(r?.round_type || '').toUpperCase() === 'FULL_TEAM' ? 'FULL_TEAM' : 'SPLIT';
}

// RT-004: edit-form pill to toggle SPLIT ⇄ FULL_TEAM (mirrors haTogglePill).
// Like home/away, the change takes effect on the next Re-allocate. BYE has no teams.
function roundTypePill(r) {
  if (r.home_away === 'B') return '';
  const isFull = String(r.round_type || '').toUpperCase() === 'FULL_TEAM';
  const text = isFull ? 'Full team' : 'Split (A/B)';
  const cls = isFull ? 'rt-full' : 'rt-split';
  return `<span class="ha-pill ${cls}" role="button" tabindex="0" style="cursor:pointer;user-select:none" data-action="toggle-round-type" data-round="${escHtml(String(r.round))}" aria-label="Toggle round type for round ${escHtml(String(r.round))} (currently ${text}); re-allocate to apply">${text}</span>`;
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

}

// RT-004: flip a round's SPLIT ⇄ FULL_TEAM. Like toggleHomeAway, this persists the
// field and updates the edit-form row in place; the slot counts change on Re-allocate.
function toggleRoundType(roundNum) {
  const r = getRoundByNum(roundNum);
  if (!r || r.home_away === 'B') return;
  const newType = String(r.round_type || '').toUpperCase() === 'FULL_TEAM' ? 'SPLIT' : 'FULL_TEAM';
  dispatch({ type: 'save-round-edit', payload: { roundNum: String(roundNum), updates: { round_type: newType } } });

  const editForm = document.getElementById('roundEditForm');
  const inEditMode = editForm && editForm.style.display !== 'none' && editForm.innerHTML.length > 0;
  if (inEditMode) {
    const typeRow = document.getElementById('editTypeRow');
    if (typeRow) typeRow.innerHTML = `<span class="edit-form-label">Round type</span>${roundTypePill(getRoundByNum(roundNum))}`;
  } else {
    render();
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
}

// ── Lineup (splits editor) ───────────────────────────────────────────────
// @front-end { element: lineup-panel, intent: "let the user cycle each player A/B/OUT slot across rounds in a grid", customer: writer, binding: one-way, style: mixed, a11y: wcag-2.1-aa, improve?: "Phase 2 adds focus management + keyboard paths here" }
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
    const fullTeam = String(r.round_type || '').toUpperCase() === 'FULL_TEAM';
    return `<th class="lineup-th-round" title="${escHtml(resolveOpposition(r))}">
      <div>Rd ${escHtml(String(r.round))}</div>
      ${haLabel ? `<div class="ha-pill ${haClass}" style="font-size:9px;padding:1px 3px;">${haLabel}</div>` : ''}
      ${fullTeam ? '<div class="lineup-fullteam-tag" title="Full-team round — IN/OUT">FULL</div>' : ''}
    </th>`;
  }).join('');

  const bodyRows = sortedPlayers.map(p => {
    const cells = rounds.map(r => {
      const key = `${r.round}|${p.jumper}`;
      const absent = absenceSet.has(key);
      // RT-005: FULL_TEAM rounds use IN/OUT (no A/B subteam); SPLIT uses A/B/OUT.
      const fullTeam = String(r.round_type || '').toUpperCase() === 'FULL_TEAM';
      const current = absent ? 'OUT' : (fullTeam ? 'IN' : (splitMap[key] || 'A'));
      const rEsc = escHtml(String(r.round));
      const jEsc = escHtml(String(p.jumper));
      // Delegated cycle handler reads data-current to know which transition to apply.
      const tdCls = absent ? ' lineup-td-out' : '';
      return `<td class="lineup-td-cell${tdCls}"><button
        class="lineup-cell-btn ${escHtml(current)}"
        data-action="cycle-lineup"
        data-round="${rEsc}"
        data-jumper="${jEsc}"
        data-current="${escHtml(current)}"
        title="Rd ${rEsc} · #${jEsc} ${escHtml(p.player_name || '')} — click to toggle"
      >${escHtml(current)}</button></td>`;
    }).join('');
    return `<tr>
      <td class="lineup-td-player"><span class="jumper-chip">#${escHtml(String(p.jumper))}</span> ${escHtml(p.player_name || '')}</td>
      ${cells}
    </tr>`;
  }).join('');

  container.innerHTML = `<button class="lineup-help-btn"
    data-action="show-lineup-guide"
    title="How to use the lineup" aria-label="Show lineup instructions"
    aria-controls="lineupGuideOverlay">&#x1F4A1;</button>

  <div id="lineupGuideOverlay" class="lineup-guide-overlay" style="display:none"
    role="dialog" aria-modal="true" aria-label="Lineup instructions"
    data-action="hide-lineup-guide">
    <div class="lineup-guide-card">
      <p><strong>Tap any cell</strong> to cycle a player's slot:</p>
      <p class="lineup-guide-cycle">A &rarr; B &rarr; OUT &rarr; A</p>
      <p><strong>A</strong> and <strong>B</strong> assign the player&rsquo;s subteam &mdash; used for Goal Umpire and Umpire Escort slots.</p>
      <p><strong>FULL</strong> rounds (full team, not split) toggle <strong>IN &rarr; OUT</strong> only &mdash; no A/B.</p>
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
  // RLK-003: a completed (locked) round is read-only — no volunteer swaps.
  if (isRoundLocked(getRoundByNum(roundNum))) return;

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

  const slotAttrs = `data-round="${escHtml(String(roundNum))}" data-job="${escHtml(job)}" data-subteam="${escHtml(subteam)}" data-slot="${Number(slotIndex)}"`;
  const unsetBtn = isManual
    ? `<button class="vol-swap-item vol-swap-item-unset" data-action="unset-vol-swap" ${slotAttrs}>↩ Unset — revert to automatic allocation</button>`
    : '';

  // ERG-007: stash the candidate set so the typeahead can re-filter without
  // recomputing eligibility. The search input lives outside #volSwapList so it
  // keeps focus across re-renders.
  _volSwapState = { candidates, slotAttrs, unsetBtn };
  const search = document.getElementById('volSwapSearch');
  if (search) search.value = '';
  renderVolSwapList('');

  overlay.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

let _volSwapState = null;

function renderVolSwapList(filter) {
  const list = document.getElementById('volSwapList');
  if (!list || !_volSwapState) return;
  const { candidates, slotAttrs, unsetBtn } = _volSwapState;
  const lower = String(filter || '').toLowerCase();
  const shown = candidates.filter(v =>
    String(v.volunteer || '').toLowerCase().includes(lower)
    || String(v.jumper || '').toLowerCase().includes(lower));
  list.innerHTML = unsetBtn + (shown.length === 0
    ? '<p class="vol-swap-empty">No matching volunteers</p>'
    : shown.map(v =>
        `<button class="vol-swap-item" data-action="confirm-vol-swap" ${slotAttrs} data-volunteer="${escHtml(v.volunteer)}" data-jumper="${escHtml(v.jumper)}">#${escHtml(v.jumper)} ${escHtml(v.volunteer)}</button>`
      ).join(''));
}

function handleGlobalInput(ev) {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'filter-vol-swap') {
    renderVolSwapList(el.value);
  }
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
    columns: ['round','home_away','date','time','opposition_club_id','location_id','extra_notes'],
    fields: [
      { name: 'round',              label: 'Round #',         type: 'text',       required: true  },
      { name: 'home_away',          label: 'Home/Away',       type: 'select',     required: true,
        options: ['h','a','B']                                                                     },
      { name: 'date',               label: 'Date',            type: 'date',       required: true  },
      { name: 'time',               label: 'Time',            type: 'text',       required: false },
      { name: 'opposition_club_id', label: 'Opposition Club', type: 'select-ref',
        refType: 'clubs', refPk: 'club_id', refLabel: 'name', required: false                     },
      { name: 'location_id',        label: 'Location',        type: 'select-ref',
        refType: 'locations', refPk: 'location_id', refLabel: 'display_name', required: false     },
      { name: 'extra_notes',        label: 'Notes',           type: 'text',       required: false },
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
      { name: 'display_name', label: 'Display name', type: 'text',       required: true  },
      { name: 'club_id',      label: 'Home club',    type: 'select-ref',
        refType: 'clubs', refPk: 'club_id', refLabel: 'name',            required: false },
    ],
  },
  jobs: {
    pk: 'job_id',
    label: 'Job',
    columns: ['job_id','job_name','volunteers_required','subteam','home_only'],
    fields: [
      { name: 'job_name',            label: 'Job name',  type: 'text', required: true  },
      { name: 'volunteers_required', label: 'Slots',     type: 'text', required: false },
      { name: 'subteam',             label: 'Subteam',   type: 'text', required: false },
      { name: 'home_only',           label: 'Home only', type: 'text', required: false },
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
    label: 'Volunteer Prefs',
    // volunteer_name is display-only (derived from players) — not in fields.
    // DVE: jobs have no job_id, and the allocator reads preferred_job (singular)
    // and avoid_jobs (plural) as semicolon-delimited job NAMES — so the pickers
    // key on job_name and persist to those exact fields.
    columns: ['jumper','volunteer_name','preferred_job','avoid_jobs'],
    fields: [
      { name: 'jumper',        label: 'Jumper #', type: 'text',          required: true  },
      { name: 'preferred_job', label: 'Prefers', type: 'tag-picker-ref',
        refType: 'jobs', refPk: 'job_name', refLabel: 'job_name',        required: false },
      { name: 'avoid_jobs',    label: 'Avoids',   type: 'tag-picker-ref',
        refType: 'jobs', refPk: 'job_name', refLabel: 'job_name',        required: false },
    ],
  },
};

// Fetch records for a data type and cache them
async function fetchDataRecords(type) {
  // Read from the store — no server call
  const data = getData();
  if (type === 'rounds') {
    // rounds live in round_summary.rounds, not reference_data
    // deepClone to get a mutable copy (store data is deepFreeze'd)
    _dataRecords[type] = deepClone(data?.round_summary?.rounds || []);
  } else if (type === 'volunteers') {
    // Volunteers are players. Name is derived from players by jumper (read-only).
    // Post-save data lives in reference_data.volunteers; initial load falls back to
    // volunteers.eligible (populated by the wizard).
    const players = _dataRecords['players'] || (data?.reference_data?.players || []);
    const nameByJumper = Object.fromEntries(
      players.map(p => [String(p.jumper), p.player_name])
    );
    const fromRef = (data?.reference_data?.volunteers || []);
    if (fromRef.length > 0) {
      _dataRecords[type] = fromRef.map(v => ({
        ...v,
        volunteer_name: nameByJumper[String(v.jumper)] || v.volunteer_name || '',
      }));
    } else {
      _dataRecords[type] = (data?.volunteers?.eligible || []).map(v => ({
        jumper:         String(v.jumper),
        volunteer_name: nameByJumper[String(v.jumper)] || v.volunteer || '',
        // DVE: canonical allocator format — semicolon-joined job NAMES.
        preferred_job:  (v.preferred_jobs || []).join(';'),
        avoid_jobs:     (v.avoid_jobs     || []).join(';'),
      }));
    }
  } else {
    // deepClone to get a mutable copy (store data is deepFreeze'd)
    _dataRecords[type] = deepClone((data?.reference_data || {})[type] || []);
  }
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

  const rows = records.map((rec, index) => {
    const cells = cols.map(col =>
      `<td>${escHtml(String(rec[col] ?? ''))}</td>`
    ).join('');
    // DJE: stable row identity — falls back to the row index when the pk is
    // absent (jobs have no job_id) so every Edit opens its OWN row.
    const id = encodeRowRef(rec, schema, index);
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

function initTagPickers(dlg) {
  dlg.querySelectorAll('.tag-picker').forEach(picker => {
    const fieldName = picker.dataset.field;
    const refType   = picker.dataset.refType;
    const refPk     = picker.dataset.refPk;
    const refLabel  = picker.dataset.refLabel;
    const input     = picker.querySelector('.tag-input');
    const dropdown  = picker.querySelector('.tag-dropdown');
    const pillsEl   = picker.querySelector('.tag-pills');
    const hidden    = dlg.querySelector(`#tp-hidden-${fieldName}`);

    function getIds() {
      try { return JSON.parse(hidden.value || '[]'); } catch { return []; }
    }
    function setIds(ids) { hidden.value = JSON.stringify(ids); }

    function renderDropdown(filter) {
      const records = _dataRecords[refType] || [];
      const current = getIds();
      const matches = records.filter(r => {
        if (current.includes(r[refPk])) return false;
        return !filter || String(r[refLabel] ?? '').toLowerCase().includes(filter.toLowerCase());
      });
      dropdown.innerHTML = matches.map(r =>
        `<div class="tag-option" data-pk="${r[refPk]}">${escHtml(String(r[refLabel] ?? r[refPk]))}</div>`
      ).join('');
      dropdown.classList.toggle('hidden', matches.length === 0);
    }

    function addPill(pkVal, label) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.dataset.id = pkVal;
      pill.innerHTML = `${escHtml(label)}<button type="button" class="tag-remove" aria-label="Remove ${escHtml(label)}">×</button>`;
      pill.querySelector('.tag-remove').addEventListener('click', () => {
        const ids = getIds().filter(id => id !== pkVal);
        setIds(ids);
        pill.remove();
      });
      pillsEl.appendChild(pill);
    }

    input.addEventListener('input', () => renderDropdown(input.value));
    input.addEventListener('focus', () => renderDropdown(input.value));

    dropdown.addEventListener('click', e => {
      const opt = e.target.closest('.tag-option');
      if (!opt) return;
      // DVE: keep the ref key as-is (a job_name string). Coercing to Number
      // produced NaN for name keys and was the root of the comma garbage.
      const pk = opt.dataset.pk;
      const label = opt.textContent;
      const ids = getIds();
      if (!ids.includes(pk)) {
        ids.push(pk);
        setIds(ids);
        addPill(pk, label);
      }
      input.value = '';
      dropdown.classList.add('hidden');
      input.focus();
    });

    document.addEventListener('click', function closeDropdown(e) {
      if (!picker.contains(e.target)) {
        dropdown.classList.add('hidden');
        if (!dlg.open) document.removeEventListener('click', closeDropdown);
      }
    });
  });
}

// Open add/edit dialog
async function openDataDialog(type, idEncoded = null) {
  const schema = DATA_SCHEMAS[type];
  const isEdit = idEncoded !== null;
  // DJE: resolve the EXACT record the Edit button belongs to (index-safe).
  const existing = isEdit
    ? resolveRecordForEdit(_dataRecords[type] || [], schema, idEncoded)
    : null;

  // Pre-load any ref tables needed by select-ref AND tag-picker-ref fields
  // (DVE: the jobs ref table must be present so volunteer-pref pills resolve).
  const refTypes = [...new Set(
    schema.fields.filter(f => f.type === 'select-ref' || f.type === 'tag-picker-ref').map(f => f.refType)
  )];
  await Promise.all(refTypes.map(rt => {
    if (!_dataRecords[rt]) return fetchDataRecords(rt);
    return Promise.resolve();
  }));

  // Remove any existing dialog
  const old = document.getElementById('dataDialog');
  if (old) old.remove();

  // For volunteers: show player name as a read-only label above the form
  let volunteerLabel = '';
  if (type === 'volunteers' && existing) {
    volunteerLabel = `<p class="data-field-readonly"><strong>Player:</strong> ${escHtml(existing.volunteer_name || '(unknown)')}</p>`;
  }

  const fields = schema.fields.map(f => {
    const val = existing ? String(existing[f.name] ?? '') : '';
    const req = f.required ? 'required' : '';
    if (f.type === 'select') {
      const opts = f.options.map(o =>
        `<option value="${o}" ${existing && existing[f.name] === o ? 'selected' : ''}>${escHtml(o)}</option>`
      ).join('');
      return `<div class="data-field">
        <label for="df-${f.name}">${escHtml(f.label)}${f.required ? ' *' : ''}</label>
        <select id="df-${f.name}" name="${f.name}" ${req}>${opts}</select>
      </div>`;
    }
    if (f.type === 'select-ref') {
      const refRecords = _dataRecords[f.refType] || [];
      const noneOpt = `<option value="">— none —</option>`;
      const opts = refRecords.map(r => {
        const pkVal = String(r[f.refPk] ?? '');
        const label = escHtml(String(r[f.refLabel] ?? pkVal));
        const sel = val === pkVal ? 'selected' : '';
        return `<option value="${escHtml(pkVal)}" ${sel}>${label}</option>`;
      }).join('');
      return `<div class="data-field">
        <label for="df-${f.name}">${escHtml(f.label)}${f.required ? ' *' : ''}</label>
        <select id="df-${f.name}" name="${f.name}" ${req}>${noneOpt}${opts}</select>
        <span class="data-field-error hidden" id="dfe-${f.name}"></span>
      </div>`;
    }
    if (f.type === 'tag-picker-ref') {
      const refRecords = _dataRecords[f.refType] || [];
      // DVE: normalise the stored value (a ;-string or array) into clean job names.
      const existingIds = normalizeJobNames(existing?.[f.name], refRecords);
      const pillsHtml = existingIds.map(id => {
        const rec = refRecords.find(r => String(r[f.refPk]) === String(id));
        const label = rec ? escHtml(String(rec[f.refLabel] ?? id)) : String(id);
        return `<span class="tag-pill" data-id="${id}">${label}<button type="button" class="tag-remove" aria-label="Remove ${label}">×</button></span>`;
      }).join('');
      return `<div class="data-field">
        <label>${escHtml(f.label)}${f.required ? ' *' : ''}</label>
        <div class="tag-picker" data-field="${f.name}" data-ref-type="${f.refType}"
             data-ref-pk="${f.refPk}" data-ref-label="${f.refLabel}">
          <div class="tag-pills">${pillsHtml}</div>
          <input class="tag-input" type="text" placeholder="Type to search…" autocomplete="off">
          <div class="tag-dropdown hidden"></div>
        </div>
        <input type="hidden" name="${f.name}" id="tp-hidden-${f.name}" value="${escHtml(JSON.stringify(existingIds))}">
      </div>`;
    }
    return `<div class="data-field">
      <label for="df-${f.name}">${escHtml(f.label)}${f.required ? ' *' : ''}</label>
      <input id="df-${f.name}" name="${f.name}" type="${f.type}" value="${escHtml(val)}" ${req}
             placeholder="${escHtml(f.label)}">
      <span class="data-field-error hidden" id="dfe-${f.name}"></span>
    </div>`;
  }).join('');

  const dlg = document.createElement('dialog');
  dlg.id = 'dataDialog';
  dlg.innerHTML = `
    <form id="dataDialogForm">
      <h3>${isEdit ? 'Edit' : 'Add'} ${escHtml(schema.label)}</h3>
      ${volunteerLabel}
      ${fields}
      <div class="data-dialog-error hidden" id="dataDialogError"></div>
      <div class="data-dialog-actions">
        <button type="button" class="btn" id="dataDialogCancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="dataDialogSave">Save</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  initTagPickers(dlg);

  dlg.querySelector('#dataDialogCancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());

  // RLOC-003: in the Rounds dialog, changing the opposition club repopulates the
  // location select with that club's home grounds (first selected).
  if (type === 'rounds') {
    const clubSel = dlg.querySelector('#df-opposition_club_id');
    const locSel  = dlg.querySelector('#df-location_id');
    if (clubSel && locSel) {
      clubSel.addEventListener('change', () => {
        const grounds = homeGroundsForClub(_dataRecords['locations'], clubSel.value);
        locSel.innerHTML = '<option value="">— none —</option>' + grounds.map((g, i) =>
          `<option value="${escHtml(String(g.location_id))}"${i === 0 ? ' selected' : ''}>${escHtml(String(g.display_name ?? g.location_id))}</option>`
        ).join('');
      });
    }
  }

  dlg.querySelector('#dataDialogSave').addEventListener('click', async () => {
    await submitDataForm(type, isEdit, idEncoded, dlg, schema);
  });
}

async function submitDataForm(type, isEdit, idEncoded, dlg, schema) {
  const form = dlg.querySelector('#dataDialogForm');
  const errEl = dlg.querySelector('#dataDialogError');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  // Collect form values
  const body = {};
  schema.fields.forEach(f => {
    const el = form.querySelector(`[name="${f.name}"]`);
    if (!el) return;
    if (f.type === 'tag-picker-ref') {
      // DVE: store the canonical semicolon-joined job NAMES the allocator reads
      // (never JSON / comma garbage).
      let picked = [];
      try { picked = JSON.parse(el.value || '[]'); } catch { picked = []; }
      body[f.name] = serializeJobNames(picked);
    } else {
      body[f.name] = el.value;
    }
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

  // Persist the record to the in-memory cache and the store
  const pk = schema.pk;

  // Auto-assign PKs for new records that need numeric IDs
  if (!isEdit) {
    if (type === 'clubs') {
      const maxId = Math.max(0, ...(_dataRecords['clubs'] || []).map(r => Number(r.club_id) || 0));
      body.club_id = String(maxId + 1);
    } else if (type === 'locations') {
      const maxId = Math.max(0, ...(_dataRecords['locations'] || []).map(r => Number(r.location_id) || 0));
      body.location_id = String(maxId + 1);
    }
  }

  if (isEdit) {
    // DJE: resolve the SAME record the dialog was opened from (index-safe), then
    // update it in place by identity.
    const record = resolveRecordForEdit(_dataRecords[type] || [], schema, idEncoded);
    const idx = record ? (_dataRecords[type] || []).indexOf(record) : -1;
    if (idx >= 0) _dataRecords[type][idx] = { ..._dataRecords[type][idx], ...body };
  } else {
    if (!_dataRecords[type]) _dataRecords[type] = [];
    _dataRecords[type].push(body);
  }

  if (type === 'rounds') {
    // rounds live in round_summary.rounds — replace the full array (handles both edit + add)
    const currentData = getData();
    const roundSummary = { ...(currentData?.round_summary || {}), rounds: _dataRecords['rounds'] };
    dispatch({ type: 'apply-server-fragments', payload: { fragments: { round_summary: roundSummary } } });
  } else {
    // All other types (including volunteers) write to reference_data via update-reference-data
    dispatch({ type: 'update-reference-data', payload: { key: type, records: _dataRecords[type] } });
  }

  // When a NEW player is added, also add a matching volunteer (same jumper) so they
  // can be allocated. There is no other UI to add the volunteer side, so default to
  // eligible='Y'. Skip if a volunteer with that jumper already exists.
  if (!isEdit && type === 'players') {
    const vols = (getData()?.reference_data?.volunteers || []).map(v => ({ ...v }));
    const jumper = String(body.jumper || '').trim();
    if (jumper && !vols.some(v => String(v.jumper) === jumper)) {
      vols.push({ jumper, volunteer_name: body.player_name || '', eligible: 'Y', preferred_job: '', avoid_jobs: '' });
      _dataRecords['volunteers'] = vols;
      dispatch({ type: 'update-reference-data', payload: { key: 'volunteers', records: vols } });
    }
  }
  dlg.close();
  await refreshDataSubpanel(type);
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
  // Delete from in-memory cache and update store. DJE: resolve the exact record
  // (index-safe) and remove it by identity so pk-less rows delete correctly.
  const schema = DATA_SCHEMAS[type];
  const record = resolveRecordForEdit(_dataRecords[type] || [], schema, idEncoded);
  if (record) {
    _dataRecords[type] = (_dataRecords[type] || []).filter(r => r !== record);
  }
  if (type !== 'volunteers') {
    dispatch({ type: 'update-reference-data', payload: { key: type, records: _dataRecords[type] } });
  }
  await refreshDataSubpanel(type);
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
