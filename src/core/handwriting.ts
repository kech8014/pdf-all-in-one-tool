import { annotationBounds, invert, pageToDisplayMatrix, transformRect, uprightRotation } from './geometry';
import { newId } from './ids';
import type { InkAnnotation, Rect, Rotation, TextAnnotation } from './types';
import { TEXT_PADDING, layoutText, measure } from '../engine/textLayout';

/**
 * Handwriting → text, the geometric half (pure, testable). Strokes are grouped into
 * blocks of writing — the letters of a word, the words of a line and the lines of a
 * paragraph end up together, while separate notes elsewhere on the page stay separate.
 * All grouping happens in DISPLAY space (the page as the user sees it), because that is
 * the orientation the user wrote in.
 */

export interface InkBlock {
  inks: InkAnnotation[];
  /** Bounding box of the block in display space. */
  box: Rect;
}

/** Only real pen strokes are handwriting candidates; translucent marker bands are not. */
export function isHandwritingCandidate(a: InkAnnotation): boolean {
  return a.opacity >= 0.5 && a.points.length >= 2;
}

function displayBounds(a: InkAnnotation, m: ReturnType<typeof pageToDisplayMatrix>): Rect {
  return transformRect(m, annotationBounds(a));
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function clusterInk(inks: InkAnnotation[], pageW: number, pageH: number, rotation: Rotation): InkBlock[] {
  const m = pageToDisplayMatrix(pageW, pageH, rotation);
  const boxes = inks.map((a) => displayBounds(a, m));
  // The typical letter height sets how far apart two strokes may be and still belong
  // to the same writing: about a letter sideways (word spacing), half a letter down
  // (line spacing).
  const ref = Math.max(6, median(boxes.map((b) => b.h).filter((h) => h > 2)));
  const gx = ref * 1.1;
  const gy = ref * 0.55;
  const parent = inks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const near = a.x - gx <= b.x + b.w && b.x - gx <= a.x + a.w && a.y - gy <= b.y + b.h && b.y - gy <= a.y + a.h;
      if (near) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  inks.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  const blocks: InkBlock[] = [];
  for (const idx of groups.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of idx) {
      const b = boxes[i];
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    blocks.push({ inks: idx.map((i) => inks[i]), box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  // Reading order: top to bottom, then left to right.
  return blocks.sort((a, b) => (Math.abs(a.box.y - b.box.y) > ref ? a.box.y - b.box.y : a.box.x - b.box.x));
}

/** Clean up what a recogniser returns: trim, collapse blank lines, drop "no text" answers. */
export function cleanRecognised(text: string): string {
  const t = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length)
    .join('\n')
    .trim();
  if (!t || /^<\s*none\s*>$/i.test(t)) return '';
  return t;
}

/**
 * A text annotation that sits where the handwriting was, in the writing's colour, with
 * a font size that matches the size of the writing. `box` is in display space.
 */
export function textForBlock(text: string, box: Rect, color: string, pageW: number, pageH: number, rotation: Rotation): TextAnnotation {
  const disp = rotation % 180 === 0 ? { w: pageW, h: pageH } : { w: pageH, h: pageW };
  const lines = text.split('\n');
  const fontSize = Math.round(Math.max(7, Math.min(96, (box.h / lines.length) * 0.78)) * 2) / 2;
  const widest = Math.max(...lines.map((l) => measure(l, 'helvetica', false, false, fontSize)));
  const x = Math.max(0, Math.min(box.x - TEXT_PADDING, disp.w - 20));
  const w = Math.max(20, Math.min(Math.max(box.w + 2 * TEXT_PADDING, widest + 2 * TEXT_PADDING + 2), disp.w - x));
  const base = { text, fontFamily: 'helvetica' as const, fontSize, bold: false, italic: false, align: 'left' as const };
  const h = layoutText({ ...base, boxWidth: w }).height;
  // Centre the typed text on the handwriting vertically so it replaces it in place.
  const y = Math.max(0, Math.min(box.y + (box.h - h) / 2, disp.h - h));
  const pageRect = transformRect(invert(pageToDisplayMatrix(pageW, pageH, rotation)), { x, y, w, h });
  return {
    id: newId('an'),
    type: 'text',
    rect: pageRect,
    rotation: uprightRotation(rotation),
    ...base,
    color,
    background: null,
    opacity: 1,
  };
}

/** Most common colour among a block's strokes (a signature in blue stays blue). */
export function dominantColor(inks: InkAnnotation[]): string {
  const count = new Map<string, number>();
  for (const a of inks) count.set(a.color, (count.get(a.color) ?? 0) + a.points.length);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '#000000';
}
