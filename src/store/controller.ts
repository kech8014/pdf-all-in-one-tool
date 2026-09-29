import { WorkspaceError, toWorkspaceError } from '../core/errors';
import * as H from '../core/history';
import { newId } from '../core/ids';
import * as Ops from '../core/operations';
import type { AnnotationRef, ZOrder } from '../core/operations';
import type { Annotation, AnnotationId, BlobId, CompressionLevel, Page, PageId, SourceDoc, SourceId, WorkspaceState } from '../core/types';
import { validateState } from '../core/validation';
import { sniffMime } from '../engine/imageInfo';
import type { ImagePageSize } from '../engine/ingest';
import type { BlobStore } from './blobStore';
import type { EngineApi } from './engineApi';

/**
 * WorkspaceController: the single owner of the live document.
 *
 * Every user action — merge, insert, delete, reorder, rotate, compress, annotate —
 * goes through `apply()`, which validates the new state, records it in ONE undo
 * history and schedules autosave. The UI renders from `view` and never mutates state.
 * The controller has no React or DOM dependency, so the test-suite drives exactly the
 * same code paths as the app.
 */

export interface Task {
  label: string;
  /** 0..1, or null when indeterminate. */
  progress: number | null;
}

export type NoticeKind = 'info' | 'success' | 'error';
export interface Notice {
  id: string;
  kind: NoticeKind;
  message: string;
  detail?: string;
  /** Optional one-click follow-up shown on the toast (e.g. "Undo"). */
  action?: { label: string; run: () => void };
}

export type SaveStatus = 'saved' | 'saving' | 'pending' | 'error' | 'off';

export interface WorkspaceView {
  history: H.History;
  state: WorkspaceState;
  selection: PageId[];
  activePageId: PageId | null;
  task: Task | null;
  notices: Notice[];
  saveStatus: SaveStatus;
  /** State at the last full export (reference equality tells whether anything changed since). */
  exportedState: WorkspaceState | null;
  clipboard: { pageId: PageId; annotations: Annotation[] } | null;
}

/** A file read and validated, stored as source(s), waiting to be placed. */
export interface PreparedFile {
  key: string;
  name: string;
  kind: 'pdf' | 'image';
  sources: SourceDoc[];
  /** Flattened page list across the file's sources (TIFFs can have several). */
  pages: { sourceId: SourceId; index: number }[];
}

export interface PrepareFailure {
  name: string;
  error: WorkspaceError;
  needsPassword: boolean;
  bytes: Uint8Array;
}

export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

export interface PersistenceSink {
  save(record: WorkspaceRecord): Promise<void>;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageCount: number;
  history: H.History;
  exportedIndex: number | null;
}

export interface CompressReport {
  before: number;
  after: number;
  sourcesChanged: number;
  imagesRecompressed: number;
}

const COALESCE_MS = 1500;
const SAVE_DEBOUNCE_MS = 400;

export class WorkspaceController {
  private listeners = new Set<() => void>();
  private _view: WorkspaceView;
  private lastCoalesce: { key: string; at: number; index: number } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private disposed = false;

  constructor(
    readonly engine: EngineApi,
    readonly blobs: BlobStore,
    private persistence: PersistenceSink | null = null,
    initial?: { history: H.History; exportedIndex?: number | null },
  ) {
    const history = initial?.history ?? H.createHistory(Ops.createWorkspace(), 'Created workspace');
    const state = H.present(history);
    this._view = {
      history,
      state,
      selection: [],
      activePageId: state.pages[0]?.id ?? null,
      task: null,
      notices: [],
      saveStatus: persistence ? 'saved' : 'off',
      exportedState: initial?.exportedIndex != null ? (history.entries[initial.exportedIndex]?.state ?? null) : null,
      clipboard: null,
    };
  }

  /* ------------------------------ subscription ----------------------------- */

  get view(): WorkspaceView {
    return this._view;
  }
  get state(): WorkspaceState {
    return this._view.state;
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): WorkspaceView => this._view;

