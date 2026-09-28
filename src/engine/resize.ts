/**
 * Area-averaging downscale for RGBA pixels. Used by the test codec and as a fallback
 * where the browser cannot resize for us.
 */
export function downscaleRGBA(src: Uint8Array | Uint8ClampedArray, w: number, h: number, tw: number, th: number): Uint8Array {
  if (tw >= w && th >= h) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  const out = new Uint8Array(tw * th * 4);
  const sx = w / tw;
  const sy = h / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const o = (yy * w + xx) * 4;
          r += src[o];
          g += src[o + 1];
          b += src[o + 2];
          a += src[o + 3];
          n++;
        }
      }
      const o = (y * tw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** Expand 1- or 3-channel 8-bit pixels to RGBA. */
export function toRGBA(pixels: Uint8Array, w: number, h: number, channels: 1 | 3): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += channels) {
    const o = i * 4;
    if (channels === 1) {
      out[o] = out[o + 1] = out[o + 2] = pixels[j];
    } else {
      out[o] = pixels[j];
      out[o + 1] = pixels[j + 1];
      out[o + 2] = pixels[j + 2];
    }
    out[o + 3] = 255;
  }
  return out;
}
