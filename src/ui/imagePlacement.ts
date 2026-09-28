import { readImageInfo, sniffMime } from '../engine/imageInfo';
import type { WorkspaceController } from '../store/controller';
import { ui } from './uiStore';

/**
 * Turn a picture the user picked into something that looks identical on screen and in
 * the exported PDF. PNG and upright JPEG are used as-is; EXIF-rotated JPEGs (phone
 * photos) and other formats are redrawn once so no viewer can show them differently.
 */
export async function prepareImage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; width: number; height: number }> {
  const mime = sniffMime(bytes);
  if (mime === 'image/png' || mime === 'image/jpeg') {
    const info = readImageInfo(bytes);
    if (info.orientation === 1 && info.components !== 4) return { bytes, mime, width: info.width, height: info.height };
  }
  if (!mime || !mime.startsWith('image/')) throw new Error('This file is not an image.');
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  const outMime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), outMime, 0.95));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: outMime, width: canvas.width, height: canvas.height };
}

export async function stageImageForPlacement(ctl: WorkspaceController, bytes: Uint8Array, signature: boolean) {
  try {
    const img = await prepareImage(bytes);
    const blobId = await ctl.storeImage(img.bytes);
    const previewUrl = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime }));
    ui.set({ pendingImage: { blobId, mime: img.mime, width: img.width, height: img.height, signature, previewUrl }, tool: 'image', selectedAnns: null });
  } catch (err) {
    ctl.notify('error', 'That image could not be used.', err instanceof Error ? err.message : String(err));
  }
}