  private set(patch: Partial<WorkspaceView>) {
    this._view = { ...this._view, ...patch };
    for (const l of this.listeners) l();
  }

  dispose() {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.listeners.clear();
  }

  /* -------------------------------- notices -------------------------------- */

  notify(kind: NoticeKind, message: string, detail?: string, action?: Notice['action']) {
    const notice: Notice = { id: newId('an'), kind, message, detail, action };
    // The same message again replaces the old one instead of stacking up.
    const others = this._view.notices.filter((n) => n.message !== message);
    this.set({ notices: [...others.slice(-4), notice] });
    return notice.id;
  }
  dismiss(id: string) {
    this.set({ notices: this._view.notices.filter((n) => n.id !== id) });
  }
  private fail(err: unknown, fallback: WorkspaceError['code'], context: string): WorkspaceError {
    const e = toWorkspaceError(err, fallback, context);
    this.notify('error', e.message, e.detail);
    return e;
  }

  /* ------------------------------ core commit ------------------------------ */

  /**
   * The only way state changes. Rejects (and reports) any state that breaks an invariant,
   * so a bug can never corrupt the saved workspace.
   */
  apply(
    next: WorkspaceState,
    label: string,
    opts: { coalesce?: string; selection?: PageId[]; activePageId?: PageId | null } = {},
  ): boolean {
    next = Ops.pruneSources(next);
    const problems = validateState(next);
    if (problems.length) {
      this.fail(new WorkspaceError('STATE_INVALID', `"${label}" could not be applied.`, problems.slice(0, 5).join('; ')), 'STATE_INVALID', label);
      return false;
    }
    const now = Date.now();
    let history: H.History;
    const c = this.lastCoalesce;
    if (opts.coalesce && c && c.key === opts.coalesce && now - c.at < COALESCE_MS && c.index === this._view.history.index) {
      history = H.amend(this._view.history, next, label);
    } else {
      history = H.commit(this._view.history, next, label);
    }
    this.lastCoalesce = opts.coalesce ? { key: opts.coalesce, at: now, index: history.index } : null;
    this.setHistory(history, opts.selection, opts.activePageId);
    return true;
  }

  private setHistory(history: H.History, selection?: PageId[], active?: PageId | null) {
    const state = H.present(history);
    const ids = new Set(state.pages.map((p) => p.id));
    let sel = (selection ?? this._view.selection).filter((id) => ids.has(id));
    let activeId = active !== undefined ? active : this._view.activePageId;
    if (!activeId || !ids.has(activeId)) {
      // Keep the cursor near where it was: the page now at the old active position.
      const oldIdx = this._view.activePageId ? this._view.state.pages.findIndex((p) => p.id === this._view.activePageId) : 0;
      activeId = state.pages[Math.min(Math.max(0, oldIdx), state.pages.length - 1)]?.id ?? null;
    }
    if (sel.length === 0 && selection === undefined) sel = [];
    this.set({ history, state, selection: sel, activePageId: activeId });
    this.scheduleSave();
  }

  /* ------------------------------ selection -------------------------------- */

  setActive(id: PageId | null) {
    if (id === this._view.activePageId) return;
    this.set({ activePageId: id });
  }
  select(ids: PageId[], active?: PageId) {
    this.set({ selection: [...new Set(ids)], activePageId: active ?? this._view.activePageId });
  }
  selectAll() {
    this.select(this.state.pages.map((p) => p.id));
  }
  clearSelection() {
    if (this._view.selection.length) this.set({ selection: [] });
  }
  /** Pages an organizer command acts on: the selection, else the active page. */
  targetPages(): PageId[] {
    if (this._view.selection.length) return this.state.pages.filter((p) => this._view.selection.includes(p.id)).map((p) => p.id);
    return this._view.activePageId ? [this._view.activePageId] : [];
  }
  pageNumber(id: PageId): number {
    return Ops.pageIndex(this.state, id) + 1;
  }

