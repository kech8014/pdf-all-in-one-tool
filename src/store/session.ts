import { createHistory, commit, present } from '../core/history';
import { newId } from '../core/ids';
import * as Ops from '../core/operations';
import type { Annotation, BlobId, Page, PageId, SourceDoc, WorkspaceState } from '../core/types';
import { validateState } from '../core/validation';
import { IdbBlobStore, IdbWorkspaceStore, blobsReferencedByRecord, openDb, type WorkspaceSummary } from '../persistence/idb';
import { MemoryBlobStore } from './blobStore';
import { WorkspaceController, type WorkspaceRecord } from './controller';
import type { EngineApi } from './engineApi';

const LAST_KEY = 'pdf-workspace:last';

function remember(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* private mode: nothing to do */
  }
}
function lastId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/**
 * Owns the list of saved workspaces and which one is open. Each workspace has its own
 * blob namespace, so deleting one can never remove data another still uses.
 */
export class Session {
  readonly store = new IdbWorkspaceStore();
  persistent = true;

  constructor(private engine: EngineApi) {}

  async init(): Promise<void> {
    try {
      await openDb();
    } catch {
      this.persistent = false;
    }
  }

  private make(record: WorkspaceRecord | null): WorkspaceController {
    if (!this.persistent) {
      return new WorkspaceController(this.engine, new MemoryBlobStore(), null, record ? { history: record.history } : undefined);
    }
    const history = record?.history ?? createHistory(Ops.createWorkspace(), 'Created workspace');
    const id = present(history).id;
    const blobs = new IdbBlobStore(id);
    const ctl = new WorkspaceController(this.engine, blobs, this.store, { history, exportedIndex: record?.exportedIndex ?? null });
    remember(id);
    if (record) {
      // Drop blobs that no state in the saved history needs (e.g. files added then undone).
      void blobs.collectGarbage(blobsReferencedByRecord(record)).catch(() => undefined);
    } else {
      void ctl.flush();
    }
    return ctl;
  }

  /** Reopen the last workspace (surviving refreshes), else start a new one. */
  async openInitial(): Promise<WorkspaceController> {
    if (this.persistent) {
      const id = lastId();
      const rec = id ? await this.safeLoad(id) : null;
      if (rec) return this.make(rec);
    }
    return this.make(null);
  }

  private async safeLoad(id: string): Promise<WorkspaceRecord | null> {
    try {
      const rec = await this.store.load(id);
      if (!rec || !rec.history?.entries?.length) return null;
      // Never open a corrupted record; fall back to its last valid state.
      let idx = rec.history.index;
      while (idx >= 0 && validateState(rec.history.entries[idx].state).length) idx--;
      if (idx < 0) return null;
      return { ...rec, history: { ...rec.history, index: idx } };
    } catch {
      return null;
    }
  }

  async open(id: string): Promise<WorkspaceController | null> {
    const rec = await this.safeLoad(id);
    return rec ? this.make(rec) : null;
  }

  create(): WorkspaceController {
    return this.make(null);
  }

  async list(): Promise<WorkspaceSummary[]> {
    if (!this.persistent) return [];
    try {
      return await this.store.list();
    } catch {
      return [];
    }
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(id);
  }

  /**
   * Copy (or move) pages into another saved workspace. Binary data is copied into the
   * target's namespace and every page/annotation gets a fresh id, so the two
   * workspaces stay fully independent afterwards.
   */
  async transferPages(from: WorkspaceController, pageIds: PageId[], targetId: string | null, move: boolean): Promise<string> {
    const state = from.state;
    const wanted = new Set(pageIds);
    const pages = state.pages.filter((p) => wanted.has(p.id));
    if (!pages.length) throw new Error('No pages selected');

    const rec = targetId ? await this.safeLoad(targetId) : null;
    const baseHistory = rec?.history ?? createHistory(Ops.createWorkspace(`Pages from ${state.name}`), 'Created workspace');
    const target: WorkspaceState = present(baseHistory);
    const targetBlobs = new IdbBlobStore(target.id);

    const blobMap = new Map<BlobId, BlobId>();
    const copyBlob = async (id: BlobId) => {
      if (!blobMap.has(id)) blobMap.set(id, await targetBlobs.put(await from.blobs.get(id)));
      return blobMap.get(id)!;
    };
    const sourceMap = new Map<string, SourceDoc>();
    const newPages: Page[] = [];
    for (const p of pages) {
      let src = sourceMap.get(p.sourceId);
      if (!src) {
        const orig = state.sources[p.sourceId];
        src = { ...orig, id: newId('src'), blobId: await copyBlob(orig.blobId) };
        sourceMap.set(p.sourceId, src);
      }
      const annotations: Annotation[] = [];
      for (const a of Ops.cloneAnnotations(p.annotations)) {
        annotations.push(a.type === 'image' ? { ...a, blobId: await copyBlob(a.blobId) } : a);
      }
      newPages.push({ ...p, id: newId('pg'), sourceId: src.id, annotations });
    }
    let next = Ops.addSources(target, [...sourceMap.values()]);
    next = Ops.insertPages(next, newPages, next.pages.length);
    const history = commit(baseHistory, next, `Received ${newPages.length} page${newPages.length === 1 ? '' : 's'} from "${state.name}"`);
    await this.store.save({
      id: next.id,
      name: next.name,
      createdAt: next.createdAt,
      updatedAt: Date.now(),
      pageCount: next.pages.length,
      history,
      exportedIndex: null,
    });
    if (move) {
      const n = pages.length;
      from.apply(Ops.deletePages(from.state, pageIds), `Moved ${n} page${n === 1 ? '' : 's'} to "${next.name}"`, { selection: [] });
    }
    return next.id;
  }
}
