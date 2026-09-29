import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { pageGeometry, pageLabels } from '../helpers/pdf';
import { F, chooseFiles, download, labels, start } from './helpers';

const list = (page: Page) => page.getByTestId('page-list-list');

test('range selection, keyboard moves, duplicate, rotate, blank page and extract', async ({ page }) => {
  await start(page, ['A.pdf']);
  await list(page).getByTestId('thumb-2').click();
  await list(page).getByTestId('thumb-4').click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 pages selected')).toBeVisible();
  // Alt+Up moves the selected block up by one.
  await list(page).press('Alt+ArrowUp');
  expect(await labels(page)).toEqual(['A-2', 'A-3', 'A-4', 'A-1', 'A-5', 'A-6', 'A-7', 'A-8']);
  await page.getByTestId('duplicate').click();
  expect(await labels(page)).toEqual(['A-2', 'A-2', 'A-3', 'A-3', 'A-4', 'A-4', 'A-1', 'A-5', 'A-6', 'A-7', 'A-8']);
  await page.getByTestId('undo').click();
  // Rotate via the thumbnail's hover action.
  await list(page).getByTestId('thumb-1').hover();
  await list(page).getByTestId('thumb-1').getByLabel('Rotate page 1 right').click();
  // Blank page through the gap "+" right-click menu, before page 1.
  await list(page).getByTestId('gap-add-0').click({ button: 'right' });
  await page.getByText('Insert blank page').click();
  await expect.poll(async () => (await labels(page))[0]).toBe('blank'); // created in the background worker
  // Keyboard delete in the organizer.
  await list(page).getByTestId('thumb-1').click();
  await list(page).press('Delete');
  expect((await labels(page))[0]).toBe('A-2');
  // Extract (download) the selected pages without changing the workspace.
  await list(page).getByTestId('thumb-1').click();
  await list(page).getByTestId('thumb-2').click({ modifiers: ['Control'] });
  await page.getByTestId('more-menu').click();
  const bytes = await download(page, () => page.getByText('Download 2 pages as a new PDF').click());
  expect(await pageLabels(bytes)).toEqual(['A-2', 'A-3']);
  expect((await pageGeometry(bytes))[0].rotate).toBe(90);
  expect(await labels(page)).toHaveLength(8);
});

test('replace a page, and drop a file into an exact gap', async ({ page }) => {
  await start(page, ['A.pdf']);
  // Replace page 3 with page 2 of D.pdf through the context menu.
  await list(page).getByTestId('thumb-3').click({ button: 'right' });
  await page.getByText('Replace page…').click();
  await chooseFiles(page, () => page.getByTestId('insert-choose').click(), ['D.pdf']);
  await page.getByTestId('pick-2').click();
  await page.getByTestId('insert-confirm').click();
  expect(await labels(page)).toEqual(['A-1', 'A-2', 'D-2', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8']);

  // Drop E.pdf between pages 2 and 3 of the organizer.
  const b64 = readFileSync(F('E.pdf')).toString('base64');
  const dt = await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], 'E.pdf', { type: 'application/pdf' }));
    return dt;
  }, b64);
  const gap = list(page).locator('[data-gap-index="2"]');
  await gap.dispatchEvent('dragover', { dataTransfer: dt });
  await gap.dispatchEvent('drop', { dataTransfer: dt });
  await expect.poll(() => labels(page)).toEqual(['A-1', 'A-2', 'E-1', 'E-2', 'D-2', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8']);
});

test('images: WebP and multi-page TIFF become pages, also after compression', async ({ page }) => {
  await start(page, ['C.pdf']);
  await page.getByTestId('compress-button').click();
  await page.getByTestId('compress-run').click();
  await expect(page.getByTestId('compress-result')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('compress-done').click();

  const webp = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0a7';
    g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#fff';
    g.font = '40px sans-serif';
    g.fillText('WEBP', 90, 110);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/webp', 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-images').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('insert-choose').click();
  await (await chooser).setFiles([
    { name: 'photo.webp', mimeType: 'image/webp', buffer: Buffer.from(webp) },
    { name: 'pages.tiff', mimeType: 'image/tiff', buffer: readFileSync(F('pages.tiff')) },
  ]);
  await expect(page.getByTestId('prepared-file')).toHaveCount(2);
  await page.getByTestId('insert-confirm').click();
  expect(await labels(page)).toEqual(['C-1', '?', '?', '?', 'C-2']);
  const sizes = await page.evaluate(() => {
    const s = window.__pdfws!.ctl.state;
    return s.pages.map((p) => s.sources[p.sourceId].pages[p.sourcePageIndex]).map((i) => `${Math.round(i.width)}x${Math.round(i.height)}`);
  });
  // Page shape follows each image: 320x200 px, 300x400 px, 400x300 px at 96 DPI.
  expect(sizes.slice(1, 4)).toEqual(['240x150', '225x300', '300x225']);
  await page.getByTestId('export-button').click();
  const bytes = await download(page, () => page.getByTestId('export-run').click());
  expect(await pageGeometry(bytes)).toHaveLength(5);
});

test('clear errors: damaged PDF, unsupported file, password-protected PDF', async ({ page }) => {
  await start(page, ['A.pdf']);
  await chooseFiles(page, () => page.getByTestId('add-files').click(), ['broken.pdf', 'notes.txt']);
  await expect(page.getByTestId('toast-error')).toHaveCount(2);
  await expect(page.getByText('"broken.pdf" could not be read')).toBeVisible();
  await expect(page.getByText('"notes.txt" is not a PDF or a supported image.')).toBeVisible();
  expect(await labels(page)).toHaveLength(8); // nothing half-added

  await chooseFiles(page, () => page.getByTestId('add-files').click(), ['locked.pdf']);
  const dialog = page.getByTestId('insert-dialog');
  await expect(dialog.getByText('is password protected')).toBeVisible();
  await dialog.getByLabel('Password for locked.pdf').fill('wrong');
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(dialog.getByText('password for "locked.pdf" is not correct')).toBeVisible();
  await dialog.getByLabel('Password for locked.pdf').fill('secret');
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByTestId('prepared-file')).toContainText('locked.pdf');
  await page.getByTestId('insert-confirm').click();
  expect(await labels(page)).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'locked-1', 'locked-2']);
});