  /* -------------------------------- history -------------------------------- */

  undo() {
    if (!H.canUndo(this._view.history)) return;
    this.lastCoalesce = null;
    this.setHistory(H.undo(this._view.history));
  }
  redo() {
    if (!H.canRedo(this._view.history)) return;
    this.lastCoalesce = null;
    this.setHistory(H.redo(this._view.history));
  }
  jumpTo(index: number) {
    this.lastCoalesce = null;
    this.setHistory(H.jumpTo(this._view.history, index));
  }

  /* --------------------------------- tasks --------------------------------- */

  private async runTask<T>(label: string, fn: (progress: (p: number | null) => void) => Promise<T>): Promise<T> {
    this.set({ task: { label, progress: null } });
    try {
      return await fn((p) => this.set({ task: { label, progress: p } }));
    } finally {
      this.set({ task: null });
    }
  }

  /* --------------------------- importing documents -------------------------- */

  /**
   * Read and validate files, store them as sources, and return them WITHOUT changing the
   * document. The insert dialog shows their pages; `insertPrepared` places them.
   */
  async prepareFiles(
    files: InputFile[],
    opts: { imageSize?: ImagePageSize; passwords?: Record<string, string> } = {},
  ): Promise<{ prepared: PreparedFile[]; failures: PrepareFailure[] }> {
    const prepared: PreparedFile[] = [];
    const failures: PrepareFailure[] = [];
    await this.runTask(files.length === 1 ? `Reading ${files[0].name}` : `Reading ${files.length} files`, async (progress) => {
      for (const [i, f] of files.entries()) {
        progress(i / files.length);
        try {
          prepared.push(await this.prepareOne(f, opts.imageSize ?? { mode: 'image' }, opts.passwords?.[f.name]));
        } catch (err) {
          const e = toWorkspaceError(err, 'PDF_PARSE', `"${f.name}" could not be added.`);
          failures.push({ name: f.name, error: e, needsPassword: e.code === 'PDF_ENCRYPTED', bytes: f.bytes });
        }
      }
    });
    return { prepared, failures };
  }

  private async prepareOne(file: InputFile, imageSize: ImagePageSize, password?: string): Promise<PreparedFile> {
    const mime = sniffMime(file.bytes);
    if (mime === 'application/pdf') {
      const ing = await this.engine.ingestPdf(file.bytes, file.name, password);
      const source = await this.storeSource(file.name, 'pdf', ing.bytes, ing.pages);
      return { key: newId('src'), name: file.name, kind: 'pdf', sources: [source], pages: ing.pages.map((_, index) => ({ sourceId: source.id, index })) };
    }
    if (mime && mime.startsWith('image/')) {
      const pdfs = await this.engine.imageToPdfs(file.bytes, file.name, imageSize);
      const sources: SourceDoc[] = [];
      for (const [i, bytes] of pdfs.entries()) {
        const ing = await this.engine.ingestPdf(bytes, file.name);
        sources.push(await this.storeSource(pdfs.length > 1 ? `${file.name} (${i + 1})` : file.name, 'image', ing.bytes, ing.pages));
      }
      return { key: newId('src'), name: file.name, kind: 'image', sources, pages: sources.map((s) => ({ sourceId: s.id, index: 0 })) };
    }
    throw new WorkspaceError(
      'UNSUPPORTED_FILE',
      `"${file.name}" is not a PDF or a supported image.`,
      'Supported: PDF, JPG, PNG, WebP, GIF, BMP, TIFF, AVIF (where the browser supports it).',
    );
  }

  private async storeSource(name: string, origin: SourceDoc['origin'], bytes: Uint8Array, pages: SourceDoc['pages']): Promise<SourceDoc> {
    const blobId = await this.blobs.put(bytes);
    return { id: newId('src'), name, origin, blobId, byteLength: bytes.byteLength, pageCount: pages.length, pages };
  }

