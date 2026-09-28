import { newId } from '../core/ids';
import { referencedBlobIds } from '../core/operations';
import type { BlobId } from '../core/types';
import { WorkspaceError } from '../core/errors';
import type { BlobStore } from '../store/blobStore';
import type { PersistenceSink, WorkspaceRecord } from '../store/controller';

/**
 * IndexedDB persistence. Two stores:
 *   blobs       { id, workspaceId, bytes: Blob, size }   binary data, written once
 *   workspaces  WorkspaceRecord                           state + undo history
 *
 * IndexedDB serializes a record with the structured-clone algorithm, which keeps shared
 * object identity inside one value: the whole undo history is stored with each unchanged
 * page stored once, not once per step.
 */

const DB_NAME = 'pdf-workspace';
const DB_VERSION = 1;

export interface WorkspaceSummary {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  pageCount: number;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(new WorkspaceError('STORAGE_FAILED', 'This browser does not provide local storage (IndexedDB).'));
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('blobs')) {
          const s = db.createObjectStore('blobs', { keyPath: 'id' });
          s.createIndex('workspaceId', 'workspaceId');
        }
        if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('Local storage is blocked by another open tab.'));
    }).catch((err) => {
      dbPromise = null;
      throw new WorkspaceError('STORAGE_FAILED', 'Local storage could not be opened. Work will not be autosaved.', String(err));
    });
  }
  return dbPromise;
}

/** Test hook: forget the cached connection. */
export function resetDbForTests() {
  dbPromise = null;
}

/** Blob store for one workspace, with an in-memory LRU so hot documents are not re-read. */
export class IdbBlobStore implements BlobStore {
  private cache = new Map<BlobId, Uint8Array>();
  private cacheBytes = 0;
  constructor(
    private workspaceId: string,
    private maxCacheBytes = 256 * 1024 * 1024,
  ) {}

  private remember(id: BlobId, bytes: Uint8Array) {
    if (this.cache.has(id)) this.cache.delete(id);
    this.cache.set(id, bytes);
    this.cacheBytes += bytes.byteLength;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= this.maxCacheBytes || k === id) break;
      this.cache.delete(k);
      this.cacheBytes -= v.byteLength;
    }
  }

  async put(bytes: Uint8Array): Promise<BlobId> {
    const id = newId('blob');
    const db = await openDb();
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({ id, workspaceId: this.workspaceId, bytes: new Blob([bytes as BlobPart]), size: bytes.byteLength });
    try {
      await done(tx);
    } catch (err) {
      throw new WorkspaceError(
        'STORAGE_FAILED',
        'The browser refused to store this file (storage may be full).',
        String(err),
      );
    }
    this.remember(id, bytes);
    return id;
  }

  async get(id: BlobId): Promise<Uint8Array> {
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    const db = await openDb();
    const rec = await req(db.transaction('blobs').objectStore('blobs').get(id));
    if (!rec) throw new WorkspaceError('NOT_FOUND', 'Part of this workspace is missing from local storage.', `blob ${id}`);
    const bytes = new Uint8Array(await (rec.bytes as Blob).arrayBuffer());
    this.remember(id, bytes);
    return bytes;
  }

  async has(id: BlobId): Promise<boolean> {
    if (this.cache.has(id)) return true;
    const db = await openDb();
    return (await req(db.transaction('blobs').objectStore('blobs').count(id))) > 0;
  }

  /** Delete this workspace's blobs that nothing in `keep` references. */
  async collectGarbage(keep: Set<BlobId>): Promise<number> {
    const db = await openDb();
    const tx = db.transaction('blobs', 'readwrite');
    const ids = (await req(tx.objectStore('blobs').index('workspaceId').getAllKeys(this.workspaceId))) as string[];
    let n = 0;
    for (const id of ids) {
      if (!keep.has(id)) {
        tx.objectStore('blobs').delete(id);
        this.cache.delete(id);
        n++;
      }
    }
    await done(tx);
    return n;
  }
}

export class IdbWorkspaceStore implements PersistenceSink {
  async save(record: WorkspaceRecord): Promise<void> {
    const db = await openDb();
    const tx = db.transaction('workspaces', 'readwrite');
    tx.objectStore('workspaces').put(record);
    await done(tx);
  }

  async load(id: string): Promise<WorkspaceRecord | null> {
    const db = await openDb();
    return ((await req(db.transaction('workspaces').objectStore('workspaces').get(id))) as WorkspaceRecord | undefined) ?? null;
  }

  async list(): Promise<WorkspaceSummary[]> {
    const db = await openDb();
    const all = (await req(db.transaction('workspaces').objectStore('workspaces').getAll())) as WorkspaceRecord[];
    return all
      .map(({ id, name, updatedAt, createdAt, pageCount }) => ({ id, name, updatedAt, createdAt, pageCount }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(id: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(['workspaces', 'blobs'], 'readwrite');
    tx.objectStore('workspaces').delete(id);
    const blobs = tx.objectStore('blobs');
    const ids = await req(blobs.index('workspaceId').getAllKeys(id));
    for (const b of ids) blobs.delete(b);
    await done(tx);
  }
}

/** Every blob any state in the saved history needs (so undo keeps working after GC). */
export function blobsReferencedByRecord(record: WorkspaceRecord): Set<BlobId> {
  const keep = new Set<BlobId>();
  for (const e of record.history.entries) for (const id of referencedBlobIds(e.state)) keep.add(id);
  return keep;
}

/** How much of the browser's storage quota is in use, when the browser reports it. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && e.quota ? { usage: e.usage ?? 0, quota: e.quota } : null;
  } catch {
    return null;
  }
}
