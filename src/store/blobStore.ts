import { newId } from '../core/ids';
import type { BlobId } from '../core/types';

/**
 * Content store for binary data (source PDFs, placed images). The workspace state only
 * holds blob ids, which keeps every state snapshot tiny and undo cheap.
 */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<BlobId>;
  get(id: BlobId): Promise<Uint8Array>;
  has(id: BlobId): Promise<boolean>;
  /** Delete blobs owned by this store that are not in `keep`. */
  collectGarbage?(keep: Set<BlobId>): Promise<number>;
}

export class MemoryBlobStore implements BlobStore {
  private map = new Map<BlobId, Uint8Array>();
  async put(bytes: Uint8Array): Promise<BlobId> {
    const id = newId('blob');
    this.map.set(id, bytes);
    return id;
  }
  async get(id: BlobId): Promise<Uint8Array> {
    const b = this.map.get(id);
    if (!b) throw new Error(`Blob ${id} is missing`);
    return b;
  }
  async has(id: BlobId): Promise<boolean> {
    return this.map.has(id);
  }
  async collectGarbage(keep: Set<BlobId>): Promise<number> {
    let n = 0;
    for (const id of [...this.map.keys()]) {
      if (!keep.has(id)) {
        this.map.delete(id);
        n++;
      }
    }
    return n;
  }
  get size() {
    return this.map.size;
  }
}
