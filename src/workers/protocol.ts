import type { ErrorPayload } from '../core/errors';

export type EngineMethod = 'ingestPdf' | 'imageToPdfs' | 'blankPdf' | 'compress' | 'exportPdf';

export interface EngineRequest {
  id: number;
  method: EngineMethod;
  args: unknown[];
}

export type EngineResponse =
  | { id: number; kind: 'result'; result: unknown }
  | { id: number; kind: 'error'; error: ErrorPayload }
  | { id: number; kind: 'progress'; progress: unknown[] };