  /**
   * Place prepared pages at `index` (0 = before the first page, pageCount = at the end).
   * `pick` maps a prepared file key to the page positions to use (default: all).
   */
  insertPrepared(files: PreparedFile[], index: number, pick?: Record<string, number[]>, label?: string): PageId[] {
    let next = Ops.addSources(this.state, files.flatMap((f) => f.sources));
    const pages: Page[] = [];
    for (const f of files) {
      const chosen = pick?.[f.key] ?? f.pages.map((_, i) => i);
      for (const i of chosen) {
        const ref = f.pages[i];
        if (!ref) continue;
        pages.push(...Ops.pagesFromSource(next.sources[ref.sourceId], [ref.index]));
      }
    }
    if (pages.length === 0) return [];
    const at = Math.max(0, Math.min(this.state.pages.length, index));
    next = Ops.insertPages(next, pages, at);
    const names = files.map((f) => f.name);
    const what = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
    const where = this.state.pages.length === 0 ? '' : at === 0 ? ' at the start' : at >= this.state.pages.length ? ' at the end' : ` after page ${at}`;
    const text = label ?? `Added ${what} from ${names.length === 1 ? names[0] : `${names.length} files`}${where}`;
    const ids = pages.map((p) => p.id);
    // Highlight what was inserted into an existing document; a first import selects nothing
    // (so a stray Delete cannot remove the whole document).
    const wasEmpty = this.state.pages.length === 0;
    // A new, still-untitled workspace takes the name of the first file added to it.
    if (wasEmpty && next.name === 'Untitled workspace' && files[0] && files[0].name !== 'Blank page') {
      const base = files[0].name.replace(/\.[a-z0-9]{2,5}$/i, '').trim();
      if (base) next = { ...next, name: files.length > 1 ? `${base} + ${files.length - 1} more` : base };
    }
    this.apply(next, text, { selection: wasEmpty ? [] : ids, activePageId: ids[0] });
    return ids;
  }

  /** Convenience: prepare + insert everything (drag-and-drop, "Add files"). */
  async addFiles(files: InputFile[], index = this.state.pages.length, opts: { imageSize?: ImagePageSize } = {}) {
    const { prepared, failures } = await this.prepareFiles(files, opts);
    for (const f of failures) if (!f.needsPassword) this.notify('error', f.error.message, f.error.detail);
    const ids = prepared.length ? this.insertPrepared(prepared, index) : [];
    if (ids.length) this.notify('success', `Added ${ids.length} page${ids.length === 1 ? '' : 's'}.`);
    return { ids, failures };
  }

  async insertBlankPage(index: number, size?: { width: number; height: number }) {
    const ref = this.state.pages[Math.max(0, index - 1)];
    const s =
      size ?? (ref ? { width: this.state.sources[ref.sourceId].pages[ref.sourcePageIndex].width, height: this.state.sources[ref.sourceId].pages[ref.sourcePageIndex].height } : { width: 612, height: 792 });
    try {
      const bytes = await this.engine.blankPdf(s.width, s.height);
      const source = await this.storeSource('Blank page', 'blank', bytes, [{ width: s.width, height: s.height, rotation: 0 }]);
      const file: PreparedFile = { key: source.id, name: 'Blank page', kind: 'pdf', sources: [source], pages: [{ sourceId: source.id, index: 0 }] };
      return this.insertPrepared([file], index, undefined, `Inserted a blank page at position ${index + 1}`);
    } catch (err) {
      this.fail(err, 'INTERNAL', 'The blank page could not be created.');
      return [];
    }
  }

  /* ---------------------------- page operations ---------------------------- */

