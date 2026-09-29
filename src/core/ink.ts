import { getStroke } from 'perfect-freehand';
import type { InkAnnotation } from './types';

/**
 * "Real ink": a pen stroke is drawn as a filled outline whose width follows pen pressure
 * (Apple Pencil, Surface pen, Wacom) or, with a mouse or finger, drawing speed — slow
 * strokes pool ink and swell, fast flicks thin out. The SAME outline is used on screen
 * and in the exported PDF, so what you draw is what you get.
 */
export function inkOutline(a: InkAnnotation): [number, number][] | null {
  if (!a.pressures) return null;
  const pts: [number, number, number][] = [];
  for (let i = 0; i < a.pressures.length; i++) pts.push([a.points[2 * i], a.points[2 * i + 1], a.pressures[i]]);
  const outline = getStroke(pts, {
    size: a.width * 1.35,
    thinning: 0.62,
    smoothing: 0.62,
    streamline: 0.42,
    simulatePressure: a.simulatePressure ?? true,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    start: { taper: 0, cap: true },
    end: { taper: a.pressures.length > 6 ? a.width * 2.5 : 0, cap: true },
    last: true,
  });
  return outline.length > 2 ? (outline as [number, number][]) : null;
}

/** Closed smooth path through an outline: quadratic curves between midpoints. */
export type OutlineSeg = { op: 'M'; x: number; y: number } | { op: 'Q'; cx: number; cy: number; x: number; y: number };
export function outlineSegs(o: [number, number][]): OutlineSeg[] {
  const n = o.length;
  const mid = (i: number): [number, number] => {
    const a = o[i % n];
    const b = o[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const [sx, sy] = mid(0);
  const segs: OutlineSeg[] = [{ op: 'M', x: sx, y: sy }];
  for (let i = 1; i <= n; i++) {
    const [cx, cy] = o[i % n];
    const [x, y] = mid(i);
    segs.push({ op: 'Q', cx, cy, x, y });
  }
  return segs;
}

export function outlineSvg(o: [number, number][]): string {
  const f = (v: number) => Math.round(v * 100) / 100;
  return (
    outlineSegs(o)
      .map((s) => (s.op === 'M' ? `M${f(s.x)} ${f(s.y)}` : `Q${f(s.cx)} ${f(s.cy)} ${f(s.x)} ${f(s.y)}`))
      .join('') + 'Z'
  );
}
