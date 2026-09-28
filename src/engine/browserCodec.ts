import type { ImageCodec } from './compress';
import { toRGBA } from './resize';

/**
 * Browser implementation of the compression codec: the platform's own JPEG decoder,
 * high-quality resampler and encoder, available in workers via OffscreenCanvas.
 */
async function bitmap(source: Blob | ImageData, tw: number, th: number): Promise<ImageBitmap> {
  const opts: ImageBitmapOptions = { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high', premultiplyAlpha: 'none' };
  try {
    // PDF viewers ignore EXIF orientation, so the pixels must stay as stored.
    return await createImageBitmap(source, { ...opts, imageOrientation: 'none' as ImageOrientation });
  } catch {
    return createImageBitmap(source, opts);
  }
}

async function encodeJpeg(bmp: ImageBitmap, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

export const browserCodec: ImageCodec = {
  async jpegToJpeg(bytes, tw, th, quality) {
    try {
      return await encodeJpeg(await bitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), tw, th), quality);
    } catch {
      return null;
    }
  },
  async rawToJpeg(pixels, w, h, channels, tw, th, quality) {
    try {
      const rgba = toRGBA(pixels, w, h, channels);
      return await encodeJpeg(await bitmap(new ImageData(rgba as ImageDataArray, w, h), tw, th), quality);
    } catch {
      return null;
    }
  },
};
