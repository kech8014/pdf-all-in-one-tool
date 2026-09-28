/// <reference lib="webworker" />
import { errorToPayload } from '../core/errors';
import { browserCodec } from '../engine/browserCodec';
import { browserNormalizer } from '../engine/browserImages';
import { createLocalEngine } from '../store/engineApi';
import type { EngineRequest, EngineResponse } from './protocol';

const engine = createLocalEngine(browserCodec, browserNormalizer);
const scope = self as unknown as DedicatedWorkerGlobalScope;

function transferables(v: unknown): Transferable[] {
  if (v instanceof Uint8Array) return [v.buffer as ArrayBuffer];
  if (Array.isArray(v)) return v.flatMap(transferables);
  if (v && typeof v === 'object' && 'bytes' in v && (v as { bytes: unknown }).bytes instanceof Uint8Array) {
    return [((v as { bytes: Uint8Array }).bytes.buffer as ArrayBuffer)];
  }
  return [];
}

scope.onmessage = async (ev: MessageEvent<EngineRequest>) => {
  const { id, method, args } = ev.data;
  const post = (msg: EngineResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
  const progress = (...p: unknown[]) => post({ id, kind: 'progress', progress: p });
  try {
    let result: unknown;
    switch (method) {
      case 'ingestPdf':
        result = await engine.ingestPdf(args[0] as Uint8Array, args[1] as string, args[2] as string | undefined);
        break;
      case 'imageToPdfs':
        result = await engine.imageToPdfs(args[0] as Uint8Array, args[1] as string, args[2] as never);
        break;
      case 'blankPdf':
        result = await engine.blankPdf(args[0] as number, args[1] as number);
        break;
      case 'compress':
        result = await engine.compress(args[0] as Uint8Array, args[1] as never, progress);
        break;
      case 'exportPdf':
        result = await engine.exportPdf(args[0] as never, args[1] as never, args[2] as never, progress);
        break;
    }
    post({ id, kind: 'result', result }, transferables(result));
  } catch (err) {
    post({ id, kind: 'error', error: errorToPayload(err) });
  }
};
