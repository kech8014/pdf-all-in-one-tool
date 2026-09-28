import type { WorkspaceState } from './types';

/**
 * Linear undo/redo timeline of immutable states. Because operations never mutate,
 * consecutive states share every unchanged page and annotation object, so keeping a
 * long history is cheap. Binary data (PDF bytes, images) lives in the blob store and
 * is referenced by id, never copied into a snapshot.
 */
export interface HistoryEntry {
  state: WorkspaceState;
  /** Human-readable name of the action that produced this state. */
  label: string;
  at: number;
}

export interface History {
  entries: HistoryEntry[];
  /** Index of the present state in `entries`. */
  index: number;
}

export const HISTORY_LIMIT = 200;

export function createHistory(state: WorkspaceState, label = 'Opened workspace'): History {
  return { entries: [{ state, label, at: Date.now() }], index: 0 };
}

export function present(h: History): WorkspaceState {
  return h.entries[h.index].state;
}

export function commit(h: History, state: WorkspaceState, label: string, limit = HISTORY_LIMIT): History {
  if (state === present(h)) return h;
  const entries = h.entries.slice(0, h.index + 1);
  entries.push({ state, label, at: Date.now() });
  const overflow = Math.max(0, entries.length - limit);
  return { entries: overflow ? entries.slice(overflow) : entries, index: entries.length - 1 - overflow };
}

/**
 * Replace the present state without creating a new undo step. Used to merge a burst
 * of small edits (e.g. typing into a text box) into the step that started it.
 */
export function amend(h: History, state: WorkspaceState, label?: string): History {
  const entries = h.entries.slice(0, h.index + 1);
  const cur = entries[h.index];
  entries[h.index] = { state, label: label ?? cur.label, at: Date.now() };
  return { entries, index: h.index };
}

export const canUndo = (h: History) => h.index > 0;
export const canRedo = (h: History) => h.index < h.entries.length - 1;
export const undoLabel = (h: History) => (canUndo(h) ? h.entries[h.index].label : null);
export const redoLabel = (h: History) => (canRedo(h) ? h.entries[h.index + 1].label : null);

export function undo(h: History): History {
  return canUndo(h) ? { ...h, index: h.index - 1 } : h;
}

export function redo(h: History): History {
  return canRedo(h) ? { ...h, index: h.index + 1 } : h;
}

export function jumpTo(h: History, index: number): History {
  if (index < 0 || index >= h.entries.length) return h;
  return { ...h, index };
}
