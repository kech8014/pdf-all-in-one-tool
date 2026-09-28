import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { zlibSync } from 'fflate';
import { WorkspaceError } from '../core/errors';
import type { CompressionLevel, SourcePageInfo } from '../core/types';
import { readImageInfo } from './imageInfo';
import { describePages } from './ingest';
import { unpredict } from './predictor';

/**
 * Compression of ONE source PDF, producing a new PDF with exactly the same pages in the
 * same order and the same geometry. The workspace swaps the source's blob for the result
 * (operations.replaceSourceBlob), so page order, inserted pages, rotation, annotations
 * and history are untouched, and the user keeps editing the compressed document.
 *
 *   lossless  garbage-collect unused objects, deflate uncompressed streams, pack
 *             objects into compressed object streams. Pixel-identical output.
 *   balanced  + downsample photos to 150 DPI of the largest page, JPEG quality 72.
 *   strong    + downsample photos to 96 DPI, JPEG quality 55.
 *
 * Text, vector drawings and fonts are never rasterized at any level.
 */

export interface ImageCodec {
  /** Re-encode a JPEG at (tw x th). Must NOT apply EXIF orientation. null = cannot. */
  jpegToJpeg(bytes: Uint8Array, tw: number, th: number, quality: number): Promise<Uint8Array | null>;
  /** Encode 8-bit gray (1 channel) or RGB (3 channels) pixels as a JPEG at (tw x th). */
  rawToJpeg(pixels: Uint8Array, w: number, h: number, channels: 1 | 3, tw: number, th: number, quality: number): Promise<Uint8Array | null>;
}

export const COMPRESSION_LEVELS: Record<CompressionLevel, { label: string; hint: string; dpi: number | null; quality: number }> = {
  lossless: { label: 'Lossless', hint: 'Removes unused data and packs the file. No visible change.', dpi: null, quality: 1 },
  balanced: { label: 'Balanced', hint: 'Photos resized to 150 DPI. Good for email and screen reading.', dpi: 150, quality: 0.72 },
  strong: { label: 'Strong', hint: 'Photos resized to 96 DPI. Smallest file, lower image quality.', dpi: 96, quality: 0.55 },
};

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  imagesRecompressed: number;
  /** False when the result was not smaller and the original is kept. */
  changed: boolean;
}

export type CompressProgress = (done: number, total: number) => void;

/** Images smaller than this (stream bytes) are not worth recompressing. */
const MIN_IMAGE_BYTES = 16 * 1024;
/** A recompressed image must be at least this much smaller to replace the original. */
const MIN_GAIN = 0.85;

export async function compressPdf(
  bytes: Uint8Array,
  level: CompressionLevel,
  codec: ImageCodec | null,
  onProgress?: CompressProgress,
): Promise<CompressResult> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (err) {
    throw new WorkspaceError('COMPRESS_FAILED', 'The document could not be read for compression.', String(err));
  }
  const pagesBefore = describePages(src);
  const settings = COMPRESSION_LEVELS[level];
  let imagesRecompressed = 0;

  if (settings.dpi && codec) {
    const maxInches = Math.max(...pagesBefore.map((p) => Math.max(p.width, p.height) / 72));
    const maxDim = Math.max(256, Math.ceil(maxInches * settings.dpi));
    const candidates = collectImages(src);
    let done = 0;
    for (const { ref, stream } of candidates) {
      onProgress?.(done++, candidates.length);
      try {
        const replaced = await recompressImage(src, stream, maxDim, settings.quality, codec);
        if (replaced) {
          src.context.assign(ref, replaced);
          imagesRecompressed++;
        }
      } catch {
        // An image we cannot re-encode is simply left as it was.
      }
    }
    onProgress?.(candidates.length, candidates.length);
  }

  // Rebuild: copying the pages into a fresh document drops every unreachable object.
  const out = await PDFDocument.create({ updateMetadata: false });
  const copied = await out.copyPages(src, pagesBefore.map((_, i) => i));
  for (const p of copied) out.addPage(p);
  deflateUncompressedStreams(out);
  const result = await out.save({ useObjectStreams: true, addDefaultPage: false });

  await verifySamePages(result, pagesBefore);
  if (result.byteLength >= bytes.byteLength) {
    return { bytes, before: bytes.byteLength, after: bytes.byteLength, imagesRecompressed: 0, changed: false };
  }
  return { bytes: result, before: bytes.byteLength, after: result.byteLength, imagesRecompressed, changed: true };
}

async function verifySamePages(bytes: Uint8Array, expected: SourcePageInfo[]) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const got = describePages(doc);
  const ok =
    got.length === expected.length &&
    got.every((p, i) => Math.abs(p.width - expected[i].width) < 0.05 && Math.abs(p.height - expected[i].height) < 0.05 && p.rotation === expected[i].rotation);
  if (!ok) {
    throw new WorkspaceError('COMPRESS_FAILED', 'Compression changed the page layout, so the original was kept.', `expected ${expected.length} pages, got ${got.length}`);
  }
}

/* --------------------------------- images -------------------------------- */

interface Candidate {
  ref: PDFRef;
  stream: PDFRawStream;
}

function isImage(dict: PDFDict): boolean {
  return dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image');
}

