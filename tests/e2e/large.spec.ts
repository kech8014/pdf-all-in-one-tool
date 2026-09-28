import { expect, test } from '@playwright/test';
import { pageLabels } from '../helpers/pdf';
import { download, goToPage, labels, start } from './helpers';

test('a 300-page document stays responsive', async ({ page }) => {
  const t0 = Date.now();
  await start(page, ['big.pdf']);
  await expect(page.getByTestId('thumb-300')).toBeAttached();
  const loadMs = Date.now() - t0;
  await expect(page.locator('[data-page-number="1"] canvas')).toBeVisible();

  // Virtualization: only pages near the viewport are mounted in the viewer.
  expect(await page.locator('.page-view').count()).toBeLessThan(12);

  // Jump deep into the document; the page renders promptly.
  const t1 = Date.now();
  await goToPage(page, 250);
  await expect(page.locator('[data-page-number="250"] .page-loading')).toHaveCount(0, { timeout: 10_000 });
  const jumpMs = Date.now() - t1;

  // Bulk operations on hundreds of pages.
  const t2 = Date.now();
  await page.keyboard.press('Escape');
  await page.getByTestId('page-list-list').click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => window.__pdfws!.ctl.selectAll());
  await page.getByTestId('rotate-right').click();
  await page.getByTestId('undo').click();
  await page.evaluate(() => {
    const ctl = window.__pdfws!.ctl;
    ctl.select(ctl.state.pages.slice(0, 100).map((p) => p.id));
  });
  await page.getByTestId('delete-pages').click();
  expect(await labels(page)).toHaveLength(200);
  const bulkMs = Date.now() - t2;

  // Scroll through the viewer quickly; the page must not lock up.
  const t3 = Date.now();
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 2500);
  const probe = await page.evaluate(() => new Promise<number>((r) => { const s = performance.now(); requestAnimationFrame(() => r(performance.now() - s)); }));
  const scrollMs = Date.now() - t3;

  await page.getByTestId('export-button').click();
  const t4 = Date.now();
  const bytes = await download(page, () => page.getByTestId('export-run').click());
  const exportMs = Date.now() - t4;
  const out = await pageLabels(bytes);
  expect(out).toHaveLength(200);
  expect(out[0]).toBe('L-101');

  console.log(`load ${loadMs}ms · jump ${jumpMs}ms · bulk ${bulkMs}ms · scroll ${scrollMs}ms (frame ${probe.toFixed(0)}ms) · export ${exportMs}ms`);
  expect(loadMs).toBeLessThan(20_000);
  expect(bulkMs).toBeLessThan(10_000);
  expect(probe).toBeLessThan(500);
});
