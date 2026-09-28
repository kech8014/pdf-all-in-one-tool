import {
  LineCapStyle,
  LineJoinStyle,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFImage,
  PDFName,
  PDFOperator,
  PDFPage,
  PDFRef,
  appendBezierCurve,
  beginText,
  closePath,
  concatTransformationMatrix,
  degrees,
  drawObject,
  endText,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
} from '@cantoo/pdf-lib';
import { hexToRgb } from '../core/color';
import { WorkspaceError } from '../core/errors';
import { NOTE_SIZE, effectiveRotation, localSize, localToPageMatrix } from '../core/geometry';
import { arrowHead, arrowShaftEnd, smoothStroke } from '../core/paths';
import type { Annotation, BlobId, ImageAnnotation, Page, PageId, TextAnnotation, WorkspaceState } from '../core/types';
import { validateState } from '../core/validation';
import { layoutText, sanitizeText, standardFontName } from './textLayout';

export type BlobReader = (id: BlobId) => Promise<Uint8Array>;

export interface ExportOptions {
  /** Export only these pages (kept in workspace order). Default: all pages. */
  pageIds?: PageId[];
  /** Pack objects into compressed object streams (smaller file). Default true. */
  objectStreams?: boolean;
  title?: string;
  author?: string;
  subject?: string;
}

export interface ExportProgress {
  done: number;
  total: number;
  stage: 'loading' | 'pages' | 'saving';
}

/**
 * Build the final PDF from the canonical state:
 *   1. every page is COPIED from its source document (text, vectors, fonts and images
 *      are carried over byte-for-byte, nothing is rasterized);
 *   2. the page's effective rotation is set;
 *   3. annotations are drawn on top as real PDF vector content (sticky notes become
 *      real PDF comments).
 */
