import { expect, type Page } from '@playwright/test';
import { join } from 'node:path';

export const F = (n: string) => join(process.cwd(), 'tests', 'fixtures', 'out', n);

export async function freshStart(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    indexedDB.deleteDatabase('pdf-workspace');
    localStorage.clear();
  });
  await page.reload();
  await expect(page.getByText('Start your PDF workspace')).toBeVisible();
}

export async function chooseFiles(page: Page, trigger: () => Promise<void>, files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await trigger();
  await (await chooser).setFiles(files.map(F));
}

export async function start(page: Page, files: string[]) {
  await freshStart(page);
  await chooseFiles(page, () => page.getByTestId('empty-choose').click(), files);
  await expect(page.locator('[data-testid^="thumb-"]').first()).toBeVisible();
}

export async function goToPage(page: Page, n: number) {
  await page.getByTestId('page-input').fill(String(n));
  await page.getByTestId('page-input').press('Enter');
  await expect(page.locator(`[data-page-number="${n}"] .ann-layer`)).toBeVisible();
}

export async function layerBox(page: Page, n: number) {
  return (await page.locator(`[data-page-number="${n}"] .ann-layer`).boundingBox())!;
}

/** Drag on page n between fractional page positions. */
export async function drag(page: Page, n: number, from: [number, number], to: [number, number], steps = 8) {
  const b = await layerBox(page, n);
  await page.mouse.move(b.x + from[0] * b.width, b.y + from[1] * b.height);
  await page.mouse.down();
  await page.mouse.move(b.x + to[0] * b.width, b.y + to[1] * b.height, { steps });
  await page.mouse.up();
}

export async function clickAt(page: Page, n: number, at: [number, number], opts: { modifiers?: ('Shift' | 'Control')[]; clickCount?: number } = {}) {
  const b = await layerBox(page, n);
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.click(b.x + at[0] * b.width, b.y + at[1] * b.height, { clickCount: opts.clickCount ?? 1 });
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
}

export const anns = (page: Page, n: number) =>
  page.evaluate((i) => window.__pdfws!.ctl.state.pages[i - 1].annotations, n);

export const labels = (page: Page) =>
  page.evaluate(() => {
    const s = window.__pdfws!.ctl.state;
    return s.pages.map((p) => {
      const src = s.sources[p.sourceId];
      return src.origin === 'image' ? '?' : src.origin === 'blank' ? 'blank' : `${src.name.replace(/\.pdf$/, '')}-${p.sourcePageIndex + 1}`;
    });
  });

export async function download(page: Page, trigger: () => Promise<void>): Promise<Uint8Array> {
  const { readFileSync } = await import('node:fs');
  const dl = page.waitForEvent('download');
  await trigger();
  return new Uint8Array(readFileSync((await (await dl).path())!));
}

export async function dismissToasts(page: Page) {
  await page.evaluate(() => {
    const { ctl } = window.__pdfws!;
    for (const n of ctl.view.notices) ctl.dismiss(n.id);
  });
}
