import UTIF from 'utif';
import { WorkspaceError } from '../core/errors';
import type { ImageNormalizer } from '../store/engineApi';

/**
 * Convert any image the browser can decode into bytes PDF can embed directly.
 * JPEG and PNG pass through untouched (no quality loss); everything else becomes a
 * lossless PNG. Multi-page TIFFs yield one image per page.
 */

const MAX_PIXELS = 120_000_000;

async function pngFromRGBA(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

async function pngFromBitmap(bmp: ImageBitmap): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

export const browserNormalizer: ImageNormalizer = async (bytes, mime, name) => {
  if (mime === 'image/jpeg' || mime === 'image/png') return [bytes];
  if (mime === 'image/svg+xml') {
    throw new WorkspaceError('UNSUPPORTED_FILE', `"${name}" is an SVG drawing. Save it as PNG or PDF first.`);
  }
  if (mime === 'image/tiff') {
    try {
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const ifds = UTIF.decode(buf).filter((ifd) => (ifd as { t256?: unknown }).t256 !== undefined);
      const out: Uint8Array[] = [];
      for (const ifd of ifds) {
        UTIF.decodeImage(buf, ifd);
        if (ifd.width * ifd.height > MAX_PIXELS) throw new Error('image is too large');
        out.push(await pngFromRGBA(UTIF.toRGBA8(ifd), ifd.width, ifd.height));
      }
      if (!out.length) throw new Error('no images in file');
      return out;
    } catch (err) {
      throw new WorkspaceError('IMAGE_DECODE', `"${name}" could not be read as a TIFF image.`, String(err));
    }
  }
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    if (bmp.width * bmp.height > MAX_PIXELS) throw new Error('image is too large');
    return [await pngFromBitmap(bmp)];
  } catch (err) {
    const hint = mime === 'image/heic' ? ' HEIC photos are not supported by this browser; export them as JPEG first.' : '';
    throw new WorkspaceError('IMAGE_DECODE', `"${name}" could not be decoded by this browser.${hint}`, String(err));
  }
};
