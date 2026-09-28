import {
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from '@cantoo/pdf-lib';
import { WorkspaceError } from '../core/errors';
import { normRotation } from '../core/geometry';
import type { SourcePageInfo } from '../core/types';
import { orientationMatrix, orientedSize, readImageInfo, sniffMime } from './imageInfo';

/**
 * Ingest: turn user files into validated PDF sources. PDFs are parsed (and decrypted
 * when they only carry an owner password); images become one-page PDFs that embed the
 * ORIGINAL JPEG/PNG bytes, so there is no re-encoding and no quality loss.
 */

export const MAX_FILE_BYTES = 500 * 1024 * 1024;

export interface IngestedPdf {
  bytes: Uint8Array;
  pages: SourcePageInfo[];
  /** True when the file was encrypted and has been stored decrypted. */
  decrypted: boolean;
  title: string | null;
}

export function describePages(doc: PDFDocument): SourcePageInfo[] {
  return doc.getPages().map((p) => {
    const box = p.getCropBox();
    return {
      width: round2(Math.abs(box.width)),
      height: round2(Math.abs(box.height)),
      rotation: normRotation(p.getRotation().angle),
    };
  });
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export async function ingestPdf(input: Uint8Array, name: string, password?: string): Promise<IngestedPdf> {
  if (input.byteLength > MAX_FILE_BYTES) {
    throw new WorkspaceError('FILE_TOO_LARGE', `"${name}" is larger than 500 MB and cannot be opened in the browser.`);
  }
  if (sniffMime(input) !== 'application/pdf') {
    throw new WorkspaceError('PDF_PARSE', `"${name}" is not a PDF file.`, 'The file does not contain a %PDF- header.');
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (err) {
    throw new WorkspaceError(
      'PDF_PARSE',
      `"${name}" could not be read. The file may be damaged or is not a valid PDF.`,
      err instanceof Error ? err.message : String(err),
    );
  }

  let bytes = input;
  let decrypted = false;
  let pages: SourcePageInfo[];
  try {
    if (doc.isEncrypted) {
      let unlocked: PDFDocument;
      try {
        unlocked = await PDFDocument.load(input, { password: password ?? '', updateMetadata: false, throwOnInvalidObject: false });
      } catch (err) {
        throw new WorkspaceError(
          'PDF_ENCRYPTED',
          password ? `The password for "${name}" is not correct.` : `"${name}" is password protected. Enter its password to add it.`,
          err instanceof Error ? err.message : String(err),
        );
      }
      // Copy the decrypted pages into a fresh, unencrypted document so everything
      // downstream (rendering, export, compression) sees a plain PDF.
      const plain = await PDFDocument.create({ updateMetadata: false });
      const copied = await plain.copyPages(unlocked, unlocked.getPageIndices());
      for (const p of copied) plain.addPage(p);
      bytes = await plain.save({ useObjectStreams: true });
      decrypted = true;
      doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    }
    pages = describePages(doc);
  } catch (err) {
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError(
      'PDF_PARSE',
      `"${name}" could not be read. The file may be damaged or is not a valid PDF.`,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (pages.length === 0) {
    throw new WorkspaceError('PDF_EMPTY', `"${name}" contains no pages.`);
  }
  for (const [i, p] of pages.entries()) {
    if (!(p.width > 0 && p.height > 0)) {
      throw new WorkspaceError('PDF_PARSE', `Page ${i + 1} of "${name}" has no usable size.`);
    }
  }
  let title: string | null = null;
  try {
    title = doc.getTitle() ?? null;
  } catch {
    title = null;
  }
  return { bytes, pages, decrypted, title };
}

/* --------------------------------- images -------------------------------- */

export type ImagePageSize =
  /** Page takes the image's shape; physical size from the file's DPI, else 96 DPI capped to 11 in. */
  | { mode: 'image' }
  /** Image fitted and centred on a page of this size, turned to landscape for wide images. */
  | { mode: 'fixed'; width: number; height: number; margin: number };

export const PAGE_SIZES = {
  letter: { width: 612, height: 792, label: 'Letter (8.5 × 11 in)' },
  a4: { width: 595.28, height: 841.89, label: 'A4 (210 × 297 mm)' },
  legal: { width: 612, height: 1008, label: 'Legal (8.5 × 14 in)' },
} as const;

const MAX_AUTO_SIDE = 792; // 11 in

/**
 * Page size in points for an image in "image" mode. A stated resolution of 100 DPI or
 * more (scans) gives the true physical size; screen images and photos, which usually
 * state 72 DPI or nothing, are sized at 96 DPI and capped to 11 inches on the long side.
 * The embedded image keeps every pixel either way; only its printed size changes.
 */
export function autoImagePageSize(widthPx: number, heightPx: number, dpi: number | null): { width: number; height: number } {
  if (dpi && dpi >= 100) return { width: (widthPx * 72) / dpi, height: (heightPx * 72) / dpi };
  let w = widthPx * 0.75;
  let h = heightPx * 0.75;
  const long = Math.max(w, h);
  if (long > MAX_AUTO_SIDE) {
    w = (w * MAX_AUTO_SIDE) / long;
    h = (h * MAX_AUTO_SIDE) / long;
  }
  return { width: w, height: h };
}

/**
 * Build a one-page PDF around a JPEG or PNG. The bytes are embedded as-is (JPEG is
 * never re-compressed); EXIF orientation is applied with the placement matrix.
 */
export async function imageToPdf(image: Uint8Array, name: string, size: ImagePageSize = { mode: 'image' }): Promise<Uint8Array> {
  let info;
  try {
    info = readImageInfo(image);
  } catch (err) {
    throw new WorkspaceError('IMAGE_DECODE', `"${name}" could not be read as an image.`, err instanceof Error ? err.message : String(err));
  }
  const shown = orientedSize(info);
  const doc = await PDFDocument.create({ updateMetadata: false });
  let embedded;
  try {
    embedded = info.mime === 'image/jpeg' ? await doc.embedJpg(image) : await doc.embedPng(image);
  } catch (err) {
    throw new WorkspaceError('IMAGE_DECODE', `"${name}" could not be embedded in a PDF.`, err instanceof Error ? err.message : String(err));
  }

  let pageW: number;
  let pageH: number;
  let box: { x: number; y: number; w: number; h: number };
  if (size.mode === 'image') {
    const s = autoImagePageSize(shown.width, shown.height, info.dpi);
    pageW = s.width;
    pageH = s.height;
    box = { x: 0, y: 0, w: pageW, h: pageH };
  } else {
    const landscape = shown.width > shown.height;
    pageW = landscape ? Math.max(size.width, size.height) : Math.min(size.width, size.height);
    pageH = landscape ? Math.min(size.width, size.height) : Math.max(size.width, size.height);
    const availW = Math.max(1, pageW - 2 * size.margin);
    const availH = Math.max(1, pageH - 2 * size.margin);
    const k = Math.min(availW / shown.width, availH / shown.height);
    const w = shown.width * k;
    const h = shown.height * k;
    box = { x: (pageW - w) / 2, y: (pageH - h) / 2, w, h };
  }

  const page = doc.addPage([pageW, pageH]);
  const key = page.node.newXObject('Im', embedded.ref);
  const m = orientationMatrix(info.orientation, box.x, box.y, box.w, box.h);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(key), popGraphicsState());
  doc.setTitle(name, { showInWindowTitleBar: false });
  doc.setProducer('PDF Workspace');
  return doc.save({ useObjectStreams: true });
}

/** A blank page, used for "insert blank page". */
export async function blankPdf(width: number, height: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([width, height]);
  return doc.save();
}
