import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Text of every page, via pdf.js (an independent parser from the one that wrote it). */
export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim());
  }
  await task.destroy();
  return out;
}

/** The label drawn by labelledPdf on each page, e.g. ["A-1", "B-2", ...]. */
export async function pageLabels(bytes: Uint8Array): Promise<string[]> {
  return (await pageTexts(bytes)).map((t) => (t.match(/\b([A-Z]+-\d+)\b/) ?? ['?'])[0]);
}

export async function pageGeometry(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => ({ w: Math.round(p.getWidth()), h: Math.round(p.getHeight()), rotate: p.getRotation().angle }));
}

/** Decoded content-stream text of one page (0-based), to assert drawing operators. */
export async function pageContent(bytes: Uint8Array, index: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(index);
  const contents = page.node.lookup(PDFName.of('Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  return streams
    .map((s) => (s instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()) : ''))
    .join('\n');
}

export async function annotationSubtypes(bytes: Uint8Array, index: number): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(index).node.Annots();
  if (!annots) return [];
  return annots.asArray().map((r) => String(doc.context.lookup(r, PDFDict).get(PDFName.of('Subtype'))));
}
