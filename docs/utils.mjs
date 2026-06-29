'use strict';

/**
 * Escape a string for safe embedding in HTML attribute values and text content.
 * @param {*} str
 * @returns {string}
 */
export function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// CPT-001: the emoji-decorated label for the "copied to clipboard" success toast,
// shown in the same 'ok' style as the allocation-complete toast.
export function copyToastMessage() {
  return '✓ Copied.';
}

/**
 * Make a job header agree with its slot count: singular when 1, plural when >1.
 * count<=1 keeps the job's canonical name. count>1 appends "s", EXCEPT names that
 * already end in "s" (e.g. "Half-time Snacks") or all-caps acronyms (e.g. "BBQ"),
 * which are left unchanged so they read naturally.
 * @param {string} name  the job name (canonical/singular role name)
 * @param {number} count number of slots in the group
 * @returns {string}
 */
export function pluralizeJob(name, count) {
  const base = String(name == null ? '' : name);
  if (count <= 1) return base;
  if (/s$/i.test(base)) return base;
  if (/^[A-Z0-9]+$/.test(base)) return base; // acronym (BBQ)
  return base + 's';
}
