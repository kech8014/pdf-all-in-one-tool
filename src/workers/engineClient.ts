import { WorkspaceError, payloadToError } from '../core/errors';
import { browserCodec } from '../engine/browserCodec';
import { browserNormalizer } from '../engine/browserImages';
import { createLocalEngine, type EngineApi } from '../store/engineApi';
import type { EngineMethod, EngineRequest, EngineResponse } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (...a: unknown[]) => void };

/**
 * EngineApi backed by a dedicated Web Worker, so parsing, compression and export never
 * block the UI. If the worker dies (e.g. out of memory on a huge file) every pending call
 * fails with a clear error and the next call starts a fresh worker. Falls back to the main
 * thread when workers are unavailable.
 */
export function createWorkerEngine(): EngineApi {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, Pending>();

  function spawn(): Worker | null {
    try {
      const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'pdf-engine' });
      w.onmessage = (ev: MessageEvent<EngineResponse>) => {
        const msg = ev.data;
        const p = pending.get(msg.id);
        if (!p) return;
        if (msg.kind === 'progress') {
          p.onProgress?.(...msg.progress);
          return;
        }
        pending.delete(msg.id);
        if (msg.kind === 'result') p.resolve(msg.result);
        else p.reject(payloadToError(msg.error));
      };
      w.onerror = (ev) => {
        ev.preventDefault?.();
        const err = new WorkspaceError('INTERNAL', 'The PDF engine stopped unexpectedly (the file may be too large for this device). Please try again.', ev.message);
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        w.terminate();
        if (worker === w) worker = null;
      };
      return w;
    } catch {
      return null;
    }
  }

  worker = spawn();
  if (!worker) return createLocalEngine(browserCodec, browserNormalizer);

  function call<T>(method: EngineMethod, args: unknown[], onProgress?: (...a: never[]) => void): Promise<T> {
    if (!worker) worker = spawn();
    if (!worker) return Promise.reject(new WorkspaceError('INTERNAL', 'The PDF engine could not be started.'));
    const id = ++seq;
    const w = worker;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: onProgress as Pending['onProgress'] });
      const msg: EngineRequest = { id, method, args };
      w.postMessage(msg);
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
