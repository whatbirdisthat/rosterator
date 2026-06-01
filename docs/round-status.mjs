'use strict';

// @front-end
// element: round-status
// philosophy: one-way-data-binding
// paradigm: layered (render ← intent ← state)
// intent: own the round lock/completed state semantics as pure, testable functions
//         so the render layer asks one boolean ("is this round locked?") rather than
//         re-deriving status meaning in markup
// customer: developer
// binding: one-way
// breadcrumbs:
//   - "PURE module: zero DOM, zero window.*, zero side effects"
//   - "status values: 'scheduled' | 'confirmed' | 'completed'; 'completed' === locked/read-only"
//   - "lock toggles confirmed↔completed (RLK-001/002)"
// improve?: "if more lifecycle states appear (e.g. 'cancelled'), model as an ordered enum"

// RLK-003: a completed round is locked (read-only: edit/swap/reallocate disabled).
export function isRoundLocked(round) {
  return round?.status === 'completed';
}

// RLK-001/002: the lock control flips confirmed↔completed.
export function nextLockStatus(status) {
  return status === 'completed' ? 'confirmed' : 'completed';
}

// RLK-006: the status pill label + CSS class for a round status.
export function roundStatusPill(status) {
  if (status === 'completed') return { label: 'Completed', cls: 'completed' };
  if (status === 'confirmed') return { label: 'Confirmed', cls: 'ok' };
  return { label: 'Scheduled', cls: 'warn' };
}
