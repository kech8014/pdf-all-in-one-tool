import { newId } from './ids';
import { normRotation, translateAnnotation } from './geometry';
import type {
  Annotation,
  AnnotationId,
  BlobId,
  CompressionLevel,
  NewAnnotation,
  Page,
  PageId,
  SourceDoc,
  SourceId,
  WorkspaceMeta,
  WorkspaceState,
} from './types';

/**
 * Pure operations on the canonical workspace state. Each returns a NEW state and never
 * mutates its input, which is what makes undo/redo a matter of keeping old states.
 * Pages are addressed by stable id, never by index, so an operation can never attach
 * work to the wrong page after a reorder.
 */

export function createWorkspace(name = 'Untitled workspace'): WorkspaceState {
  return {
    schema: 1,
    id: newId('ws'),
    name,
    createdAt: Date.now(),
    sources: {},
    pages: [],
    meta: { title: '', author: '', subject: '' },
  };
}

export function renameWorkspace(state: WorkspaceState, name: string): WorkspaceState {
  const trimmed = name.trim() || 'Untitled workspace';
  return trimmed === state.name ? state : { ...state, name: trimmed };
}

export function setMeta(state: WorkspaceState, meta: Partial<WorkspaceMeta>): WorkspaceState {
  return { ...state, meta: { ...state.meta, ...meta } };
}

export function addSources(state: WorkspaceState, sources: SourceDoc[]): WorkspaceState {
  if (sources.length === 0) return state;
  const next = { ...state.sources };
  for (const s of sources) next[s.id] = s;
  return { ...state, sources: next };
}

/** New page objects (fresh ids, no annotations) for some or all pages of a source. */
export function pagesFromSource(source: SourceDoc, indices?: number[]): Page[] {
  const list = indices ?? Array.from({ length: source.pageCount }, (_, i) => i);
  return list.map((i) => {
    if (!Number.isInteger(i) || i < 0 || i >= source.pageCount) {
      throw new Error(`Page ${i + 1} does not exist in ${source.name}`);
    }
    return { id: newId('pg'), sourceId: source.id, sourcePageIndex: i, rotation: 0, annotations: [] };
  });
}

export function pageIndex(state: WorkspaceState, id: PageId): number {
  return state.pages.findIndex((p) => p.id === id);
}

export function getPage(state: WorkspaceState, id: PageId): Page | undefined {
  return state.pages.find((p) => p.id === id);
}

/** Insert pages so the first one lands at `index` (clamped to 0..pageCount). */
export function insertPages(state: WorkspaceState, pages: Page[], index: number): WorkspaceState {
  if (pages.length === 0) return state;
  const at = Math.max(0, Math.min(state.pages.length, Math.floor(index)));
  const next = state.pages.slice();
  next.splice(at, 0, ...pages);
  return { ...state, pages: next };
}

export function deletePages(state: WorkspaceState, ids: PageId[]): WorkspaceState {
  const drop = new Set(ids);
  const next = state.pages.filter((p) => !drop.has(p.id));
  return next.length === state.pages.length ? state : { ...state, pages: next };
}

/**
 * Move pages (keeping their current relative order) so they sit immediately before
 * `beforeId`, or at the end when `beforeId` is null. If `beforeId` is itself being
 * moved, the anchor becomes the next page after it that is not being moved.
 */
export function movePages(state: WorkspaceState, ids: PageId[], beforeId: PageId | null): WorkspaceState {
  const moving = new Set(ids);
  if (moving.size === 0) return state;
  let anchor = beforeId;
  if (anchor !== null && moving.has(anchor)) {
    const start = pageIndex(state, anchor);
    anchor = null;
    for (let i = start + 1; i < state.pages.length; i++) {
      if (!moving.has(state.pages[i].id)) {
        anchor = state.pages[i].id;
        break;
      }
    }
  }
  const moved = state.pages.filter((p) => moving.has(p.id));
  const rest = state.pages.filter((p) => !moving.has(p.id));
  const at = anchor === null ? rest.length : rest.findIndex((p) => p.id === anchor);
  if (at < 0) throw new Error(`Cannot move pages: anchor page ${anchor} not found`);
  const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  const same = next.every((p, i) => p === state.pages[i]);
  return same ? state : { ...state, pages: next };
}