function collectImages(doc: PDFDocument): Candidate[] {
  const masks = new Set<string>();
  const out: Candidate[] = [];
  const objects = doc.context.enumerateIndirectObjects();
  for (const [, obj] of objects) {
    if (!(obj instanceof PDFStream) || !isImage(obj.dict)) continue;
    for (const key of ['SMask', 'Mask']) {
      const v = obj.dict.get(PDFName.of(key));
      if (v instanceof PDFRef) masks.add(v.toString());
    }
  }
  for (const [ref, obj] of objects) {
    if (obj instanceof PDFRawStream && isImage(obj.dict) && !masks.has(ref.toString()) && obj.contents.byteLength >= MIN_IMAGE_BYTES) {
      out.push({ ref, stream: obj });
    }
  }
  return out;
}

function num(dict: PDFDict, key: string): number | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

function filters(dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of('Filter'));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : '?'));
  return [];
}

/** 1 = gray, 3 = RGB, 0 = a colour space we do not convert. */
function channelsOf(dict: PDFDict): 0 | 1 | 3 {
  const cs = dict.lookup(PDFName.of('ColorSpace'));
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    return n === 'DeviceRGB' || n === 'CalRGB' ? 3 : n === 'DeviceGray' || n === 'CalGray' ? 1 : 0;
  }
  if (cs instanceof PDFArray && cs.size() >= 1) {
    const kind = cs.lookup(0);
    if (!(kind instanceof PDFName)) return 0;
    const k = kind.decodeText();
    if (k === 'CalRGB') return 3;
    if (k === 'CalGray') return 1;
    if (k === 'ICCBased') {
      const icc = cs.lookup(1);
      if (icc instanceof PDFStream) {
        const n = icc.dict.lookup(PDFName.of('N'));
        if (n instanceof PDFNumber) return n.asNumber() === 3 ? 3 : n.asNumber() === 1 ? 1 : 0;
      }
    }
  }
  return 0;
}

async function recompressImage(
  doc: PDFDocument,
  stream: PDFRawStream,
  maxDim: number,
  quality: number,
  codec: ImageCodec,
): Promise<PDFRawStream | null> {
  const d = stream.dict;
  const w = num(d, 'Width');
  const h = num(d, 'Height');
  if (!w || !h || w < 64 || h < 64) return null;
  if (d.lookup(PDFName.of('ImageMask')) === PDFBool.True) return null;
  if (d.has(PDFName.of('Decode')) || d.lookup(PDFName.of('Mask')) instanceof PDFArray) return null;
  if (d.has(PDFName.of('SMaskInData'))) return null;
  const channels = channelsOf(d);
  if (channels === 0) return null;

  const scale = Math.min(1, maxDim / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const f = filters(d);
  let jpeg: Uint8Array | null = null;

  if (f.length === 1 && f[0] === 'DCTDecode') {
    const info = readImageInfo(stream.contents);
    if (info.components === 4) return null; // CMYK JPEGs decode inconsistently across browsers
    jpeg = await codec.jpegToJpeg(stream.contents, tw, th, quality);
  } else if (f.every((x) => ['FlateDecode', 'LZWDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode'].includes(x))) {
    if (num(d, 'BitsPerComponent') !== 8) return null;
    let raw = decodePDFRawStream(stream).decode();
    const parms = d.lookup(PDFName.of('DecodeParms'));
    const last = parms instanceof PDFArray ? parms.lookup(parms.size() - 1) : parms;
    if (last instanceof PDFDict) {
      const predictor = last.lookup(PDFName.of('Predictor'));
      if (predictor instanceof PDFNumber && predictor.asNumber() > 1) {
        raw = unpredict(raw, predictor.asNumber(), channels, 8, w);
      }
    }
    if (raw.byteLength < w * h * channels) return null;
    if (isFlatGraphic(raw, channels)) return null; // line art/screenshots: JPEG would blur them
    jpeg = await codec.rawToJpeg(raw.subarray(0, w * h * channels), w, h, channels, tw, th, quality);
  } else {
    return null;
  }

  if (!jpeg || jpeg.byteLength > stream.contents.byteLength * MIN_GAIN) return null;
  const dict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: tw,
    Height: th,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  });
  for (const key of ['SMask', 'Intent', 'Interpolate', 'OC', 'StructParent', 'Metadata']) {
    const v = d.get(PDFName.of(key));
    if (v !== undefined) dict.set(PDFName.of(key), v);
  }
  return PDFRawStream.of(dict, jpeg);
}

/** Few distinct colours in a sample = a graphic, not a photo. */
function isFlatGraphic(raw: Uint8Array, channels: number): boolean {
  const pixels = Math.floor(raw.byteLength / channels);
  const step = Math.max(1, Math.floor(pixels / 20000));
  const limit = channels === 1 ? 48 : 256;
  const seen = new Set<number>();
  for (let i = 0; i < pixels; i += step) {
    const o = i * channels;
    const key = channels === 3 ? (raw[o] << 16) | (raw[o + 1] << 8) | raw[o + 2] : raw[o];
    seen.add(key);
    if (seen.size > limit) return false;
  }
  return true;
}

/* ------------------------------ lossless pass ----------------------------- */

function deflateUncompressedStreams(doc: PDFDocument) {
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.has(PDFName.of('Filter')) || obj.contents.byteLength < 256) continue;
    // XMP metadata must stay readable without decompression.
    if (obj.dict.lookup(PDFName.of('Type')) === PDFName.of('Metadata')) continue;
    const packed = zlibSync(obj.contents, { level: 9 });
    if (packed.byteLength >= obj.contents.byteLength) continue;
    const dict = obj.dict.clone(doc.context);
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    dict.delete(PDFName.of('DecodeParms'));
    doc.context.assign(ref, PDFRawStream.of(dict, packed));
  }
}
