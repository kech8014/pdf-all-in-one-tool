// The "legacy" build carries polyfills for browsers that lack the newest JavaScript
// features pdf.js uses (e.g. Map.prototype.getOrInsertComputed), so rendering works in
// every current browser, not only the very latest.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { BlobId, Rotation } from '../core/types';
import { WorkspaceError } from '../core/errors';

/**
 * Rendering is a pure VIEW of the canonical sources: pdf.js draws pages straight from the
 * stored source bytes, and nothing rendered is ever written back into the document.
 *
 * - documents are opened lazily and kept in a small LRU (closed when evicted);
 * - thumbnails are rendered through a priority queue with limited concurrency and cached
 *   as ImageBitmaps keyed by (blob, page, rotation), so reordering never re-renders;
 * - full-size renders are cancellable, so fast scrolling/zooming does not pile up work.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;
const MAX_DOCS = 10;

type BlobReader = (id: BlobId) => Promise<Uint8Array>;

let readBlob: BlobReader | null = null;
export function setBlobReader(fn: BlobReader) {
  readBlob = fn;
}

interface OpenDoc {
  promise: Promise<PDFDocumentProxy>;
  destroy: () => void;
}
const docs = new Map<BlobId, OpenDoc>();

export function openDocument(blobId: BlobId): Promise<PDFDocumentProxy> {
  const hit = docs.get(blobId);
  if (hit) {
    docs.delete(blobId);
    docs.set(blobId, hit);
    return hit.promise;
  }
  if (!readBlob) return Promise.reject(new Error('Renderer is not initialised'));
  const reader = readBlob;
  let task: ReturnType<typeof pdfjs.getDocument> | null = null;
  let destroyed = false;
  const promise = (async () => {
    const bytes = await reader(blobId);
    if (destroyed) throw new Error('closed');
    // pdf.js transfers the buffer it is given to its worker, so hand it a copy.
    task = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      wasmUrl: `${ASSETS}wasm/`,
      iccUrl: `${ASSETS}iccs/`,
      verbosity: 0,
    });
    return task.promise;
  })();
  const entry: OpenDoc = {
    promise,
    destroy: () => {
      destroyed = true;
      void (task as { destroy(): Promise<void> } | null)?.destroy();
    },
  };
  promise.catch(() => {
    if (docs.get(blobId) === entry) docs.delete(blobId);
  });
  docs.set(blobId, entry);
  while (docs.size > MAX_DOCS) {
    const [oldest, doc] = docs.entries().next().value as [BlobId, OpenDoc];
    docs.delete(oldest);
    doc.destroy();
  }
  return promise;
}

export async function getPage(blobId: BlobId, index: number): Promise<PDFPageProxy> {
  const doc = await openDocument(blobId);
  return doc.getPage(index + 1);
}

export interface RenderHandle {
  promise: Promise<void>;
  cancel(): void;
}

/**
 * Render a page into `canvas` at `cssScale` CSS pixels per point, rotated by `rotation`
 * (absolute). The canvas backing store uses devicePixelRatio for sharp output, capped so
 * huge zoom levels cannot exhaust memory.
 */
export function renderPage(
  canvas: HTMLCanvasElement,
  blobId: BlobId,
  index: number,
  rotation: Rotation,
  cssScale: number,
  maxPixels = 16_000_000,
): RenderHandle {
  let task: RenderTask | null = null;
  let cancelled = false;
  const promise = (async () => {
    const page = await getPage(blobId, index);
    if (cancelled) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = cssScale * dpr;
    const probe = page.getViewport({ scale, rotation });
    if (probe.width * probe.height > maxPixels) scale *= Math.sqrt(maxPixels / (probe.width * probe.height));
    const viewport = page.getViewport({ scale, rotation });
    const w = Math.max(1, Math.floor(viewport.width));
    const h = Math.max(1, Math.floor(viewport.height));
    // Render off-screen then swap, so the old image stays visible until the new one is ready.
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    task = page.render({ canvas: off, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE });
    await task.promise;
    if (cancelled) return;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(off, 0, 0);
    off.width = off.height = 0;
  })().catch((err) => {
    if (cancelled || (err && (err as { name?: string }).name === 'RenderingCancelledException')) return;
    console.warn('[render] page', index + 1, err);
    throw new WorkspaceError('RENDER_FAILED', `Page ${index + 1} could not be displayed.`, String(err));
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}

/* ------------------------------- thumbnails ------------------------------ */

interface ThumbJob {
  key: string;
  blobId: BlobId;
  index: number;
  rotation: Rotation;
  width: number;
  resolve: (b: ImageBitmap) => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
}

const THUMB_CACHE_MAX = 800;
const thumbCache = new Map<string, ImageBitmap>();
const inflight = new Map<string, Promise<ImageBitmap>>();
const queue: ThumbJob[] = [];
let running = 0;
const CONCURRENCY = 2;

export function thumbKey(blobId: BlobId, index: number, rotation: Rotation, width: number) {
  return `${blobId}:${index}:${rotation}:${width}`;
}

export function cachedThumb(key: string): ImageBitmap | undefined {
  return thumbCache.get(key);
}

/** Request a thumbnail; `cancel` drops it from the queue if it has not started. */
export function requestThumb(blobId: BlobId, index: number, rotation: Rotation, width: number): { promise: Promise<ImageBitmap>; cancel: () => void } {
  const key = thumbKey(blobId, index, rotation, width);
  const cached = thumbCache.get(key);
  if (cached) return { promise: Promise.resolve(cached), cancel: () => undefined };
  const existing = inflight.get(key);
  if (existing) return { promise: existing, cancel: () => undefined };
  let job!: ThumbJob;
  const promise = new Promise<ImageBitmap>((resolve, reject) => {
    job = { key, blobId, index, rotation, width, resolve, reject, cancelled: false };
  });
  inflight.set(key, promise);
  promise.catch(() => undefined).finally(() => inflight.delete(key));
  // Newest requests first: what the user just scrolled to matters most.
  queue.unshift(job);
  pump();
  return {
    promise,
    cancel: () => {
      if (!job.cancelled && queue.includes(job)) {
        job.cancelled = true;
        queue.splice(queue.indexOf(job), 1);
        inflight.delete(key);
        job.reject(new Error('cancelled'));
      }
    },
  };
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    running++;
    void renderThumb(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function renderThumb(job: ThumbJob): Promise<ImageBitmap> {
  try {
    return await renderThumbInner(job);
  } catch (err) {
    console.warn('[thumbnail] page', job.index + 1, err);
    throw err;
  }
}

async function renderThumbInner(job: ThumbJob): Promise<ImageBitmap> {
  const page = await getPage(job.blobId, job.index);
  const base = page.getViewport({ scale: 1, rotation: job.rotation });
  const scale = job.width / base.width;
  const viewport = page.getViewport({ scale, rotation: job.rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvas, viewport }).promise;
  const bmp = await createImageBitmap(canvas);
  canvas.width = canvas.height = 0;
  thumbCache.set(job.key, bmp);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const [k, v] = thumbCache.entries().next().value as [string, ImageBitmap];
    thumbCache.delete(k);
    v.close();
  }
  return bmp;
}