  deletePages(ids: PageId[]) {
    if (ids.length === 0) return;
    if (ids.length >= this.state.pages.length) {
      // Deleting everything is allowed, but say what happened.
      this.apply(Ops.deletePages(this.state, ids), `Deleted all ${ids.length} pages`, { selection: [] });
      return;
    }
    const firstIdx = Math.min(...ids.map((id) => Ops.pageIndex(this.state, id)));
    const next = Ops.deletePages(this.state, ids);
    const active = next.pages[Math.min(firstIdx, next.pages.length - 1)]?.id ?? null;
    const label = ids.length === 1 ? `Deleted page ${this.pageNumber(ids[0])}` : `Deleted ${ids.length} pages`;
    this.apply(next, label, { selection: [], activePageId: active });
  }

  movePages(ids: PageId[], beforeId: PageId | null) {
    const next = Ops.movePages(this.state, ids, beforeId);
    if (next === this.state) return;
    const label = ids.length === 1 ? `Moved page ${this.pageNumber(ids[0])} to position ${Ops.pageIndex(next, ids[0]) + 1}` : `Moved ${ids.length} pages`;
    this.apply(next, label, { selection: ids });
  }

  movePagesToIndex(ids: PageId[], index: number) {
    const next = Ops.movePagesToIndex(this.state, ids, index);
    if (next === this.state) return;
    const label = ids.length === 1 ? `Moved page ${this.pageNumber(ids[0])} to position ${Ops.pageIndex(next, ids[0]) + 1}` : `Moved ${ids.length} pages`;
    this.apply(next, label, { selection: ids });
  }

  /** Put whole files in a new order (the "Organize PDFs" view). */
  reorderDocuments(order: SourceId[]) {
    const next = Ops.reorderDocuments(this.state, order);
    if (next === this.state) return;
    this.apply(next, 'Reordered files');
  }

  /** Remove every page that came from one file. */
  removeDocument(sourceId: SourceId) {
    const ids = this.state.pages.filter((p) => p.sourceId === sourceId).map((p) => p.id);
    if (!ids.length) return;
    const name = this.state.sources[sourceId]?.name ?? 'file';
    this.apply(Ops.deletePages(this.state, ids), `Removed ${name}`, { selection: [] });
  }

  rotatePages(ids: PageId[], delta: 90 | -90 | 180) {
    if (!ids.length) return;
    const dir = delta === 90 ? 'right' : delta === -90 ? 'left' : '180°';
    const label = ids.length === 1 ? `Rotated page ${this.pageNumber(ids[0])} ${dir}` : `Rotated ${ids.length} pages ${dir}`;
    this.apply(Ops.rotatePages(this.state, ids, delta), label);
  }

  duplicatePages(ids: PageId[]) {
    if (!ids.length) return [];
    const { state, newIds } = Ops.duplicatePages(this.state, ids);
    this.apply(state, ids.length === 1 ? `Duplicated page ${this.pageNumber(ids[0])}` : `Duplicated ${ids.length} pages`, { selection: newIds, activePageId: newIds[0] });
    return newIds;
  }

  /** Replace one page with page `pageIndex` of a prepared file. Its annotations are removed with it. */
  replacePage(pageId: PageId, file: PreparedFile, pageIndex = 0) {
    const ref = file.pages[pageIndex];
    if (!ref) return;
    let next = Ops.addSources(this.state, file.sources);
    const [page] = Ops.pagesFromSource(next.sources[ref.sourceId], [ref.index]);
    const n = this.pageNumber(pageId);
    next = Ops.replacePage(next, pageId, [page]);
    this.apply(next, `Replaced page ${n} with ${file.name}`, { selection: [page.id], activePageId: page.id });
  }

  /* ------------------------------ annotations ------------------------------ */

  addAnnotation(pageId: PageId, ann: Annotation, label = 'Added annotation') {
    this.apply(Ops.addAnnotations(this.state, pageId, [ann]), `${label} on page ${this.pageNumber(pageId)}`);
  }

  updateAnnotations(pageId: PageId, anns: Annotation[], label = 'Edited annotation', coalesce?: string) {
    this.apply(Ops.updateAnnotations(this.state, pageId, anns), label, { coalesce });
  }

