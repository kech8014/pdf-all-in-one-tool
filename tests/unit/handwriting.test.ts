import { describe, expect, it } from 'vitest';
import { cleanRecognised, clusterInk, dominantColor, textForBlock } from '../../src/core/handwriting';
import { localSize } from '../../src/core/geometry';
import type { InkAnnotation } from '../../src/core/types';

let n = 0;
/** A stroke that zig-zags inside a letter-sized box at (x, y). */
function letter(x: number, y: number, h = 14, color = '#000000'): InkAnnotation {
  return { id: `ink${n++}`, type: 'ink', points: [x, y + h, x + 3, y, x + 6, y + h, x + 8, y + h / 2], color, width: 2, opacity: 1, pressures: [0.5, 0.5, 0.5, 0.5] };
}

describe('handwriting grouping', () => {
  it('keeps the letters of words and lines together, and separate notes apart', () => {
    const line1 = [letter(100, 100), letter(111, 100), letter(122, 100), letter(145, 100), letter(156, 100)]; // two words
    const line2 = [letter(100, 120), letter(111, 120)]; // next line, same paragraph
    const far = [letter(400, 600), letter(411, 600)]; // a note elsewhere
    const blocks = clusterInk([...far, ...line2, ...line1], 612, 792, 0);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].inks).toHaveLength(7); // reading order: the upper block first
    expect(blocks[1].inks).toHaveLength(2);
    expect(blocks[0].box.x).toBeLessThan(101);
    expect(blocks[0].box.y).toBeLessThan(101);
  });

  it('groups in display space on a rotated page', () => {
    // On a page shown at 90°, a horizontal line of writing on screen is vertical in page space.
    const inks = [0, 1, 2].map((i) => {
      const a = letter(100, 100 + i * 11);
      // rotate the letter so it is upright on screen: swap x/y
      const pts = a.points.slice();
      for (let k = 0; k < pts.length; k += 2) [pts[k], pts[k + 1]] = [pts[k + 1], 792 - pts[k] - 400];
      return { ...a, points: pts };
    });
    expect(clusterInk(inks, 612, 792, 90)).toHaveLength(1);
  });
});

describe('recognised text', () => {
  it('cleans recogniser output and treats <none> as nothing', () => {
    expect(cleanRecognised('  Hello   world \n\n  second  line ')).toBe('Hello world\nsecond line');
    expect(cleanRecognised('<none>')).toBe('');
    expect(cleanRecognised('   ')).toBe('');
  });

  it('places the text where the writing was, in its colour and at a matching size', () => {
    const box = { x: 100, y: 200, w: 120, h: 30 };
    const t = textForBlock('Approved', box, '#1d4ed8', 612, 792, 0);
    expect(t.type).toBe('text');
    expect(t.color).toBe('#1d4ed8');
    expect(t.fontSize).toBeGreaterThan(18);
    expect(t.fontSize).toBeLessThan(30);
    expect(t.rect.x).toBeCloseTo(97, 0);
    expect(Math.abs(t.rect.y + t.rect.h / 2 - (box.y + box.h / 2))).toBeLessThan(2); // centred on the writing
    expect(t.rotation).toBe(0);
  });

  it('two lines of writing become two lines of text at half the height each', () => {
    const t = textForBlock('line one\nline two', { x: 50, y: 50, w: 200, h: 60 }, '#000000', 612, 792, 0);
    expect(t.fontSize).toBeGreaterThan(18);
    expect(t.fontSize).toBeLessThan(30);
  });

  it('text reads upright on a rotated page', () => {
    const t = textForBlock('Hi', { x: 100, y: 100, w: 60, h: 24 }, '#000', 612, 792, 90);
    expect(t.rotation).toBe(270);
    expect(localSize(t.rect, t.rotation).w).toBeGreaterThanOrEqual(60);
  });

  it('keeps the colour most of the writing was in', () => {
    expect(dominantColor([letter(0, 0, 14, '#ff0000'), letter(10, 0, 14, '#ff0000'), letter(20, 0, 14, '#0000ff')])).toBe('#ff0000');
  });
});
