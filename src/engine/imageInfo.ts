/**
 * Header parsing for the two image formats PDF can embed natively (JPEG, PNG). Every
 * other format is converted to PNG in the browser first (see browserImages.ts).
 */
export type NativeMime = 'image/jpeg' | 'image/png';

export interface ImageInfo {
  mime: NativeMime;
  width: number;
  height: number;
  /** EXIF orientation 1..8 (1 = as stored). */
  orientation: number;
  /** Pixels per inch from JFIF/EXIF/pHYs, when the file states one. */
  dpi: number | null;
  /** JPEG colour components (1 gray, 3 RGB/YCbCr, 4 CMYK). */
  components?: number;
}

export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) {
    return 'image/tiff';
  }
  // ISO-BMFF (AVIF/HEIC): "ftyp" at offset 4
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand.startsWith('avi')) return 'image/avif';
    if (brand.startsWith('he') || brand === 'mif1') return 'image/heic';
  }
  // A PDF may have junk before the header; accept %PDF- within the first 1 KB.
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(1024, b.length)));
  if (head.includes('%PDF-')) return 'application/pdf';
  if (/^\s*<\?xml|^\s*<svg/i.test(head)) return 'image/svg+xml';
  return null;
}

function u16(b: Uint8Array, o: number, le: boolean) {
  return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
}
function u32(b: Uint8Array, o: number, le: boolean) {
  return le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function parseExifOrientation(b: Uint8Array, start: number, len: number): number {
  // start points at "Exif\0\0"
  const tiff = start + 6;
  if (tiff + 8 > start + len) return 1;
  const le = b[tiff] === 0x49;
  const ifd = tiff + u32(b, tiff + 4, le);
  if (ifd + 2 > b.length) return 1;
  const count = u16(b, ifd, le);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    if (u16(b, e, le) === 0x0112) {
      const v = u16(b, e + 8, le);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function jpegInfo(b: Uint8Array): ImageInfo {
  let o = 2;
  let orientation = 1;
  let dpi: number | null = null;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const len = (b[o + 2] << 8) | b[o + 3];
    const seg = o + 4;
    if (marker === 0xe0 && b[seg] === 0x4a && b[seg + 1] === 0x46 && b[seg + 2] === 0x49 && b[seg + 3] === 0x46) {
      const units = b[seg + 7];
      const xd = (b[seg + 8] << 8) | b[seg + 9];
      if (xd > 1) dpi = units === 1 ? xd : units === 2 ? xd * 2.54 : null;
    } else if (marker === 0xe1 && b[seg] === 0x45 && b[seg + 1] === 0x78 && b[seg + 2] === 0x69 && b[seg + 3] === 0x66) {
      orientation = parseExifOrientation(b, seg, len - 2);
    } else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[seg + 1] << 8) | b[seg + 2];
      const width = (b[seg + 3] << 8) | b[seg + 4];
      const components = b[seg + 5];
      return { mime: 'image/jpeg', width, height, orientation, dpi, components };
    }
    o += 2 + len;
  }
  throw new Error('JPEG has no frame header');
}

function pngInfo(b: Uint8Array): ImageInfo {
  const width = u32(b, 16, false);
  const height = u32(b, 20, false);
  let dpi: number | null = null;
  let o = 8;
  while (o + 8 <= b.length) {
    const len = u32(b, o, false);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === 'pHYs' && b[o + 16] === 1) dpi = u32(b, o + 8, false) * 0.0254;
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { mime: 'image/png', width, height, orientation: 1, dpi };
}

export function readImageInfo(bytes: Uint8Array): ImageInfo {
  const mime = sniffMime(bytes);
  if (mime === 'image/jpeg') return jpegInfo(bytes);
  if (mime === 'image/png') return pngInfo(bytes);
  throw new Error(`Not a JPEG or PNG image (${mime ?? 'unknown format'})`);
}

/** Width/height as the image should be displayed after EXIF orientation. */
export function orientedSize(info: Pick<ImageInfo, 'width' | 'height' | 'orientation'>): { width: number; height: number } {
  return info.orientation >= 5 ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

/**
 * PDF matrix drawing the image XObject's unit square into the box (x, y, w, h) in PDF
 * space (y up), applying the EXIF orientation. w/h are the ORIENTED (displayed) sizes.
 */
export function orientationMatrix(o: number, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (o) {
    case 2:
      return [-w, 0, 0, h, x + w, y];
    case 3:
      return [-w, 0, 0, -h, x + w, y + h];
    case 4:
      return [w, 0, 0, -h, x, y + h];
    case 5:
      return [0, -h, -w, 0, x + w, y + h];
    case 6:
      return [0, -h, w, 0, x, y + h];
    case 7:
      return [0, h, w, 0, x, y];
    case 8:
      return [0, h, -w, 0, x + w, y];
    default:
      return [w, 0, 0, h, x, y];
  }
}