  removeAnnotations(refs: AnnotationRef[], label?: string) {
    if (!refs.length) return;
    this.apply(Ops.removeAnnotations(this.state, refs), label ?? (refs.length === 1 ? 'Deleted annotation' : `Deleted ${refs.length} annotations`));
  }

  /** Swap some annotations of a page for others in ONE undo step (e.g. handwriting -> text). */
  replaceAnnotations(pageId: PageId, removeIds: AnnotationId[], add: Annotation[], label: string) {
    const removed = Ops.removeAnnotations(this.state, removeIds.map((annotationId) => ({ pageId, annotationId })));
    this.apply(Ops.addAnnotations(removed, pageId, add), label);
  }

  reorderAnnotations(pageId: PageId, ids: AnnotationId[], where: ZOrder) {
    const label = { front: 'Brought to front', back: 'Sent to back', forward: 'Brought forward', backward: 'Sent backward' }[where];
    this.apply(Ops.reorderAnnotations(this.state, pageId, ids, where), label);
  }

  clearAnnotations(pageIds: PageId[]) {
    const n = pageIds.reduce((s, id) => s + (Ops.getPage(this.state, id)?.annotations.length ?? 0), 0);
    if (!n) return;
    this.apply(Ops.clearAnnotations(this.state, pageIds), `Removed ${n} annotation${n === 1 ? '' : 's'}`);
  }

  copyAnnotations(pageId: PageId, ids: AnnotationId[]) {
    const page = Ops.getPage(this.state, pageId);
    if (!page) return;
    const annotations = page.annotations.filter((a) => ids.includes(a.id));
    if (annotations.length) this.set({ clipboard: { pageId, annotations: structuredClone(annotations) } });
  }

  /** Paste onto `pageId`. On the same page the copy is offset so it is visibly separate. */
  pasteAnnotations(pageId: PageId): AnnotationId[] {
    const clip = this._view.clipboard;
    if (!clip) return [];
    const copies = Ops.duplicateAnnotations(clip.annotations, clip.pageId === pageId ? 12 : 0);
    this.apply(Ops.addAnnotations(this.state, pageId, copies), `Pasted ${copies.length === 1 ? 'annotation' : `${copies.length} annotations`} on page ${this.pageNumber(pageId)}`);
    // The next paste on the same page steps further away.
    this.set({ clipboard: { pageId, annotations: copies.map((a) => structuredClone(a)) } });
    return copies.map((a) => a.id);
  }

  duplicateAnnotations(pageId: PageId, ids: AnnotationId[]): AnnotationId[] {
    const page = Ops.getPage(this.state, pageId);
    if (!page) return [];
    const copies = Ops.duplicateAnnotations(page.annotations.filter((a) => ids.includes(a.id)), 12);
    this.apply(Ops.addAnnotations(this.state, pageId, copies), copies.length === 1 ? 'Duplicated annotation' : `Duplicated ${copies.length} annotations`);
    return copies.map((a) => a.id);
  }

  /** Store an image for use as an annotation (signatures, stamps). */
  async storeImage(bytes: Uint8Array): Promise<BlobId> {
    return this.blobs.put(bytes);
  }

  /* ------------------------------ workspace -------------------------------- */

  rename(name: string) {
    const next = Ops.renameWorkspace(this.state, name);
    if (next !== this.state) this.apply(next, `Renamed to "${next.name}"`, { coalesce: 'rename' });
  }

  /* ------------------------------ compression ------------------------------ */