/** Move pages so the first moved page ends up at position `index` in the final order. */
export function movePagesToIndex(state: WorkspaceState, ids: PageId[], index: number): WorkspaceState {
  const moving = new Set(ids);
  const rest = state.pages.filter((p) => !moving.has(p.id));
  const at = Math.max(0, Math.min(rest.length, index));
  return movePages(state, ids, at >= rest.length ? null : rest[at].id);
}

export function rotatePages(state: WorkspaceState, ids: PageId[], delta: number): WorkspaceState {
  const set = new Set(ids);
  return mapPages(state, (p) => (set.has(p.id) ? { ...p, rotation: normRotation(p.rotation + delta) } : p));
}

/** Deep copy of annotations with fresh ids (duplicated pages get independent annotations). */
export function cloneAnnotations(list: Annotation[]): Annotation[] {
  return list.map((a) => ({ ...structuredClone(a), id: newId('an') }));
}

/**
 * Duplicate pages. Rule: each copy is inserted directly after its original and gets an
 * INDEPENDENT copy of the original's annotations (new ids), so editing one never
 * changes the other. Returns the ids of the new pages in document order.
 */
export function duplicatePages(state: WorkspaceState, ids: PageId[]): { state: WorkspaceState; newIds: PageId[] } {
  const set = new Set(ids);
  const next: Page[] = [];
  const newIds: PageId[] = [];
  for (const p of state.pages) {
    next.push(p);
    if (set.has(p.id)) {
      const copy: Page = { ...p, id: newId('pg'), annotations: cloneAnnotations(p.annotations) };
      next.push(copy);
      newIds.push(copy.id);
    }
  }
  return { state: newIds.length ? { ...state, pages: next } : state, newIds };
}

/**
 * Replace one page with new page(s) at the same position. The replaced page's annotations
 * are discarded with it (they were drawn for different content).
 */
export function replacePage(state: WorkspaceState, pageId: PageId, replacements: Page[]): WorkspaceState {
  const i = pageIndex(state, pageId);
  if (i < 0) throw new Error(`Cannot replace page: ${pageId} not found`);
  const next = state.pages.slice();
  next.splice(i, 1, ...replacements);
  return { ...state, pages: next };
}

/** Keep only the listed pages, in their current order (used by "extract"). */
export function keepPages(state: WorkspaceState, ids: PageId[]): WorkspaceState {
  const set = new Set(ids);
  return { ...state, pages: state.pages.filter((p) => set.has(p.id)) };
}

/* ------------------------------ annotations ------------------------------ */

function mapPages(state: WorkspaceState, fn: (p: Page) => Page): WorkspaceState {
  let changed = false;
  const next = state.pages.map((p) => {
    const q = fn(p);
    if (q !== p) changed = true;
    return q;
  });
  return changed ? { ...state, pages: next } : state;
}

function mapPage(state: WorkspaceState, pageId: PageId, fn: (p: Page) => Page): WorkspaceState {
  if (pageIndex(state, pageId) < 0) throw new Error(`Page ${pageId} not found`);
  return mapPages(state, (p) => (p.id === pageId ? fn(p) : p));
}

export function withId(a: NewAnnotation): Annotation {
  return { ...a, id: newId('an') } as Annotation;
}

export function addAnnotations(state: WorkspaceState, pageId: PageId, anns: Annotation[]): WorkspaceState {
  if (anns.length === 0) return state;
  return mapPage(state, pageId, (p) => ({ ...p, annotations: [...p.annotations, ...anns] }));
}

export interface AnnotationRef {
  pageId: PageId;
  annotationId: AnnotationId;
}

/** Replace annotations by id (the replacements carry the same ids). */
export function updateAnnotations(state: WorkspaceState, pageId: PageId, updated: Annotation[]): WorkspaceState {
  if (updated.length === 0) return state;
  const byId = new Map(updated.map((a) => [a.id, a]));
  return mapPage(state, pageId, (p) => ({
    ...p,
    annotations: p.annotations.map((a) => {
      const u = byId.get(a.id);
      if (u && u.type !== a.type) throw new Error('An annotation cannot change type');
      return u ?? a;
    }),
  }));
}

