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
