import { describe, expect, it } from 'vitest';
import { recogniseShape, smoothFreehand } from '../../src/core/shapes';

// Deterministic "hand wobble".
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
const wobble = (pts: number[][], amp: number) => pts.flatMap(([x, y]) => [x + rnd() * amp, y + rnd() * amp]);
const unit = 1; // 100% zoom

function linePts(x0: number, y0: number, x1: number, y1: number, n = 60) {
  return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
}
function ellipse(cx: number, cy: number, a: number, b: number, from = 0, to = Math.PI * 2, n = 120) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / n;
    return [cx + a * Math.cos(t), cy + b * Math.sin(t)];
  });
}
function poly(corners: number[][], per = 30) {
  const out: number[][] = [];
  for (let i = 1; i < corners.length; i++) out.push(...linePts(corners[i - 1][0], corners[i - 1][1], corners[i][0], corners[i][1], per).slice(i > 1 ? 1 : 0));
  return out;
}

describe('shape recognition', () => {
  it('a shaky straight stroke becomes a perfectly straight line, snapped to horizontal', () => {
    const s = recogniseShape(wobble(linePts(100, 100, 300, 103), 2), { unit, mode: 'auto' })!;
    expect(s.kind).toBe('line');
    expect(s.points).toHaveLength(4);
    expect(Math.abs(s.points[3] - s.points[1])).toBeLessThan(0.01); // exactly horizontal
  });

  it('a diagonal line keeps its angle when it is not close to 45°', () => {
    const s = recogniseShape(wobble(linePts(0, 0, 200, 60), 1.5), { unit, mode: 'auto' })!;
    expect(s.kind).toBe('line');
    const ang = (Math.atan2(s.points[3] - s.points[1], s.points[2] - s.points[0]) * 180) / Math.PI;
    expect(ang).toBeGreaterThan(14);
    expect(ang).toBeLessThan(19);
  });

  it('circle, ellipse, rectangle and triangle', () => {
    expect(recogniseShape(wobble(ellipse(200, 200, 80, 78, 0, Math.PI * 2.02), 3), { unit, mode: 'auto' })?.kind).toBe('circle');
    expect(recogniseShape(wobble(ellipse(200, 200, 140, 60, 0.3, 0.3 + Math.PI * 2), 3), { unit, mode: 'auto' })?.kind).toBe('ellipse');
    const rect = recogniseShape(wobble(poly([[100, 100], [300, 104], [298, 220], [102, 218], [101, 103]]), 2.5), { unit, mode: 'auto' })!;
    expect(rect.kind).toBe('rectangle');
    // axis-aligned: top edge horizontal
    expect(Math.abs(rect.points[1] - rect.points[3])).toBeLessThan(0.5);
    expect(recogniseShape(wobble(poly([[100, 300], [200, 120], [300, 300], [102, 298]]), 2), { unit, mode: 'auto' })?.kind).toBe('triangle');
  });

  it('an arc and an angle', () => {
    expect(recogniseShape(wobble(ellipse(200, 200, 100, 100, Math.PI, Math.PI * 1.7), 2), { unit, mode: 'auto' })?.kind).toBe('arc');
    expect(recogniseShape(wobble(poly([[100, 100], [100, 250], [260, 250]]), 1.5), { unit, mode: 'auto' })?.kind).toBe('polyline');
  });

  it('handwriting-sized strokes stay freehand in auto mode, but snap when held', () => {
    const c = wobble(ellipse(50, 50, 18, 22, Math.PI * 0.3, Math.PI * 1.7), 0.6); // a "C", 45px tall
    expect(recogniseShape(c, { unit, mode: 'auto' })).toBeNull();
    expect(recogniseShape(c, { unit, mode: 'hold' })?.kind).toBe('arc');
  });

  it('a wave drawn with a mouse is not mistaken for a zig-zag', () => {
    const pts: number[] = [];
    let px = 100;
    let py = 200;
    pts.push(px, py);
    for (let i = 1; i <= 30; i++) {
      const nx = 100 + i * 8;
      const ny = 200 + Math.sin(i / 4) * 30;
      const steps = i % 3 === 0 ? 1 : 4;
      for (let k = 1; k <= steps; k++) pts.push(px + ((nx - px) * k) / steps, py + ((ny - py) * k) / steps);
      px = nx;
      py = ny;
    }
    expect(recogniseShape(pts.map((v) => v / 1.5), { unit: 1 / 1.5, mode: 'auto' })).toBeNull();
  });

  it('a genuinely free curve is left alone', () => {
    const s = Array.from({ length: 200 }, (_, i) => [i * 2, 100 + Math.sin(i / 12) * 40 + Math.sin(i / 5) * 12]);
    expect(recogniseShape(wobble(s, 1), { unit, mode: 'auto' })).toBeNull();
  });
});

describe('smoothing', () => {
  it('removes jitter but keeps the end points', () => {
    const noisy = wobble(linePts(0, 0, 200, 0, 200), 3);
    const sm = smoothFreehand(noisy, undefined, unit, 3).points;
    const rmsY = (a: number[]) => {
      const ys = a.filter((_, i) => i % 2);
      return Math.sqrt(ys.reduce((s, y) => s + y * y, 0) / ys.length);
    };
    expect(rmsY(sm)).toBeLessThan(rmsY(noisy) * 0.5);
    expect(sm[0]).toBeCloseTo(noisy[0]);
    expect(sm[sm.length - 1]).toBeCloseTo(noisy[noisy.length - 1]);
  });
});
