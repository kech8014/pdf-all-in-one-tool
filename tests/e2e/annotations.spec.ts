import { expect, test } from '@playwright/test';
import { annotationSubtypes, pageContent, pageTexts } from '../helpers/pdf';
import { anns, chooseFiles, clickAt, dismissToasts, download, drag, goToPage, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await start(page, ['A.pdf']);
  await page.getByTestId('zoom-select').fill('Fit page');
  await page.getByTestId('zoom-select').press('Enter');
  await goToPage(page, 1);
});

test('select, move, resize, restyle, edit text and delete annotations', async ({ page }) => {
  // Create a rectangle, then move it with the select tool.
  await page.getByTestId('tool-rect').click();
  await drag(page, 1, [0.2, 0.3], [0.4, 0.4]);
  const [rect] = await anns(page, 1);
  await page.getByTestId('tool-select').click();
  await drag(page, 1, [0.4, 0.35], [0.6, 0.55]); // grab the right edge and move
  const [moved] = await anns(page, 1);
  expect(moved.id).toBe(rect.id);
  expect((moved as { rect: { x: number } }).rect.x).toBeGreaterThan((rect as { rect: { x: number } }).rect.x + 50);

  // Resize from the bottom-right handle.
  const before = (moved as { rect: { w: number } }).rect.w;
  const handle = page.locator('[data-page-number="1"] .ann-handle.h-se');
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 80, hb.y + 40, { steps: 5 });
  await page.mouse.up();
  const [resized] = await anns(page, 1);
  expect((resized as { rect: { w: number } }).rect.w).toBeGreaterThan(before + 40);

  // Restyle the selection: blue border, thicker.
  await page.getByTestId('selection-options').locator('[data-color="blue"]').first().click();
  const [blue] = await anns(page, 1);
  expect((blue as { strokeColor: string }).strokeColor).toBe('#1d4ed8');

  // Text: create, then double-click to edit it later.
  await page.getByTestId('tool-text').click();
  await clickAt(page, 1, [0.15, 0.7]);
  await page.getByTestId('text-editor').fill('first version');
  await page.getByTestId('text-editor').press('Escape');
  await page.getByTestId('tool-select').click();
  await clickAt(page, 1, [0.17, 0.705], { clickCount: 2 });
  await page.getByTestId('text-editor').fill('second version, edited');
  await page.getByTestId('text-editor').press('Escape');
  const list = await anns(page, 1);
  expect(list.map((a) => a.type)).toEqual(['shape', 'text']);
  expect((list[1] as { text: string }).text).toBe('second version, edited');

  // Undo walks back through edit, creation, restyle, resize and move, one step each.
  const labelsNow = await page.evaluate(() => window.__pdfws!.ctl.view.history.entries.map((e) => e.label));
  expect(labelsNow.slice(-6)).toEqual([
    'Added rectangle on page 1',
    'Moved shape',
    'Resized shape',
    'Changed style',
    'Added text on page 1',
    'Edited text',
  ]);
  await page.keyboard.press('Control+z');
  expect(((await anns(page, 1))[1] as { text: string }).text).toBe('first version');

  // Delete with the keyboard.
  await clickAt(page, 1, [0.4, 0.55]);
  await page.keyboard.press('Delete');
  expect((await anns(page, 1)).map((a) => a.type)).toEqual(['text']);
});

test('eraser removes strokes in one undoable step; copy/paste to another page', async ({ page }) => {
  await page.getByTestId('tool-pen').click();
  await drag(page, 1, [0.1, 0.3], [0.5, 0.32]);
  await drag(page, 1, [0.1, 0.5], [0.5, 0.52]);
  await drag(page, 1, [0.1, 0.7], [0.5, 0.72]);
  expect(await anns(page, 1)).toHaveLength(3);
  await page.getByTestId('tool-eraser').click();
  await drag(page, 1, [0.3, 0.2], [0.3, 0.6], 20); // crosses the first two strokes
  expect(await anns(page, 1)).toHaveLength(1);
  await page.getByTestId('undo').click();
  expect(await anns(page, 1)).toHaveLength(3);

  // Copy the remaining strokes and paste onto page 2.
  await page.getByTestId('tool-select').click();
  await page.keyboard.press('Control+a'); // select all annotations on the active page
  await page.keyboard.press('Control+c');
  await goToPage(page, 2);
  await page.keyboard.press('Control+v');
  expect(await anns(page, 2)).toHaveLength(3);
  const p1 = await anns(page, 1);
  const p2 = await anns(page, 2);
  expect(p2.map((a) => a.id)).not.toEqual(p1.map((a) => a.id));
  // Duplicate on the same page.
  await page.keyboard.press('Control+d');
  expect(await anns(page, 2)).toHaveLength(6);
});

test('markup, whiteout, note, image and signature all export', async ({ page }) => {
  await page.getByTestId('tool-highlight').click();
  await drag(page, 1, [0.05, 0.07], [0.3, 0.12]);
  await page.getByTestId('tool-underline').click();
  await drag(page, 1, [0.05, 0.07], [0.3, 0.12]);
  await page.getByTestId('tool-strikeout').click();
  await drag(page, 1, [0.05, 0.07], [0.3, 0.12]);
  await page.getByTestId('tool-whiteout').click();
  await drag(page, 1, [0.05, 0.9], [0.95, 0.97]);
  await page.getByTestId('tool-note').click();
  await clickAt(page, 1, [0.8, 0.2]);
  await page.getByTestId('note-editor').locator('textarea').fill('Reviewer comment');
  await page.getByTestId('note-editor').getByText('Done').click();

  // Image: choose a PNG, then click to place it.
  await chooseFiles(page, () => page.getByTestId('tool-image').click(), ['logo.png']);
  await clickAt(page, 1, [0.5, 0.5]);
  // Signature: draw, then place.
  await page.getByTestId('tool-signature').click();
  const pad = (await page.getByTestId('signature-pad').boundingBox())!;
  await page.mouse.move(pad.x + 50, pad.y + 60);
  await page.mouse.down();
  for (let i = 0; i < 15; i++) await page.mouse.move(pad.x + 50 + i * 25, pad.y + 60 + (i % 2) * 40);
  await page.mouse.up();
  await page.getByTestId('signature-use').click();
  await clickAt(page, 1, [0.6, 0.8]);

  const types = (await anns(page, 1)).map((a) => a.type);
  expect(types).toEqual(['highlight', 'line', 'line', 'whiteout', 'note', 'image', 'image']);
  const lines = (await anns(page, 1)).filter((a) => a.type === 'line').map((a) => (a as { style: string }).style);
  expect(lines).toEqual(['underline', 'strikeout']);

  await dismissToasts(page);
  await page.getByTestId('export-button').click();
  const bytes = await download(page, () => page.getByTestId('export-run').click());
  expect(await annotationSubtypes(bytes, 0)).toEqual(['/Text']);
  const content = await pageContent(bytes, 0);
  expect((content.match(/\bDo\b/g) ?? []).length).toBeGreaterThanOrEqual(2); // two placed images
  expect(content).toMatch(/\/GS\S* gs/); // highlight blend state
  expect((await pageTexts(bytes))[0]).toContain('A-1'); // original text preserved under the markup
});