export function removeAnnotations(state: WorkspaceState, refs: AnnotationRef[]): WorkspaceState {
  if (refs.length === 0) return state;
  const byPage = new Map<PageId, Set<AnnotationId>>();
  for (const r of refs) {
    if (!byPage.has(r.pageId)) byPage.set(r.pageId, new Set());
    byPage.get(r.pageId)!.add(r.annotationId);
  }
  return mapPages(state, (p) => {
    const drop = byPage.get(p.id);
    if (!drop) return p;
    const kept = p.annotations.filter((a) => !drop.has(a.id));
    return kept.length === p.annotations.length ? p : { ...p, annotations: kept };
  });
}

export type ZOrder = 'front' | 'back' | 'forward' | 'backward';

export function reorderAnnotations(state: WorkspaceState, pageId: PageId, ids: AnnotationId[], where: ZOrder): WorkspaceState {
  const set = new Set(ids);
  return mapPage(state, pageId, (p) => {
    const list = p.annotations.slice();
    if (where === 'front' || where === 'back') {
      const moving = list.filter((a) => set.has(a.id));
      const rest = list.filter((a) => !set.has(a.id));
      return { ...p, annotations: where === 'front' ? [...rest, ...moving] : [...moving, ...rest] };
    }
    if (where === 'forward') {
      for (let i = list.length - 2; i >= 0; i--) {
        if (set.has(list[i].id) && !set.has(list[i + 1].id)) [list[i], list[i + 1]] = [list[i + 1], list[i]];
      }
    } else {
      for (let i = 1; i < list.length; i++) {
        if (set.has(list[i].id) && !set.has(list[i - 1].id)) [list[i], list[i - 1]] = [list[i - 1], list[i]];
      }
    }
    return { ...p, annotations: list };
  });
}

/** Copies of annotations with fresh ids, offset so a paste is visibly separate. */
export function duplicateAnnotations(anns: Annotation[], offset: number): Annotation[] {
  return cloneAnnotations(anns).map((a) => translateAnnotation(a, offset, offset));
}

export function clearAnnotations(state: WorkspaceState, pageIds: PageId[]): WorkspaceState {
  const set = new Set(pageIds);
  return mapPages(state, (p) => (set.has(p.id) && p.annotations.length ? { ...p, annotations: [] } : p));
}

/* -------------------------------- sources -------------------------------- */

/**
 * Point a source at new bytes (compression). Page references, order, rotation and
 * annotations are untouched because they reference (source id, page index), and the
 * compressor guarantees page count and geometry are preserved.
 */
export function replaceSourceBlob(
  state: WorkspaceState,
  sourceId: SourceId,
  blobId: BlobId,
  byteLength: number,
  level: CompressionLevel,
): WorkspaceState {
  const src = state.sources[sourceId];
  if (!src) throw new Error(`Source ${sourceId} not found`);
  const originalBytes = src.compression?.originalBytes ?? src.byteLength;
  return {
    ...state,
    sources: { ...state.sources, [sourceId]: { ...src, blobId, byteLength, compression: { level, originalBytes } } },
  };
}

/** Sources referenced by at least one page, in first-use order. */
export function usedSourceIds(state: WorkspaceState): SourceId[] {
  const seen = new Set<SourceId>();
  for (const p of state.pages) seen.add(p.sourceId);
  return [...seen];
}

/** Drop sources no page references any more (history keeps older states intact). */
export function pruneSources(state: WorkspaceState): WorkspaceState {
  const used = new Set(usedSourceIds(state));
  const ids = Object.keys(state.sources);
  if (ids.every((id) => used.has(id))) return state;
  const next: Record<SourceId, SourceDoc> = {};
  for (const id of ids) if (used.has(id)) next[id] = state.sources[id];
  return { ...state, sources: next };
}

/** Every blob the state needs: source PDFs and images placed as annotations. */
export function referencedBlobIds(state: WorkspaceState): Set<BlobId> {
  const out = new Set<BlobId>();
  for (const s of Object.values(state.sources)) out.add(s.blobId);
  for (const p of state.pages) for (const a of p.annotations) if (a.type === 'image') out.add(a.blobId);
  return out;
}

export function totalAnnotations(state: WorkspaceState): number {
  return state.pages.reduce((n, p) => n + p.annotations.length, 0);
}