  /**
   * Compress every source the document uses and swap each for its compressed copy in ONE
   * undoable step. Pages, order, rotation and annotations are untouched.
   */
  async compress(level: CompressionLevel): Promise<CompressReport | null> {
    const ids = Ops.usedSourceIds(this.state);
    if (!ids.length) return null;
    const startState = this.state;
    const report: CompressReport = { before: 0, after: 0, sourcesChanged: 0, imagesRecompressed: 0 };
    const results: { id: SourceId; blobId: BlobId; bytes: number }[] = [];
    try {
      await this.runTask('Compressing', async (progress) => {
        for (const [i, id] of ids.entries()) {
          const src = startState.sources[id];
          const bytes = await this.blobs.get(src.blobId);
          const r = await this.engine.compress(bytes, level, (d, t) => progress((i + (t ? d / t : 0)) / ids.length));
          report.before += r.before;
          report.after += r.after;
          if (r.changed) {
            results.push({ id, blobId: await this.blobs.put(r.bytes), bytes: r.bytes.byteLength });
            report.sourcesChanged++;
            report.imagesRecompressed += r.imagesRecompressed;
          }
        }
      });
    } catch (err) {
      this.fail(err, 'COMPRESS_FAILED', 'Compression failed. The document was not changed.');
      return null;
    }
    // Apply onto the CURRENT state: if the user kept editing while we worked, blob swaps are
    // independent of page edits, so this is safe for every source that still exists.
    let next = this.state;
    for (const r of results) if (next.sources[r.id]) next = Ops.replaceSourceBlob(next, r.id, r.blobId, r.bytes, level);
    const label = `Compressed (${level}): ${formatBytes(report.before)} → ${formatBytes(report.after)}`;
    if (results.length) {
      this.apply(next, label);
      this.notify('success', `${label}. You can keep editing.`);
    } else {
      this.notify('info', 'This document is already compact; compression would not make it smaller.');
    }
    return report;
  }

  /* -------------------------------- export --------------------------------- */

  async exportPdf(opts: { pageIds?: PageId[]; title?: string } = {}): Promise<Uint8Array | null> {
    const state = this.state;
    if (!state.pages.length) {
      this.notify('error', 'There are no pages to export.');
      return null;
    }
    try {
      const blobs: Record<BlobId, Uint8Array> = {};
      const subset = opts.pageIds ? Ops.keepPages(state, opts.pageIds) : state;
      for (const id of Ops.referencedBlobIds(Ops.pruneSources(subset))) blobs[id] = await this.blobs.get(id);
      const bytes = await this.runTask(opts.pageIds ? 'Extracting pages' : 'Exporting PDF', (progress) =>
        this.engine.exportPdf(state, blobs, { pageIds: opts.pageIds, title: opts.title }, (d, t) => progress(t ? d / t : null)),
      );
      if (!opts.pageIds) {
        this.set({ exportedState: state });
        this.scheduleSave();
      }
      return bytes;
    } catch (err) {
      this.fail(err, 'EXPORT_FAILED', 'The PDF could not be exported.');
      return null;
    }
  }

  get hasUnexportedChanges(): boolean {
    return this._view.exportedState !== this._view.state && this._view.state.pages.length > 0;
  }

  /* ------------------------------ persistence ------------------------------ */

  record(): WorkspaceRecord {
    const { history, state, exportedState } = this._view;
    const exportedIndex = exportedState ? history.entries.findIndex((e) => e.state === exportedState) : -1;
    return {
      id: state.id,
      name: state.name,
      createdAt: state.createdAt,
      updatedAt: Date.now(),
      pageCount: state.pages.length,
      history,
      exportedIndex: exportedIndex >= 0 ? exportedIndex : null,
    };
  }

  private scheduleSave() {
    if (!this.persistence || this.disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this._view.saveStatus !== 'pending') this.set({ saveStatus: 'pending' });
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
  }

  /** Save now (also called before the page unloads). */
  async flush(): Promise<void> {
    if (!this.persistence) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) await this.saving;
    this.set({ saveStatus: 'saving' });
    this.saving = this.persistence
      .save(this.record())
      .then(() => {
        if (!this.disposed && this._view.saveStatus === 'saving') this.set({ saveStatus: 'saved' });
      })
      .catch((err) => {
        this.set({ saveStatus: 'error' });
        this.fail(err, 'STORAGE_FAILED', 'Autosave failed. Your changes are still open here; export to keep a copy.');
      })
      .finally(() => {
        this.saving = null;
      });
    await this.saving;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
