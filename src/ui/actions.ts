import { documentGroups } from '../core/operations';
import type { PageId } from '../core/types';
import type { InputFile, WorkspaceController } from '../store/controller';
import { ui } from './uiStore';

/** Shared user actions used by toolbars, menus, keyboard shortcuts and drag-and-drop. */

export const ACCEPT_ANY = 'application/pdf,.pdf,image/*,.tif,.tiff,.heic,.avif';
export const ACCEPT_PDF = 'application/pdf,.pdf';
export const ACCEPT_IMAGES = 'image/*,.tif,.tiff,.heic,.avif';

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function readFiles(files: File[]): Promise<InputFile[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

/**
 * Add files at an exact position (drag-and-drop, "Add files"). Password-protected PDFs
 * open the insert dialog so the user can type the password.
 */
export async function importFilesAt(ctl: WorkspaceController, files: File[], index: number) {
  if (!files.length) return;
  const inputs = await readFiles(files);
  const { failures } = await ctl.addFiles(inputs, index);
  const locked = failures.filter((f) => f.needsPassword);
  if (locked.length) {
    const lockedFiles = files.filter((f) => locked.some((l) => l.name === f.name));
    ui.openDialog({ kind: 'insert', index, mode: 'insert', accept: 'any', files: lockedFiles });
  }
}

/**
 * Add files from "Add files", Ctrl+O, the start screen or a drop onto the window. When
 * the document then holds more than one file, show "Organize PDFs" so the files can be
 * put in order before working with pages. (Inserting at an exact gap between pages stays
 * in the page view: there the position was already chosen.)
 */
export async function addFilesAndOrganize(ctl: WorkspaceController, files: File[], index: number) {
  if (!files.length) return;
  const before = ctl.state.pages.length;
  await importFilesAt(ctl, files, index);
  if (ctl.state.pages.length > before && documentGroups(ctl.state).length > 1) ui.set({ view: 'files' });
}

export function insertionIndexAfterActive(ctl: WorkspaceController): number {
  const id = ctl.view.activePageId;
  const i = id ? ctl.state.pages.findIndex((p) => p.id === id) : -1;
  return i < 0 ? ctl.state.pages.length : i + 1;
}

export function downloadBytes(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function safeFileName(name: string) {
  return (name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'document').slice(0, 120);
}

export function deletePagesWithUndo(ctl: WorkspaceController, ids: PageId[]) {
  if (!ids.length) return;
  ctl.deletePages(ids);
  ctl.notify('info', ids.length === 1 ? 'Page deleted.' : `${ids.length} pages deleted.`, undefined, { label: 'Undo', run: () => ctl.undo() });
}

export async function extractPages(ctl: WorkspaceController, ids: PageId[]) {
  if (!ids.length) return;
  const bytes = await ctl.exportPdf({ pageIds: ids });
  if (bytes) {
    downloadBytes(bytes, `${safeFileName(ctl.state.name)} - ${ids.length === 1 ? `page ${ctl.pageNumber(ids[0])}` : `${ids.length} pages`}.pdf`);
    ctl.notify('success', `Downloaded ${ids.length} page${ids.length === 1 ? '' : 's'} as a new PDF. Your workspace is unchanged.`);
  }
}
