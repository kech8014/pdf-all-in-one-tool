import { StandardFontEmbedder, StandardFonts } from '@cantoo/pdf-lib';
import type { FontFamily, TextAlign } from '../core/types';

/**
 * One text layout used by BOTH the on-screen editor and the PDF exporter, measured with
 * the metrics of the PDF standard fonts that export embeds. What wraps on screen wraps
 * identically in the exported file.
 */

export const TEXT_PADDING = 3;
export const LINE_HEIGHT = 1.2;

const FONT_NAMES: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  // regular, bold, italic, bold-italic
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export const CSS_FONT: Record<FontFamily, string> = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
};

export const FONT_LABEL: Record<FontFamily, string> = {
  helvetica: 'Sans (Helvetica)',
  times: 'Serif (Times)',
  courier: 'Mono (Courier)',
};

export function standardFontName(family: FontFamily, bold: boolean, italic: boolean): StandardFonts {
  return FONT_NAMES[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

const embedders = new Map<StandardFonts, StandardFontEmbedder>();
function metrics(name: StandardFonts): StandardFontEmbedder {
  let e = embedders.get(name);
  if (!e) {
    e = StandardFontEmbedder.for(name as never);
    embedders.set(name, e);
  }
  return e;
}

/** Characters the standard fonts cannot encode (WinAnsi) are replaced by '?'. */
export function sanitizeText(text: string, family: FontFamily, bold = false, italic = false): string {
  const enc = metrics(standardFontName(family, bold, italic)).encoding;
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')) {
    const cp = ch.codePointAt(0)!;
    out += ch === '\n' || enc.canEncodeUnicodeCodePoint(cp) ? ch : '?';
  }
  return out;
}

export function hasUnsupportedChars(text: string, family: FontFamily): boolean {
  return sanitizeText(text, family) !== text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}

export interface LayoutInput {
  text: string;
  fontFamily: FontFamily;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  align: TextAlign;
  /** Width of the box's local frame in points. */
  boxWidth: number;
}

export interface LayoutLine {
  text: string;
  /** Left edge of the line inside the box (after alignment). */
  x: number;
  /** Baseline y inside the box, from the top. */
  baseline: number;
  width: number;
}

export interface Layout {
  lines: LayoutLine[];
  lineHeight: number;
  /** Height needed to show every line, including padding. */
  height: number;
  /** Width of the longest line plus padding (used to auto-size new boxes). */
  width: number;
}

export function measure(text: string, family: FontFamily, bold: boolean, italic: boolean, size: number): number {
  return metrics(standardFontName(family, bold, italic)).widthOfTextAtSize(text, size);
}

export function layoutText(input: LayoutInput): Layout {
  const { fontFamily, bold, italic, fontSize, align } = input;
  const font = metrics(standardFontName(fontFamily, bold, italic));
  const ascent = ((typeof font.font.Ascender === 'number' ? font.font.Ascender : 750) / 1000) * fontSize;
  const lineHeight = fontSize * LINE_HEIGHT;
  const avail = Math.max(1, input.boxWidth - 2 * TEXT_PADDING);
  const w = (s: string) => font.widthOfTextAtSize(s, fontSize);
  const text = sanitizeText(input.text, fontFamily, bold, italic);

  const raw: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const tok of para.split(/(\s+)/)) {
      if (tok === '') continue;
      if (w(line + tok) <= avail) {
        line += tok;
        continue;
      }
      if (/^\s+$/.test(tok)) {
        // Whitespace that overflows ends the line.
        raw.push(line.trimEnd());
        line = '';
        continue;
      }
      if (line.trim() !== '') {
        raw.push(line.trimEnd());
        line = '';
      }
      if (w(tok) <= avail) {
        line = tok;
        continue;
      }
      // A single word wider than the box: break it between characters.
      for (const ch of tok) {
        if (line !== '' && w(line + ch) > avail) {
          raw.push(line);
          line = ch;
        } else line += ch;
      }
    }
    raw.push(line.trimEnd());
  }

  let longest = 0;
  const lines = raw.map((t, i) => {
    const width = w(t);
    longest = Math.max(longest, width);
    const x = align === 'center' ? TEXT_PADDING + (avail - width) / 2 : align === 'right' ? TEXT_PADDING + avail - width : TEXT_PADDING;
    return { text: t, x, baseline: TEXT_PADDING + ascent + i * lineHeight, width };
  });
  return {
    lines,
    lineHeight,
    height: 2 * TEXT_PADDING + Math.max(1, lines.length) * lineHeight,
    width: longest + 2 * TEXT_PADDING,
  };
}