export async function exportWorkspace(
  state: WorkspaceState,
  readBlob: BlobReader,
  options: ExportOptions = {},
  onProgress?: (p: ExportProgress) => void,
): Promise<Uint8Array> {
  const problems = validateState(state);
  if (problems.length) throw new WorkspaceError('STATE_INVALID', 'The workspace is inconsistent and cannot be exported.', problems.join('; '));

  const wanted = options.pageIds ? new Set(options.pageIds) : null;
  const pages = wanted ? state.pages.filter((p) => wanted.has(p.id)) : state.pages;
  if (pages.length === 0) throw new WorkspaceError('EXPORT_FAILED', 'There are no pages to export.');

  const out = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  out.setTitle(options.title ?? (state.meta.title || state.name));
  if (options.author ?? state.meta.author) out.setAuthor(options.author ?? state.meta.author);
  if (options.subject ?? state.meta.subject) out.setSubject(options.subject ?? state.meta.subject);
  out.setProducer('PDF Workspace');
  out.setCreator('PDF Workspace');
  out.setCreationDate(now);
  out.setModificationDate(now);

  // 1. Copy pages source by source (one load per source), preserving duplicates as
  //    separate page objects so each can carry its own annotations and rotation.
  const copied = new Map<PageId, PDFPage>();
  const bySource = new Map<string, Page[]>();
  for (const p of pages) {
    if (!bySource.has(p.sourceId)) bySource.set(p.sourceId, []);
    bySource.get(p.sourceId)!.push(p);
  }
  let loaded = 0;
  for (const [sourceId, list] of bySource) {
    const src = state.sources[sourceId];
    onProgress?.({ done: loaded, total: bySource.size, stage: 'loading' });
    let srcDoc: PDFDocument;
    try {
      srcDoc = await PDFDocument.load(await readBlob(src.blobId), { updateMetadata: false, throwOnInvalidObject: false });
    } catch (err) {
      throw new WorkspaceError('EXPORT_FAILED', `Could not read "${src.name}" while exporting.`, err instanceof Error ? err.message : String(err));
    }
    const pdfPages = await out.copyPages(srcDoc, list.map((p) => p.sourcePageIndex));
    list.forEach((p, i) => copied.set(p.id, pdfPages[i]));
    loaded++;
  }

  // 2 + 3. Assemble in workspace order.
  const res = new ResourceCache(out, readBlob);
  for (const [i, p] of pages.entries()) {
    onProgress?.({ done: i, total: pages.length, stage: 'pages' });
    const page = copied.get(p.id)!;
    detachPage(out, page);
    const crop = page.getCropBox();
    if (p.annotations.length) {
      try {
        await drawAnnotations(out, page, p.annotations, res, crop);
      } catch (err) {
        throw new WorkspaceError(
          'EXPORT_FAILED',
          `Annotations on page ${state.pages.indexOf(p) + 1} could not be written.`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    page.setRotation(degrees(effectiveRotation(state, p)));
    out.addPage(page);
  }

  onProgress?.({ done: pages.length, total: pages.length, stage: 'saving' });
  return out.save({ useObjectStreams: options.objectStreams ?? true, addDefaultPage: false });
}

/**
 * copyPages() shares direct objects between copies of the same source page (the
 * /Contents and /Annots arrays), so drawing on one duplicate would draw on both. Give
 * every page its own arrays before anything is appended to them.
 */
function detachPage(doc: PDFDocument, page: PDFPage) {
  for (const key of ['Contents', 'Annots']) {
    const name = PDFName.of(key);
    const value = page.node.get(name);
    const arr = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (arr instanceof PDFArray) page.node.set(name, arr.clone(doc.context));
  }
}

/* --------------------------- annotation drawing -------------------------- */

class ResourceCache {
  private fonts = new Map<string, PDFFont>();
  private images = new Map<BlobId, PDFImage>();
  constructor(
    private doc: PDFDocument,
    private readBlob: BlobReader,
  ) {}

  font(a: TextAnnotation): PDFFont {
    const name = standardFontName(a.fontFamily, a.bold, a.italic);
    let f = this.fonts.get(name);
    if (!f) {
      f = this.doc.embedStandardFont(name);
      this.fonts.set(name, f);
    }
    return f;
  }

  async image(a: ImageAnnotation): Promise<PDFImage> {
    let img = this.images.get(a.blobId);
    if (!img) {
      const bytes = await this.readBlob(a.blobId);
      img = a.mime === 'image/jpeg' ? await this.doc.embedJpg(bytes) : await this.doc.embedPng(bytes);
      this.images.set(a.blobId, img);
    }
    return img;
  }
}

type Box = { x: number; y: number; width: number; height: number };

async function drawAnnotations(doc: PDFDocument, page: PDFPage, anns: Annotation[], res: ResourceCache, crop: Box) {
  const ops: PDFOperator[] = [];
  const gsKeys = new Map<string, PDFName>();
  const gs = (opacity: number, multiply = false): PDFOperator[] => {
    if (opacity >= 1 && !multiply) return [];
    const k = `${opacity.toFixed(3)}:${multiply}`;
    let key = gsKeys.get(k);
    if (!key) {
      const dict: Record<string, unknown> = { Type: 'ExtGState', ca: opacity, CA: opacity };
      if (multiply) dict.BM = 'Multiply';
      key = page.node.newExtGState('GS', doc.context.obj(dict as never) as unknown as PDFDict);
      gsKeys.set(k, key);
    }
    return [setGraphicsState(key)];
  };

  // Page space (top-left origin, y down) -> PDF user space.
  ops.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, crop.x, crop.y + crop.height));

  for (const a of anns) {
    if (a.type === 'note') {
      addNote(doc, page, a, crop);
      continue;
    }
    ops.push(pushGraphicsState(), ...gs(a.opacity, a.type === 'highlight'));
    switch (a.type) {
      case 'ink': {
        ops.push(strokeColor(a.color), setLineWidth(a.width), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
        let cx = 0;
        let cy = 0;
        for (const s of smoothStroke(a.points)) {
          if (s.op === 'M') ops.push(moveTo(s.x, s.y));
          else if (s.op === 'L') ops.push(lineTo(s.x, s.y));
          else {
            // Quadratic -> cubic Bézier (PDF has no quadratic operator).
            const c1x = cx + (2 / 3) * (s.cx - cx);
            const c1y = cy + (2 / 3) * (s.cy - cy);
            const c2x = s.x + (2 / 3) * (s.cx - s.x);
            const c2y = s.y + (2 / 3) * (s.cy - s.y);
            ops.push(appendBezierCurve(c1x, c1y, c2x, c2y, s.x, s.y));
          }
          cx = s.x;
          cy = s.y;
        }
        ops.push(stroke());
        break;
      }
      case 'line': {
        ops.push(strokeColor(a.color), setLineWidth(a.width), setLineCap(a.style === 'arrow' ? LineCapStyle.Round : LineCapStyle.Butt));
        if (a.style === 'arrow') {
          const [ex, ey] = arrowShaftEnd(a.x1, a.y1, a.x2, a.y2, a.width);
          ops.push(moveTo(a.x1, a.y1), lineTo(ex, ey), stroke());
          const [p0, p1, p2] = arrowHead(a.x1, a.y1, a.x2, a.y2, a.width);
          ops.push(fillColor(a.color), moveTo(...p0), lineTo(...p1), lineTo(...p2), closePath(), fill());
        } else {
          ops.push(moveTo(a.x1, a.y1), lineTo(a.x2, a.y2), stroke());
        }
        break;
      }
      case 'shape': {
        const { x, y, w, h } = a.rect;
        const doFill = !!a.fillColor;
        const doStroke = a.strokeWidth > 0;
        if (!doFill && !doStroke) break;
        if (doFill) ops.push(fillColor(a.fillColor!));
        if (doStroke) ops.push(strokeColor(a.strokeColor), setLineWidth(a.strokeWidth));
        if (a.shape === 'rect') ops.push(rectangle(x, y, w, h));
        else ops.push(...ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2));
        ops.push(doFill && doStroke ? fillAndStroke() : doFill ? fill() : stroke());
        break;
      }
      case 'highlight':
      case 'whiteout':
        ops.push(fillColor(a.color), rectangle(a.rect.x, a.rect.y, a.rect.w, a.rect.h), fill());
        break;
      case 'text':
        drawText(page, a, res.font(a), ops);
        break;
      case 'image': {
        const img = await res.image(a);
        const key = page.node.newXObject('Img', img.ref);
        const { w, h } = localSize(a.rect, a.rotation);
        ops.push(concatTransformationMatrix(...localToPageMatrix(a.rect, a.rotation)));
        ops.push(concatTransformationMatrix(w, 0, 0, -h, 0, h), drawObject(key));
        break;
      }
    }
    ops.push(popGraphicsState());
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}

function drawText(page: PDFPage, a: TextAnnotation, font: PDFFont, ops: PDFOperator[]) {
  const { w, h } = localSize(a.rect, a.rotation);
  ops.push(concatTransformationMatrix(...localToPageMatrix(a.rect, a.rotation)));
  if (a.background) ops.push(fillColor(a.background), rectangle(0, 0, w, h), fill());
  const layout = layoutText({ ...a, boxWidth: w });
  const key = page.node.newFontDictionary(font.name, font.ref);
  ops.push(fillColor(a.color));
  for (const line of layout.lines) {
    if (!line.text) continue;
    const text = sanitizeText(line.text, a.fontFamily, a.bold, a.italic);
    // Flip back to y-up at the baseline so glyphs are not mirrored.
    ops.push(
      pushGraphicsState(),
      concatTransformationMatrix(1, 0, 0, -1, line.x, line.baseline),
      beginText(),
      setFontAndSize(key, a.fontSize),
      showText(font.encodeText(text) as PDFHexString),
      endText(),
      popGraphicsState(),
    );
  }
}

function addNote(doc: PDFDocument, page: PDFPage, a: Extract<Annotation, { type: 'note' }>, crop: Box) {
  const [r, g, b] = hexToRgb(a.color);
  const x1 = crop.x + a.x;
  const y2 = crop.y + crop.height - a.y;
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [x1, y2 - NOTE_SIZE, x1 + NOTE_SIZE, y2],
    Contents: PDFHexString.fromText(a.text),
    Name: 'Comment',
    C: [r, g, b],
    CA: a.opacity,
    F: 4,
    Open: false,
    M: PDFHexString.fromText(pdfDate(new Date())),
    NM: PDFHexString.fromText(a.id),
  });
  page.node.addAnnot(doc.context.register(annot));
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const strokeColor = (hex: string) => setStrokingRgbColor(...hexToRgb(hex));
const fillColor = (hex: string) => setFillingRgbColor(...hexToRgb(hex));

function ellipsePath(cx: number, cy: number, rx: number, ry: number): PDFOperator[] {
  const k = 0.5522847498;
  return [
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
    closePath(),
  ];
}
