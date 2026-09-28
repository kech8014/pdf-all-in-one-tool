import type { Annotation, WorkspaceState } from './types';

const finite = (...n: number[]) => n.every((v) => typeof v === 'number' && Number.isFinite(v));
const ROTATIONS = new Set([0, 90, 180, 270]);

function checkAnnotation(a: Annotation, where: string, problems: string[]) {
  if (!a || typeof a.id !== 'string') {
    problems.push(`${where}: annotation without id`);
    return;
  }
  if (!finite(a.opacity) || a.opacity < 0 || a.opacity > 1) problems.push(`${where}/${a.id}: opacity out of range`);
  switch (a.type) {
    case 'ink':
      if (a.points.length < 2 || a.points.length % 2 !== 0 || !finite(...a.points)) problems.push(`${where}/${a.id}: bad ink points`);
      if (!finite(a.width) || a.width <= 0) problems.push(`${where}/${a.id}: bad pen width`);
      break;
    case 'line':
      if (!finite(a.x1, a.y1, a.x2, a.y2, a.width)) problems.push(`${where}/${a.id}: bad line`);
      break;
    case 'note':
      if (!finite(a.x, a.y)) problems.push(`${where}/${a.id}: bad note position`);
      break;
    case 'text':
    case 'image':
    case 'shape':
    case 'highlight':
    case 'whiteout':
      if ((a.type === 'text' || a.type === 'image') && !ROTATIONS.has(a.rotation)) problems.push(`${where}/${a.id}: bad rotation`);
      if (!finite(a.rect.x, a.rect.y, a.rect.w, a.rect.h) || a.rect.w < 0 || a.rect.h < 0) {
        problems.push(`${where}/${a.id}: bad rectangle`);
      }
      break;
    default:
      problems.push(`${where}: unknown annotation type ${(a as { type: string }).type}`);
  }
}

/**
 * Structural invariants of the canonical state. Checked on every commit: a state that
 * fails is rejected before it can reach history, persistence or export.
 */
export function validateState(state: WorkspaceState): string[] {
  const problems: string[] = [];
  if (state.schema !== 1) problems.push(`unsupported schema ${state.schema}`);
  const pageIds = new Set<string>();
  const annIds = new Set<string>();
  state.pages.forEach((p, i) => {
    const where = `page ${i + 1}`;
    if (pageIds.has(p.id)) problems.push(`${where}: duplicate page id ${p.id}`);
    pageIds.add(p.id);
    const src = state.sources[p.sourceId];
    if (!src) problems.push(`${where}: missing source ${p.sourceId}`);
    else if (!Number.isInteger(p.sourcePageIndex) || p.sourcePageIndex < 0 || p.sourcePageIndex >= src.pageCount) {
      problems.push(`${where}: page index ${p.sourcePageIndex} outside ${src.name} (${src.pageCount} pages)`);
    }
    if (!ROTATIONS.has(p.rotation)) problems.push(`${where}: bad rotation ${p.rotation}`);
    for (const a of p.annotations) {
      if (annIds.has(a.id)) problems.push(`${where}: duplicate annotation id ${a.id}`);
      annIds.add(a.id);
      checkAnnotation(a, where, problems);
    }
  });
  for (const s of Object.values(state.sources)) {
    if (s.pages.length !== s.pageCount) problems.push(`source ${s.name}: page table does not match page count`);
  }
  return problems;
}
