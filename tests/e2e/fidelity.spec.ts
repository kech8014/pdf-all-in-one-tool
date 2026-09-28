import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { join } from 'node:path';

const F = (n: string) => join(process.cwd(), 'tests', 'fixtures', 'out', n);

async function drawOn(page: Page, n: number, tool: string, from: [number, number], to: [number, number]) {
  await page.getByTestId(`tool-${tool}`).click();
  const box = (await page.locator(`[data-page-number="${n}"] .ann-layer`).boundingBox())!;
  await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 8 });
  await page.mouse.up();
}

test('what you see is what you export (incl. rotated pages)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { indexedDB.deleteDatabase('pdf-workspace'); localStorage.clear(); });
  await page.reload();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('empty-choose').click();
  await (await chooser).setFiles([F('B.pdf')]); // page 2 of B has an intrinsic 90° rotation
  await expect(page.getByTestId('thumb-6')).toBeVisible();
  await page.getByTestId('zoom-select').fill('Fit page');
  await page.getByTestId('zoom-select').press('Enter');

  for (const n of [1, 2]) {
    await page.getByTestId('page-input').fill(String(n));
    await page.getByTestId('page-input').press('Enter');
    await drawOn(page, n, 'rect', [0.15, 0.3], [0.5, 0.45]);
    await drawOn(page, n, 'pen', [0.2, 0.6], [0.7, 0.7]);
    await drawOn(page, n, 'arrow', [0.6, 0.2], [0.85, 0.35]);
    await page.getByTestId('tool-text').click();
    const box = (await page.locator(`[data-page-number="${n}"] .ann-layer`).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.15);
    await page.getByTestId('text-editor').fill(`Upright text on page ${n}`);
    await page.getByTestId('text-editor').press('Escape');
  }
  // Rotate page 1 after annotating: the annotations must turn with it.
  await page.getByTestId('page-list-list').getByTestId('thumb-1').click();
  await page.getByTestId('rotate-right').click();

  await page.getByTestId('export-button').click();
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-run').click();
  const out = join(process.cwd(), 'tests', 'fixtures', 'out', 'exported.pdf');
  writeFileSync(out, readFileSync((await (await dl).path())!));

  // Put the exported pages right after the originals and compare them on screen.
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-pdf').click();
  const c2 = page.waitForEvent('filechooser');
  await page.getByTestId('insert-choose').click();
  await (await c2).setFiles([out]);
  await page.getByTestId('where-page').fill('2');
  await page.getByTestId('insert-confirm').click();
  await page.getByTestId('view-organize').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/fidelity-grid.png' });
  await page.getByTestId('view-edit').click();
  await page.getByTestId('zoom-select').fill('Fit page');
  await page.getByTestId('zoom-select').press('Enter');
  await page.getByTestId('tool-select').click();
  await page.evaluate(() => {
    const { ctl, ui } = window.__pdfws!;
    for (const n of ctl.view.notices) ctl.dismiss(n.id);
    ctl.clearSelection();
    ui.clearAnns();
  });
  const shots: Record<number, PNG> = {};
  for (const n of [1, 3, 2, 4]) {
    await page.getByTestId('page-input').fill(String(n));
    await page.getByTestId('page-input').press('Enter');
    await page.waitForTimeout(800);
    const buf = await page.locator(`[data-page-number="${n}"]`).screenshot({ path: `test-results/fidelity-${n}.png` });
    shots[n] = PNG.sync.read(buf);
  }
  // The on-screen editor (original page + live annotation overlay) and the exported page
  // must look the same: count pixels that differ noticeably.
  for (const [a, b] of [[1, 3], [2, 4]]) {
    const A = shots[a];
    const B = shots[b];
    expect(Math.abs(A.width - B.width)).toBeLessThanOrEqual(2);
    const w = Math.min(A.width, B.width);
    const h = Math.min(A.height, B.height);
    let diff = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * A.width + x) * 4;
        const j = (y * B.width + x) * 4;
        const d = Math.abs(A.data[i] - B.data[j]) + Math.abs(A.data[i + 1] - B.data[j + 1]) + Math.abs(A.data[i + 2] - B.data[j + 2]);
        if (d > 150) diff++;
      }
    }
    const ratio = diff / (w * h);
    console.log(`page ${a} vs exported page ${b}: ${(ratio * 100).toFixed(2)}% pixels differ`);
    expect(ratio).toBeLessThan(0.01);
  }
});
