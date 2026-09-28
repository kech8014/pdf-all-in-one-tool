import { expect, test } from '@playwright/test';
import { join } from 'node:path';

const F = (n: string) => join(process.cwd(), 'tests', 'fixtures', 'out', n);

test('smoke: open, add two PDFs, screenshots', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByText('Start your PDF workspace')).toBeVisible();
  await page.screenshot({ path: 'test-results/shot-empty.png' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('empty-choose').click();
  await (await chooser).setFiles([F('A.pdf'), F('B.pdf')]);
  await expect(page.getByTestId('thumb-14')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/shot-loaded.png' });
  await page.getByTestId('view-organize').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/shot-organize.png' });
  console.log('ERRORS', errors);
});
