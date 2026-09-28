import jpeg from 'jpeg-js';
import type { ImageCodec } from '../../src/engine/compress';
import { downscaleRGBA, toRGBA } from '../../src/engine/resize';
import { createLocalEngine } from '../../src/store/engineApi';
import { MemoryBlobStore } from '../../src/store/blobStore';
import { WorkspaceController } from '../../src/store/controller';

/** Pure-JS codec so compression is testable in Node exactly as the browser runs it. */
export const nodeCodec: ImageCodec = {
  async jpegToJpeg(bytes, tw, th, quality) {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    const data = downscaleRGBA(img.data, img.width, img.height, tw, th);
    return new Uint8Array(jpeg.encode({ data, width: tw, height: th }, Math.round(quality * 100)).data);
  },
  async rawToJpeg(pixels, w, h, channels, tw, th, quality) {
    const rgba = toRGBA(pixels, w, h, channels);
    const data = downscaleRGBA(rgba, w, h, tw, th);
    return new Uint8Array(jpeg.encode({ data, width: tw, height: th }, Math.round(quality * 100)).data);
  },
};

export function newController() {
  const blobs = new MemoryBlobStore();
  const ctl = new WorkspaceController(createLocalEngine(nodeCodec), blobs);
  return { ctl, blobs };
}
