import type { AnnotationId, WorkspaceState } from '../core/types';
import { ui } from './uiStore';

/**
 * Keeps the stamp counter in step with undo/redo. Every stamp placed is remembered with
 * its number; when undo takes the latest stamp away, its number becomes the next stamp
 * again (undo C3 -> the next click stamps C3), and redo moves the counter forward again.
 */
const placed: { id: AnnotationId; n: number }[] = [];
const undone: { id: AnnotationId; n: number }[] = [];

export function recordStamp(id: AnnotationId, n: number) {
  placed.push({ id, n });
  undone.length = 0;
}

export function syncStamps(state: WorkspaceState) {
  if (!placed.length && !undone.length) return;
  const ids = new Set<AnnotationId>();
  for (const p of state.pages) for (const a of p.annotations) ids.add(a.id);
  let next: number | null = null;
  while (placed.length && !ids.has(placed[placed.length - 1].id)) {
    const s = placed.pop()!;
    undone.push(s);
    next = s.n;
  }
  while (undone.length && ids.has(undone[undone.length - 1].id)) {
    const s = undone.pop()!;
    placed.push(s);
    next = s.n + 1;
  }
  if (next !== null && next !== ui.get().settings.stampNext) ui.updateSettings({ stampNext: next });
}

/** A cursor that shows the NEXT stamp in a box, centred on the click point. */
export function stampCursor(label: string, color: string): string {
  const w = Math.min(124, Math.max(34, Math.round(label.length * 9.5 + 18)));
  const h = 28;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="3" fill="white" fill-opacity="0.9" stroke="${color}" stroke-width="2" stroke-dasharray="4 2"/>` +
    `<text x="${w / 2}" y="19" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="15" fill="${color}">${label.replace(/[<>&"]/g, '')}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(w / 2)} ${h / 2}, crosshair`;
}
