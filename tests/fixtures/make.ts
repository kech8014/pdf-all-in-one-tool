/**
 * Deterministic test documents generated on the fly: labelled pages (so page ORDER can be
 * verified by text extraction), mixed page sizes, intrinsic /Rotate, photos for
 * compression, and PNG/JPEG images.
 */
import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from '@cantoo/pdf-lib';
import jpeg from 'jpeg-js';
import { zlibSync } from 'fflate';

export interface LabelledOptions {
  sizes?: [number, number][];
  rotate?: number[];
  title?: string;
}

/** n pages; page i shows the text `${label}-${i + 1}` (e.g. "A-3"). */
export async function labelledPdf(label: string, n: number, opts: LabelledOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < n; i++) {
    const size = opts.sizes?.[i % opts.sizes.length] ?? [612, 792];
    const page = doc.addPage(size);
    page.drawText(`${label}-${i + 1}`, { x: 40, y: size[1] - 80, size: 36, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawRectangle({ x: 30, y: 30, width: size[0] - 60, height: 40, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 2 });
    const r = opts.rotate?.[i];
    if (r) page.setRotation(degrees(r));
  }
  if (opts.title) doc.setTitle(opts.title);
  return doc.save();
}

/** Smooth gradient + deterministic noise: behaves like a photo for JPEG. */
export function photoPixels(w: number, h: number, seed = 7): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const n = (rnd() - 0.5) * 60;
      out[o] = Math.max(0, Math.min(255, (x / w) * 255 + n));
      out[o + 1] = Math.max(0, Math.min(255, (y / h) * 255 + n));
      out[o + 2] = Math.max(0, Math.min(255, 128 + 100 * Math.sin((x + y) / 37) + n));
      out[o + 3] = 255;
    }
  }
  return out;
}

export function jpegBytes(w: number, h: number, quality = 92, seed = 7): Uint8Array {
  return new Uint8Array(jpeg.encode({ data: photoPixels(w, h, seed), width: w, height: h }, quality).data);
}

/** Minimal valid RGBA PNG writer (no external encoder needed). */
export function pngBytes(w: number, h: number, color: [number, number, number, number] = [220, 30, 40, 255]): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      raw.set(color, o);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

/** A PDF with a large high-quality JPEG photo and a large raw (Flate) photo, plus text. */
export async function photoPdf(label = 'P'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedJpg(jpegBytes(2400, 1800, 95));
  const p1 = doc.addPage([612, 792]);
  p1.drawImage(img, { x: 36, y: 200, width: 540, height: 405 });
  p1.drawText(`${label}-1`, { x: 40, y: 740, size: 30, font });
  // Raw RGB image stored with Flate (as many scanners/exporters do).
  const w = 1600;
  const h = 1200;
  const rgba = photoPixels(w, h, 11);
  const rgbData = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) rgbData.set(rgba.subarray(i, i + 3), j);
  const rawRef = doc.context.register(
    doc.context.flateStream(rgbData, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }),
  );
  const p2 = doc.addPage([612, 792]);
  const key = p2.node.newXObject('Raw', rawRef);
  p2.pushOperators(pushGraphicsState(), concatTransformationMatrix(540, 0, 0, 405, 36, 200), drawObject(key), popGraphicsState());
  p2.drawText(`${label}-2`, { x: 40, y: 740, size: 30, font });
  return doc.save();
}

/** Large document for performance tests. */
export async function bigPdf(label: string, n: number): Promise<Uint8Array> {
  return labelledPdf(label, n, { sizes: [[612, 792], [595, 842], [792, 612]] });
}

/** Minimal uncompressed RGB TIFF; several frames make a multi-page TIFF. */
export function tiffBytes(frames: { w: number; h: number; color: [number, number, number] }[]): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 255, (v >> 8) & 255);
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  // header
  parts.push(0x49, 0x49);
  u16(42);
  u32(8);
  let offset = 8;
  frames.forEach((f, idx) => {
    const entries = 11;
    const ifdSize = 2 + entries * 12 + 4;
    const bpsOffset = offset + ifdSize;
    const dataOffset = bpsOffset + 6;
    const dataLen = f.w * f.h * 3;
    const next = idx === frames.length - 1 ? 0 : dataOffset + dataLen;
    const tag = (t: number, type: number, count: number, value: number) => {
      u16(t);
      u16(type);
      u32(count);
      if (type === 3 && count === 1) {
        u16(value);
        u16(0);
      } else u32(value);
    };
    u16(entries);
    tag(256, 4, 1, f.w); // width
    tag(257, 4, 1, f.h); // height
    tag(258, 3, 3, bpsOffset); // bits per sample -> offset
    tag(259, 3, 1, 1); // no compression
    tag(262, 3, 1, 2); // RGB
    tag(273, 4, 1, dataOffset); // strip offset
    tag(277, 3, 1, 3); // samples per pixel
    tag(278, 4, 1, f.h); // rows per strip
    tag(279, 4, 1, dataLen); // strip byte count
    tag(284, 3, 1, 1); // planar config
    tag(296, 3, 1, 2); // resolution unit inch
    u32(next);
    u16(8);
    u16(8);
    u16(8);
    for (let i = 0; i < f.w * f.h; i++) parts.push(...f.color);
    offset = next;
  });
  return new Uint8Array(parts);
}
