import { describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids';
import type { Annotation, PageId } from '../../src/core/types';
import { compressPdf } from '../../src/engine/compress';
import { bigPdf, jpegBytes, labelledPdf, photoPdf, pngBytes } from '../fixtures/make';
import { newController, nodeCodec } from '../helpers/codec';
import { pageContent, pageGeometry, pageLabels, pageTexts } from '../helpers/pdf';

type Ctl = ReturnType<typeof newController>['ctl'];

/** Label a page by what it shows (source label + page number), as the exported text will. */
function labelOf(ctl: Ctl, id: PageId): string {
  const p = ctl.state.pages.find((x) => x.id === id)!;
  const src = ctl.state.sources[p.sourceId];
  if (src.origin === 'image') return '?';
  return `${src.name.replace(/\.pdf$/, '')}-${p.sourcePageIndex + 1}`;
}
const order = (ctl: Ctl) => ctl.state.pages.map((p) => labelOf(ctl, p.id));

const redText = (text: string): Annotation => ({
  id: newId('an'),
  type: 'text',
  rect: { x: 50, y: 100, w: 300, h: 30 },
  rotation: 0,
  text,
  fontFamily: 'helvetica',
  fontSize: 16,
  bold: true,
  italic: false,
  align: 'left',
  color: '#e11d2a',
  background: null,
  opacity: 1,
});
const pen = (width: number, y: number): Annotation => ({
  id: newId('an'),
  type: 'ink',
  points: [80, y, 120, y + 20, 160, y - 10, 220, y + 15, 280, y],
  color: '#e11d2a',
  width,
  opacity: 1,
});

describe('compression', () => {
  it('shrinks photos, keeps pages, text and geometry, and is a no-op when nothing helps', async () => {
    const src = await photoPdf('P');
    const r = await compressPdf(src, 'balanced', nodeCodec);
    expect(r.changed).toBe(true);
    expect(r.after).toBeLessThan(r.before * 0.6);
    expect(r.imagesRecompressed).toBe(2);
    expect(await pageLabels(r.bytes)).toEqual(['P-1', 'P-2']);
    expect(await pageGeometry(r.bytes)).toEqual(await pageGeometry(src));

    const strong = await compressPdf(src, 'strong', nodeCodec);
    expect(strong.after).toBeLessThan(r.after);

    const text = await labelledPdf('T', 3);
    const lossless = await compressPdf(text, 'lossless', nodeCodec);
    expect(await pageLabels(lossless.bytes)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(lossless.after).toBeLessThanOrEqual(lossless.before);
  });
});

describe('THE chained workflow (exactly as specified)', () => {
  it('merge → delete 3,7,10 → insert C after 5 → JPG after 8 → reorder → compress → annotate p12 (red text, 5px pen, 2px pen, more) → delete → insert PDF → reorder → keep editing → export', async () => {
    const { ctl } = newController();

    // 1. PDF A + PDF B → merge
    await ctl.addFiles([
      { name: 'A.pdf', bytes: await labelledPdf('A', 8, { sizes: [[612, 792], [842, 595]] }) },
      { name: 'B.pdf', bytes: await labelledPdf('B', 6, { sizes: [[595, 842]], rotate: [0, 90] }) },
    ]);
    expect(order(ctl)).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'B-1', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6']);

    // 2. delete pages 3, 7 and 10
    const at = (n: number) => ctl.state.pages[n - 1].id;
    ctl.deletePages([at(3), at(7), at(10)]);
    expect(order(ctl)).toEqual(['A-1', 'A-2', 'A-4', 'A-5', 'A-6', 'A-8', 'B-1', 'B-3', 'B-4', 'B-5', 'B-6']);

    // 3. insert PDF C after page 5 — through the "prepare, preview, pick pages" path
    const { prepared } = await ctl.prepareFiles([{ name: 'C.pdf', bytes: await photoPdf('C') }]);
    expect(prepared[0].pages).toHaveLength(2);
    ctl.insertPrepared(prepared, 5);
    expect(order(ctl)).toEqual(['A-1', 'A-2', 'A-4', 'A-5', 'A-6', 'C-1', 'C-2', 'A-8', 'B-1', 'B-3', 'B-4', 'B-5', 'B-6']);

    // 4. insert a JPG after page 8 (converted to a page automatically)
    await ctl.addFiles([{ name: 'scan.jpg', bytes: jpegBytes(1200, 1600, 90) }], 8);
    expect(order(ctl)).toEqual(['A-1', 'A-2', 'A-4', 'A-5', 'A-6', 'C-1', 'C-2', 'A-8', '?', 'B-1', 'B-3', 'B-4', 'B-5', 'B-6']);
    const jpgPage = ctl.state.pages[8].id;

    // 5. reorder: last page to the front, and page 2 after page 4
    ctl.movePagesToIndex([at(14)], 0);
    ctl.movePages([at(3)], at(6));
    expect(order(ctl)).toEqual(['B-6', 'A-1', 'A-4', 'A-5', 'A-2', 'A-6', 'C-1', 'C-2', 'A-8', '?', 'B-1', 'B-3', 'B-4', 'B-5']);

    // 6. compress — same document, same pages, keep going
    const idsBefore = ctl.state.pages.map((p) => p.id);
    const report = await ctl.compress('balanced');
    expect(report!.after).toBeLessThan(report!.before);
    expect(ctl.state.pages.map((p) => p.id)).toEqual(idsBefore);
    expect(order(ctl)).toEqual(['B-6', 'A-1', 'A-4', 'A-5', 'A-2', 'A-6', 'C-1', 'C-2', 'A-8', '?', 'B-1', 'B-3', 'B-4', 'B-5']);

    // 7. open page 12, add red text, draw with a 5px pen, switch to 2px, add another annotation
    const p12 = at(12);
    expect(labelOf(ctl, p12)).toBe('B-3');
    ctl.addAnnotation(p12, redText('RED TEXT ON B3'), 'Added text');
    ctl.addAnnotation(p12, pen(5, 300), 'Drew with the pen');
    ctl.addAnnotation(p12, pen(2, 400), 'Drew with the pen');
    ctl.addAnnotation(p12, { id: newId('an'), type: 'shape', shape: 'rect', rect: { x: 40, y: 500, w: 200, h: 80 }, strokeColor: '#1d4ed8', strokeWidth: 3, fillColor: null, opacity: 1 });
    expect(ctl.state.pages[11].annotations).toHaveLength(4);

    // undo/redo across annotation + page history
    ctl.undo();
    expect(ctl.state.pages[11].annotations).toHaveLength(3);
    ctl.redo();
    expect(ctl.state.pages[11].annotations).toHaveLength(4);

    // 8. back in the organizer: delete another page, insert another PDF, reorder again
    ctl.deletePages([at(2)]); // A-1
    const { prepared: d } = await ctl.prepareFiles([{ name: 'D.pdf', bytes: await labelledPdf('D', 3) }]);
    ctl.insertPrepared(d, 2, { [d[0].key]: [0, 2] }); // only pages 1 and 3 of D
    expect(order(ctl)).toEqual(['B-6', 'A-4', 'D-1', 'D-3', 'A-5', 'A-2', 'A-6', 'C-1', 'C-2', 'A-8', '?', 'B-1', 'B-3', 'B-4', 'B-5']);
    ctl.movePagesToIndex([p12], 0); // the annotated page to the very front
    expect(order(ctl)[0]).toBe('B-3');
    expect(ctl.state.pages[0].annotations).toHaveLength(4); // annotations travelled with the page

    // 9. continue editing: image insertion AFTER compression, rotation, a note, another stroke
    await ctl.addFiles([{ name: 'logo.png', bytes: pngBytes(200, 100) }], 3);
    ctl.rotatePages([jpgPage], 90);
    ctl.addAnnotation(ctl.state.pages[0].id, { id: newId('an'), type: 'note', x: 500, y: 40, text: 'Reviewed', color: '#ffd400', opacity: 1 });
    ctl.addAnnotation(jpgPage, pen(4, 200));
    const expected = order(ctl);
    expect(expected).toHaveLength(16);

    // 10. export and reopen the exported PDF
    const out = (await ctl.exportPdf())!;
    expect(ctl.hasUnexportedChanges).toBe(false);
    const labels = await pageLabels(out);
    expect(labels).toEqual(expected);
    const texts = await pageTexts(out);
    expect(texts[0]).toContain('RED TEXT ON B3');
    expect(texts.filter((t) => t.includes('RED TEXT')).length).toBe(1);
    const c0 = await pageContent(out, 0);
    expect(c0).toMatch(/\b5 w\b/);
    expect(c0).toMatch(/\b2 w\b/);
    expect(c0).toMatch(/0\.88\d* 0\.11\d* 0\.16\d* RG/); // red pen
    const geo = await pageGeometry(out);
    const jpgIdx = ctl.state.pages.findIndex((p) => p.id === jpgPage);
    expect(geo[jpgIdx].rotate).toBe(90);
    // B-2 was page 10 and deleted in step 2; mixed sizes survived
    expect(new Set(geo.map((g) => `${g.w}x${g.h}`)).size).toBeGreaterThan(2);

    // History is one timeline: undo all the way back to an empty workspace works.
    const steps = ctl.view.history.index;
    for (let i = 0; i < steps; i++) ctl.undo();
    expect(ctl.state.pages).toHaveLength(0);
    for (let i = 0; i < steps; i++) ctl.redo();
    expect(order(ctl)).toEqual(expected);
    expect(ctl.hasUnexportedChanges).toBe(false); // back on the exported state
  });

  it('repeated merge/insert/delete/reorder cycles keep ids, annotations and export consistent', async () => {
    const { ctl } = newController();
    await ctl.addFiles([{ name: 'S.pdf', bytes: await labelledPdf('S', 5) }]);
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 16807) % 2147483647) % n);
    for (let cycle = 0; cycle < 12; cycle++) {
      const n = ctl.state.pages.length;
      const label = `X${String.fromCharCode(65 + cycle)}`;
      const { prepared } = await ctl.prepareFiles([{ name: `${label}.pdf`, bytes: await labelledPdf(label, 2) }]);
      ctl.insertPrepared(prepared, rnd(n + 1));
      const victim = ctl.state.pages[rnd(ctl.state.pages.length)];
      if (ctl.state.pages.length > 3) ctl.deletePages([victim.id]);
      const mover = ctl.state.pages[rnd(ctl.state.pages.length)];
      ctl.movePagesToIndex([mover.id], rnd(ctl.state.pages.length));
      const target = ctl.state.pages[rnd(ctl.state.pages.length)];
      ctl.addAnnotation(target.id, redText(`mark ${cycle}`));
      if (cycle % 4 === 3) await ctl.compress('lossless');
    }
    const expected = order(ctl);
    const marks = new Map(ctl.state.pages.map((p, i) => [i, p.annotations.map((a) => (a.type === 'text' ? a.text : '')).join('|')]));
    const out = (await ctl.exportPdf())!;
    expect(await pageLabels(out)).toEqual(expected);
    const texts = await pageTexts(out);
    for (const [i, m] of marks) for (const t of m.split('|').filter(Boolean)) expect(texts[i]).toContain(t);
  });
});

describe('large documents', () => {
  it('handles a 600-page merge, reorder and export', async () => {
    const { ctl } = newController();
    const t0 = Date.now();
    await ctl.addFiles([
      { name: 'L.pdf', bytes: await bigPdf('L', 400) },
      { name: 'M.pdf', bytes: await bigPdf('M', 200) },
    ]);
    expect(ctl.state.pages).toHaveLength(600);
    const odd = ctl.state.pages.filter((_, i) => i % 2 === 1).map((p) => p.id);
    ctl.movePagesToIndex(odd, 0);
    ctl.deletePages(ctl.state.pages.slice(100, 150).map((p) => p.id));
    const out = (await ctl.exportPdf())!;
    const labels = await pageLabels(out);
    expect(labels).toHaveLength(550);
    expect(labels.slice(0, 3)).toEqual(['L-2', 'L-4', 'L-6']);
    expect(Date.now() - t0).toBeLessThan(60_000);
  });
});
