import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageContent, pageGeometry, pageLabels, pageTexts } from '../helpers/pdf';

const F = (n: string) => join(process.cwd(), 'tests', 'fixtures', 'out', n);

/** Label every page by what it shows, computed from the app's own canonical state. */
async function stateLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const s = window.__pdfws!.ctl.state;
    return s.pages.map((p) => {
      const src = s.sources[p.sourceId];
      return src.origin === 'image' ? '?' : `${src.name.replace(/\.pdf$/, '')}-${p.sourcePageIndex + 1}`;
    });
  });
}
const pageCount = (page: Page) => page.evaluate(() => window.__pdfws!.ctl.state.pages.length);
const pageIdAt = (page: Page, n: number) => page.evaluate((i) => window.__pdfws!.ctl.state.pages[i - 1].id, n);
const annotationsOn = (page: Page, id: string) =>
  page.evaluate((pid) => window.__pdfws!.ctl.state.pages.find((p) => p.id === pid)?.annotations ?? [], id);

async function chooseFiles(page: Page, trigger: () => Promise<void>, files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await trigger();
  await (await chooser).setFiles(files.map(F));
}

async function draw(page: Page, layer: string, pts: [number, number][]) {
  const box = (await page.locator(layer).boundingBox())!;
  await page.mouse.move(box.x + pts[0][0] * box.width, box.y + pts[0][1] * box.height);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 6 });
  await page.mouse.up();
}

