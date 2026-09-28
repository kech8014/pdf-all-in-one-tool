import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids';
import type { Annotation, TextAnnotation } from '../../src/core/types';
import { readImageInfo } from '../../src/engine/imageInfo';
import { autoImagePageSize, imageToPdf, ingestPdf } from '../../src/engine/ingest';
import { layoutText } from '../../src/engine/textLayout';
import { jpegBytes, labelledPdf, pngBytes } from '../fixtures/make';
import { newController } from '../helpers/codec';
import { annotationSubtypes, pageContent, pageGeometry, pageLabels, pageTexts } from '../helpers/pdf';

const file = async (label: string, n: number, opts = {}) => ({ name: `${label}.pdf`, bytes: await labelledPdf(label, n, opts) });

function text(over: Partial<TextAnnotation> = {}): TextAnnotation {
  return {
    id: newId('an'),
    type: 'text',
    rect: { x: 60, y: 120, w: 260, h: 40 },
    rotation: 0,
    text: 'Red note here',
    fontFamily: 'helvetica',
    fontSize: 18,
    bold: false,
    italic: false,
    align: 'left',
    color: '#e11d2a',
    background: null,
    opacity: 1,
    ...over,
  };
}

describe('ingest', () => {
  it('reads page sizes and intrinsic rotation of mixed documents', async () => {
    const bytes = await labelledPdf('M', 3, { sizes: [[612, 792], [842, 595], [300, 400]], rotate: [0, 90, 0] });
    const r = await ingestPdf(bytes, 'M.pdf');
    expect(r.pages).toEqual([
      { width: 612, height: 792, rotation: 0 },
      { width: 842, height: 595, rotation: 90 },
      { width: 300, height: 400, rotation: 0 },
    ]);
  });

  it('rejects non-PDF and damaged files with a clear message', async () => {
    await expect(ingestPdf(new TextEncoder().encode('hello world, not a pdf'), 'x.pdf')).rejects.toThrow(/is not a PDF/);
    const good = await labelledPdf('D', 1);
    const damaged = good.slice(0, 40);
    await expect(ingestPdf(damaged, 'd.pdf')).rejects.toThrow(/could not be read|no pages/);
  });

  it('opens owner-password-only encrypted PDFs and asks for a password otherwise', async () => {
    const doc = await PDFDocument.load(await labelledPdf('E', 2));
    doc.encrypt({ ownerPassword: 'owner', userPassword: '' } as never);
    const ownerOnly = await doc.save();
    const r = await ingestPdf(ownerOnly, 'owner.pdf');
    expect(r.decrypted).toBe(true);
    expect(await pageLabels(r.bytes)).toEqual(['E-1', 'E-2']);

    const doc2 = await PDFDocument.load(await labelledPdf('F', 1));
    doc2.encrypt({ ownerPassword: 'owner', userPassword: 'secret' } as never);
    const locked = await doc2.save();
    await expect(ingestPdf(locked, 'locked.pdf')).rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });
    const opened = await ingestPdf(locked, 'locked.pdf', 'secret');
    expect(await pageLabels(opened.bytes)).toEqual(['F-1']);
  });
});

