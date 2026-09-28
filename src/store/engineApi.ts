import type { CompressionLevel, BlobId, WorkspaceState } from '../core/types';
import type { CompressResult, ImageCodec } from '../engine/compress';
import { compressPdf } from '../engine/compress';
import { exportWorkspace, type ExportOptions } from '../engine/export';
import { sniffMime } from '../engine/imageInfo';
import { blankPdf, imageToPdf, ingestPdf, type ImagePageSize, type IngestedPdf } from '../engine/ingest';
import { WorkspaceError } from '../core/errors';

/**
 * The heavy PDF work behind one interface. In the browser it runs in a Web Worker
 * (engineClient.ts) so parsing, compression and export never freeze the page; tests
 * and the worker itself use the in-process implementation below.
 */
export interface EngineApi {
  ingestPdf(bytes: Uint8Array, name: string, password?: string): Promise<IngestedPdf>;
  /** One PDF per image (multi-page TIFFs produce several). */
  imageToPdfs(bytes: Uint8Array, name: string, size: ImagePageSize): Promise<Uint8Array[]>;
  blankPdf(width: number, height: number): Promise<Uint8Array>;
  compress(bytes: Uint8Array, level: CompressionLevel, onProgress?: (done: number, total: number) => void): Promise<CompressResult>;
  exportPdf(
    state: WorkspaceState,
    blobs: Record<BlobId, Uint8Array>,
    options: ExportOptions,
    onProgress?: (done: number, total: number, stage: string) => void,
  ): Promise<Uint8Array>;
}

/**
 * Converts any image the platform can decode into JPEG/PNG bytes PDF can embed.
 * Returns one entry per frame/page. JPEG and PNG must be returned untouched.
 */
export type ImageNormalizer = (bytes: Uint8Array, mime: string, name: string) => Promise<Uint8Array[]>;

export const passThroughNormalizer: ImageNormalizer = async (bytes, mime, name) => {
  if (mime === 'image/jpeg' || mime === 'image/png') return [bytes];
  throw new WorkspaceError('UNSUPPORTED_FILE', `"${name}" is an image type this environment cannot convert (${mime}).`);
};

export function createLocalEngine(codec: ImageCodec | null, normalize: ImageNormalizer = passThroughNormalizer): EngineApi {
  return {
    ingestPdf: (bytes, name, password) => ingestPdf(bytes, name, password),
    async imageToPdfs(bytes, name, size) {
      const mime = sniffMime(bytes);
      if (!mime || !mime.startsWith('image/')) {
        throw new WorkspaceError('UNSUPPORTED_FILE', `"${name}" is not a supported image.`);
      }
      const frames = await normalize(bytes, mime, name);
      const out: Uint8Array[] = [];
      for (const f of frames) out.push(await imageToPdf(f, name, size));
      return out;
    },
    blankPdf: (w, h) => blankPdf(w, h),
    compress: (bytes, level, onProgress) => compressPdf(bytes, level, codec, onProgress),
    exportPdf: (state, blobs, options, onProgress) =>
      exportWorkspace(
        state,
        async (id) => {
          const b = blobs[id];
          if (!b) throw new Error(`Missing data for ${id}`);
          return b;
        },
        options,
        onProgress ? (p) => onProgress(p.done, p.total, p.stage) : undefined,
      ),
  };
}