async function openPage(page: Page, n: number) {
  await page.getByTestId('page-input').fill(String(n));
  await page.getByTestId('page-input').press('Enter');
  await expect(page.locator(`[data-page-number="${n}"] .ann-layer`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Each test starts from a brand new, empty workspace.
  await page.evaluate(async () => {
    indexedDB.deleteDatabase('pdf-workspace');
    localStorage.clear();
  });
  await page.reload();
  await expect(page.getByText('Start your PDF workspace')).toBeVisible();
});

test('the full chained workflow, entirely through the UI', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // 1. PDF A + PDF B → merge
  await chooseFiles(page, () => page.getByTestId('empty-choose').click(), ['A.pdf', 'B.pdf']);
  await expect(page.getByTestId('thumb-14')).toBeVisible();
  expect(await stateLabels(page)).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'B-1', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6']);

  // 2. delete pages 3, 7 and 10 (multi-select with Ctrl-click, then Delete)
  await page.getByTestId('thumb-3').click();
  await page.getByTestId('thumb-7').click({ modifiers: ['Control'] });
  await page.getByTestId('thumb-10').click({ modifiers: ['Control'] });
  await expect(page.getByText('3 pages selected')).toBeVisible();
  await page.getByTestId('delete-pages').click();
  expect(await stateLabels(page)).toEqual(['A-1', 'A-2', 'A-4', 'A-5', 'A-6', 'A-8', 'B-1', 'B-3', 'B-4', 'B-5', 'B-6']);

  // 3. insert PDF C after page 5, previewing its pages first
  await page.getByTestId('thumb-5').click();
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-pdf').click();
  await chooseFiles(page, () => page.getByTestId('insert-choose').click(), ['C.pdf']);
  await expect(page.getByTestId('prepared-file')).toContainText('2 pages · 2 selected');
  await expect(page.getByTestId('where-page')).toHaveValue('5');
  await page.getByTestId('insert-confirm').click();
  expect(await stateLabels(page)).toEqual(['A-1', 'A-2', 'A-4', 'A-5', 'A-6', 'C-1', 'C-2', 'A-8', 'B-1', 'B-3', 'B-4', 'B-5', 'B-6']);

  // 4. insert a JPG after page 8 (converted to a page automatically)
  await page.getByTestId('thumb-8').click();
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-images').click();
  await chooseFiles(page, () => page.getByTestId('insert-choose').click(), ['scan.jpg']);
  await expect(page.getByTestId('prepared-file')).toBeVisible();
  await page.getByTestId('insert-confirm').click();
  expect(await stateLabels(page)).toEqual(['A-1', 'A-2', 'A-4', 'A-5', 'A-6', 'C-1', 'C-2', 'A-8', '?', 'B-1', 'B-3', 'B-4', 'B-5', 'B-6']);

  // 5. reorder: drag the last page to the very front in the Organize grid
  await page.getByTestId('view-organize').click();
  const grid0 = page.getByTestId('page-list-grid');
  await grid0.getByTestId('thumb-14').dragTo(grid0.getByTestId('thumb-1'), { targetPosition: { x: 6, y: 40 } });
  expect(await stateLabels(page)).toEqual(['B-6', 'A-1', 'A-2', 'A-4', 'A-5', 'A-6', 'C-1', 'C-2', 'A-8', '?', 'B-1', 'B-3', 'B-4', 'B-5']);

  await page.getByTestId('view-edit').click();

  // 6. compress, then keep going in the same document
  const idsBefore = await page.evaluate(() => window.__pdfws!.ctl.state.pages.map((p) => p.id));
  await page.getByTestId('compress-button').click();
  await page.getByTestId('level-balanced').check();
  await page.getByTestId('compress-run').click();
  await expect(page.getByTestId('compress-result')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('compress-result')).toContainText('smaller');
  await page.getByTestId('compress-done').click();
  expect(await page.evaluate(() => window.__pdfws!.ctl.state.pages.map((p) => p.id))).toEqual(idsBefore);

  // 7. open page 12 and zoom in
  await openPage(page, 12);
  const p12 = await pageIdAt(page, 12);
  expect((await stateLabels(page))[11]).toBe('B-3');
  await page.getByTestId('zoom-in').click();
  await page.getByTestId('zoom-in').click();
  await expect(page.getByTestId('zoom-select')).toHaveValue(/%/);
  // Type a custom zoom.
  await page.getByTestId('zoom-select').fill('135');
  await page.getByTestId('zoom-select').press('Enter');
  await expect(page.getByTestId('zoom-select')).toHaveValue('135%');
  // Fit the whole page on screen for drawing.
  await page.getByTestId('zoom-select').fill('Fit page');
  await page.getByTestId('zoom-select').press('Enter');
  await openPage(page, 12);

  // 8. add RED text
  await page.getByTestId('tool-text').click();
  await page.getByTestId('text-color').locator('[data-color="red"]').click();
  const layer = '[data-page-number="12"] .ann-layer';
  const box = (await page.locator(layer).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.25);
  await page.getByTestId('text-editor').fill('RED TEXT ON B3');
  await page.getByTestId('text-editor').press('Escape');
  await expect.poll(async () => (await annotationsOn(page, p12)).length).toBe(1);

  // 9. draw with a 5px pen, then 2px
  await page.getByTestId('tool-pen').click();
  await page.getByTestId('pen-width-5').click();
  await draw(page, layer, [[0.2, 0.45], [0.35, 0.5], [0.5, 0.42], [0.65, 0.5]]);
  await page.getByTestId('pen-width-2').click();
  await draw(page, layer, [[0.2, 0.6], [0.4, 0.66], [0.6, 0.6]]);

  // 10. another annotation: a rectangle
  await page.getByTestId('tool-rect').click();
  await draw(page, layer, [[0.55, 0.7], [0.85, 0.85]]);
  const anns = await annotationsOn(page, p12);
  expect(anns.map((a) => a.type)).toEqual(['text', 'ink', 'ink', 'shape']);
  expect(anns[0]).toMatchObject({ type: 'text', color: '#e11d2a', text: 'RED TEXT ON B3' });
  expect(anns.filter((a) => a.type === 'ink').map((a) => (a as { width: number }).width)).toEqual([5, 2]);

  // undo / redo the rectangle from the header buttons
  await page.getByTestId('undo').click();
  expect((await annotationsOn(page, p12)).length).toBe(3);
  await page.getByTestId('redo').click();
  expect((await annotationsOn(page, p12)).length).toBe(4);

  // 11. back to the organizer: delete another page, insert another PDF at a gap, reorder
  await page.getByTestId('view-organize').click();
  await page.getByTestId('page-list-grid').getByTestId('thumb-2').click();
  await page.getByTestId('delete-pages').click(); // removes A-1
  expect(await pageCount(page)).toBe(13);
  await page.getByTestId('gap-add-2').click();
  await page.getByTestId('menu-insert-pdf').click();
  await chooseFiles(page, () => page.getByTestId('insert-choose').click(), ['D.pdf']);
  await page.getByTestId('pick-2').click(); // untick page 2 of D
  await page.getByTestId('insert-confirm').click();
  expect(await stateLabels(page)).toEqual(['B-6', 'A-2', 'D-1', 'D-3', 'A-4', 'A-5', 'A-6', 'C-1', 'C-2', 'A-8', '?', 'B-1', 'B-3', 'B-4', 'B-5']);
  // the annotated page (now 13) goes to the front by drag and drop in the grid
  const grid = page.getByTestId('page-list-grid');
  await grid.getByTestId('thumb-13').click();
  await grid.getByTestId('thumb-13').dragTo(grid.getByTestId('thumb-1'), { targetPosition: { x: 6, y: 40 } });
  const labels = await stateLabels(page);
  expect(labels[0]).toBe('B-3');
  expect(await pageIdAt(page, 1)).toBe(p12);
  expect((await annotationsOn(page, p12)).length).toBe(4); // annotations followed the page

  // 12. continue editing: highlight on page 1 and rotate the scan
  await page.getByTestId('view-edit').click();
  await openPage(page, 1);
  await page.getByTestId('tool-highlight').click();
  await draw(page, '[data-page-number="1"] .ann-layer', [[0.1, 0.05], [0.5, 0.12]]);
  expect((await annotationsOn(page, p12)).length).toBe(5);
  const scanIndex = labels.indexOf('?') + 1;
  await page.getByTestId('page-list-list').getByTestId(`thumb-${scanIndex}`).click();
  await page.getByTestId('rotate-right').click();

  // 13. export and reopen the downloaded PDF
  const expected = await stateLabels(page);
  await page.getByTestId('export-button').click();
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-run').click();
  const file = await (await dl).path();
  const bytes = new Uint8Array(readFileSync(file!));
  expect(await pageLabels(bytes)).toEqual(expected);
  const texts = await pageTexts(bytes);
  expect(texts[0]).toContain('RED TEXT ON B3');
  expect(texts.filter((t) => t.includes('RED TEXT')).length).toBe(1);
  const c0 = await pageContent(bytes, 0);
  expect(c0).toMatch(/\b5 w\b/);
  expect(c0).toMatch(/\b2 w\b/);
  expect(c0).toMatch(/0\.88\d* 0\.11\d* 0\.16\d* rg/);
  expect((await pageGeometry(bytes))[scanIndex - 1].rotate).toBe(90);
  await expect(page.getByTestId('unexported')).toHaveCount(0);

  // 14. a refresh does not lose the workspace
  await page.waitForFunction(() => window.__pdfws!.ctl.view.saveStatus === 'saved');
  await page.reload();
  await expect(page.getByTestId('thumb-15')).toBeVisible();
  expect(await stateLabels(page)).toEqual(expected);
  expect((await annotationsOn(page, p12)).length).toBe(5);
  // ...and undo history survived the reload too
  await page.getByTestId('undo').click();
  expect((await page.evaluate(() => window.__pdfws!.ctl.state.pages.find((p) => p.rotation === 90)))).toBeUndefined();

  expect(errors).toEqual([]);
});