describe('images become pages without quality loss', () => {
  it('embeds the original JPEG bytes untouched', async () => {
    const jpg = jpegBytes(800, 600, 90);
    const pdf = await imageToPdf(jpg, 'photo.jpg');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(1);
    // The JPEG stream inside the PDF is byte-identical to the input.
    const hay = Buffer.from(pdf);
    expect(hay.indexOf(Buffer.from(jpg.subarray(0, 2000)))).toBeGreaterThan(0);
    const [p] = await pageGeometry(pdf);
    expect(p).toEqual({ w: 600, h: 450, rotate: 0 });
  });

  it('sizes pages from DPI, caps screen images and fits to paper', async () => {
    expect(autoImagePageSize(2550, 3300, 300)).toEqual({ width: 612, height: 792 });
    const photo = autoImagePageSize(4000, 3000, 72);
    expect(Math.max(photo.width, photo.height)).toBeCloseTo(792);
    const png = pngBytes(300, 200);
    const pdf = await imageToPdf(png, 'wide.png', { mode: 'fixed', width: 612, height: 792, margin: 36 });
    expect(await pageGeometry(pdf)).toEqual([{ w: 792, h: 612, rotate: 0 }]); // auto landscape
  });

  it('reads EXIF orientation and swaps the page shape for rotated photos', async () => {
    const jpg = jpegBytes(400, 200, 80);
    // Insert an EXIF APP1 segment with Orientation = 6 (rotate 90 CW) after SOI.
    const exif = new Uint8Array([
      0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12,
      0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const withExif = new Uint8Array(jpg.length + exif.length);
    withExif.set(jpg.subarray(0, 2));
    withExif.set(exif, 2);
    withExif.set(jpg.subarray(2), 2 + exif.length);
    expect(readImageInfo(withExif).orientation).toBe(6);
    const pdf = await imageToPdf(withExif, 'rotated.jpg');
    expect(await pageGeometry(pdf)).toEqual([{ w: 150, h: 300, rotate: 0 }]);
  });
});

describe('export', () => {
  it('merges, reorders and rotates while copying original content (text stays text)', async () => {
    const { ctl } = newController();
    await ctl.addFiles([await file('A', 3), await file('B', 2)]);
    const [a1, a2, a3, b1, b2] = ctl.state.pages.map((p) => p.id);
    ctl.movePages([b2], a1);
    ctl.rotatePages([a3], 90);
    ctl.deletePages([a2]);
    const out = (await ctl.exportPdf())!;
    expect(await pageLabels(out)).toEqual(['B-2', 'A-1', 'A-3', 'B-1']);
    const geo = await pageGeometry(out);
    expect(geo[2].rotate).toBe(90);
    expect(b1).toBeTruthy();
  });

  it('draws text and ink as vector content in the chosen colour and width', async () => {
    const { ctl } = newController();
    await ctl.addFiles([await file('A', 2)]);
    const page = ctl.state.pages[1];
    ctl.addAnnotation(page.id, text({ text: 'Hello red text' }));
    const stroke = (w: number): Annotation => ({ id: newId('an'), type: 'ink', points: [100, 300, 150, 320, 200, 300, 260, 340], color: '#1d4ed8', width: w, opacity: 1 });
    ctl.addAnnotation(page.id, stroke(5));
    ctl.addAnnotation(page.id, stroke(2));
    const out = (await ctl.exportPdf())!;
    const texts = await pageTexts(out);
    expect(texts[1]).toContain('Hello red text');
    expect(texts[0]).not.toContain('Hello red text');
    const content = await pageContent(out, 1);
    expect(content).toMatch(/0\.88\d* 0\.11\d* 0\.16\d* rg/); // #e11d2a fill for text
    expect(content).toMatch(/\b5 w\b/);
    expect(content).toMatch(/\b2 w\b/);
  });

  it('places annotations in page space on rotated and offset pages', async () => {
    const { ctl } = newController();
    await ctl.addFiles([await file('R', 1, { rotate: [90] })]);
    const p = ctl.state.pages[0];
    ctl.addAnnotation(p.id, text({ text: 'Upright', rotation: 270 }));
    const out = (await ctl.exportPdf())!;
    // pdf.js may split rotated runs into chunks; compare without whitespace.
    expect((await pageTexts(out))[0].replace(/\s/g, '')).toContain('Upright');
    expect((await pageGeometry(out))[0].rotate).toBe(90);
  });

  it('exports sticky notes as real PDF comments and extracts a subset of pages', async () => {
    const { ctl } = newController();
    await ctl.addFiles([await file('N', 3)]);
    const [p1, p2, p3] = ctl.state.pages.map((p) => p.id);
    ctl.addAnnotation(p2, { id: newId('an'), type: 'note', x: 100, y: 100, text: 'Check this', color: '#ffd400', opacity: 1 });
    const out = (await ctl.exportPdf({ pageIds: [p3, p2] }))!;
    expect(await pageLabels(out)).toEqual(['N-2', 'N-3']); // workspace order is kept
    expect(await annotationSubtypes(out, 0)).toEqual(['/Text']);
    expect(p1).toBeTruthy();
  });

  it('duplicated pages are separate objects with their own annotations', async () => {
    const { ctl } = newController();
    await ctl.addFiles([await file('D', 1)]);
    const [orig] = ctl.duplicatePages([ctl.state.pages[0].id]).length ? ctl.state.pages.map((p) => p.id) : [];
    ctl.addAnnotation(orig, text({ text: 'Only on the first' }));
    const out = (await ctl.exportPdf())!;
    const t = await pageTexts(out);
    expect(t[0]).toContain('Only on the first');
    expect(t[1]).not.toContain('Only on the first');
  });
});

describe('text layout', () => {
  it('wraps words, breaks long words and aligns lines', () => {
    const l = layoutText({ text: 'one two three four five six seven', fontFamily: 'helvetica', bold: false, italic: false, fontSize: 12, align: 'left', boxWidth: 80 });
    expect(l.lines.length).toBeGreaterThan(2);
    for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(80);
    const long = layoutText({ text: 'Supercalifragilisticexpialidocious', fontFamily: 'courier', bold: false, italic: false, fontSize: 12, align: 'right', boxWidth: 60 });
    expect(long.lines.length).toBeGreaterThan(1);
    const multi = layoutText({ text: 'a\n\nb', fontFamily: 'times', bold: true, italic: true, fontSize: 10, align: 'center', boxWidth: 200 });
    expect(multi.lines.map((x) => x.text)).toEqual(['a', '', 'b']);
  });
});
