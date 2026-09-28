import { expect, test } from '@playwright/test';
import { chooseFiles, labels, start } from './helpers';

test('several workspaces: create, switch, copy and move pages between them', async ({ page }) => {
  await start(page, ['A.pdf']);
  await expect(page.getByTestId('workspace-name')).toHaveValue('A');
  const firstId = await page.evaluate(() => window.__pdfws!.ctl.state.id);

  // A second workspace.
  await page.getByTestId('workspaces-button').click();
  await page.getByTestId('new-workspace').click();
  await expect(page.getByText('Start your PDF workspace')).toBeVisible();
  await chooseFiles(page, () => page.getByTestId('empty-choose').click(), ['D.pdf']);
  await expect(page.getByTestId('workspace-name')).toHaveValue('D');
  const secondId = await page.evaluate(() => window.__pdfws!.ctl.state.id);
  expect(secondId).not.toBe(firstId);

  // Move pages 1 and 2 of D into workspace A.
  await page.getByTestId('page-list-list').getByTestId('thumb-1').click();
  await page.getByTestId('page-list-list').getByTestId('thumb-2').click({ modifiers: ['Shift'] });
  await page.getByTestId('more-menu').click();
  await page.getByText('Copy / move 2 pages to another workspace…').click();
  await page.getByLabel('To workspace').selectOption({ label: 'A (8 pages)' });
  await page.getByLabel('Remove them from this workspace (move instead of copy)').check();
  await page.getByRole('button', { name: 'Move 2 pages' }).click();
  await expect.poll(() => labels(page)).toEqual(['D-3']); // the transfer writes to storage first

  // Switch back to A: it now ends with D-1, D-2.
  await page.getByTestId('workspaces-button').click();
  await page.getByTestId('workspaces-dialog').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('workspace-name')).toHaveValue('A');
  expect(await labels(page)).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'D-1', 'D-2']);

  // Refresh reopens the workspace that was open last.
  await page.waitForFunction(() => window.__pdfws!.ctl.view.saveStatus === 'saved');
  await page.reload();
  await expect(page.getByTestId('workspace-name')).toHaveValue('A');
  expect(await labels(page)).toHaveLength(10);
});
