import { payloadToError } from '../core/errors';
import { browserCodec } from '../engine/browserCodec';
import { browserNormalizer } from '../engine/browserImages';
import { createLocalEngine, type EngineApi } from '../store/engineApi';
import type { EngineMethod, EngineRequest, EngineResponse } from './protocol';

/**
 * EngineApi backed by a dedicated Web Worker, so parsing, compression and export never
 * block the UI. Falls back to running on the main thread if workers are unavailable.
 */
export function createWorkerEngine(): EngineApi {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'pdf-engine' });
  } catch {
    return createLocalEngine(browserCodec, browserNormalizer);
  }
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (...a: never[]) => void }>();
  worker.onmessage = (ev: MessageEvent<EngineResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'progress') {
      (p.onProgress as ((...a: unknown[]) => void) | undefined)?.(...msg.progress);
      return;
    }
    pending.delete(msg.id);
    if (msg.kind === 'result') p.resolve(msg.result);
    else p.reject(payloadToError(msg.error));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(`The PDF engine stopped unexpectedly: ${ev.message}`));
    pending.clear();
  };

  function call<T>(method: EngineMethod, args: unknown[], onProgress?: (...a: never[]) => void): Promise<T> {
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      const msg: EngineRequest = { id, method, args };
      worker.postMessage(msg);
    });
  }

  return {
    ingestPdf: (bytes, name, password) => call('ingestPdf', [bytes, name, password]),
    imageToPdfs: (bytes, name, size) => call('imageToPdfs', [bytes, name, size]),
    blankPdf: (w, h) => call('blankPdf', [w, h]),
    compress: (bytes, level, onProgress) => call('compress', [bytes, level], onProgress as never),
    exportPdf: (state, blobs, options, onProgress) => call('exportPdf', [state, blobs, options], onProgress as never),
  };
}
