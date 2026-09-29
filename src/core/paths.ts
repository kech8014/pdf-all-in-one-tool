/**
 * Freehand stroke smoothing shared by screen rendering (SVG) and export (PDF), so a
 * stroke looks the same in both. Midpoint quadratic smoothing: the raw pointer samples
 * become control points and the curve passes through the midpoints between them.
 */
export type PathSeg =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'Q'; cx: number; cy: number; x: number; y: number };

export function smoothStroke(points: number[]): PathSeg[] {
  const n = points.length / 2;
  if (n === 0) return [];
  const px = (i: number) => points[2 * i];
  const py = (i: number) => points[2 * i + 1];
  const segs: PathSeg[] = [{ op: 'M', x: px(0), y: py(0) }];
  if (n === 1) {
    segs.push({ op: 'L', x: px(0) + 0.01, y: py(0) });
    return segs;
  }
  if (n === 2) {
    segs.push({ op: 'L', x: px(1), y: py(1) });
    return segs;
  }
  for (let i = 1; i < n - 1; i++) {
    segs.push({ op: 'Q', cx: px(i), cy: py(i), x: (px(i) + px(i + 1)) / 2, y: (py(i) + py(i + 1)) / 2 });
  }
  segs.push({ op: 'L', x: px(n - 1), y: py(n - 1) });
  return segs;
}

export function segsToSvg(segs: PathSeg[]): string {
  const f = (v: number) => Math.round(v * 100) / 100;
  return segs
    .map((s) => (s.op === 'Q' ? `Q${f(s.cx)} ${f(s.cy)} ${f(s.x)} ${f(s.y)}` : `${s.op}${f(s.x)} ${f(s.y)}`))
    .join('');
}

/**
 * Drop samples closer than `minDist` to the previous kept sample. Keeps the stroke's
 * shape while bounding the size of the stored point list.
 */
export function simplifyPoints(points: number[], minDist: number): number[] {
  if (points.length <= 4) return points.slice();
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    const lx = out[out.length - 2];
    const ly = out[out.length - 1];
    if (Math.hypot(points[i] - lx, points[i + 1] - ly) >= minDist) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}

/** simplifyPoints for a stroke that carries one pressure value per point. */
export function simplifyStroke(points: number[], pressures: number[], minDist: number): { points: number[]; pressures: number[] } {
  const n = points.length / 2;
  if (n <= 2) return { points: points.slice(), pressures: pressures.slice() };
  const pts = [points[0], points[1]];
  const pr = [pressures[0]];
  for (let i = 1; i < n - 1; i++) {
    if (Math.hypot(points[2 * i] - pts[pts.length - 2], points[2 * i + 1] - pts[pts.length - 1]) >= minDist) {
      pts.push(points[2 * i], points[2 * i + 1]);
      pr.push(pressures[i]);
    }
  }
  pts.push(points[2 * n - 2], points[2 * n - 1]);
  pr.push(pressures[n - 1]);
  return { points: pts, pressures: pr };
}

/** Arrow head triangle for a line from (x1,y1) to (x2,y2): returns the three corners. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number): [number, number][] {
  const len = Math.max(8, width * 4);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const spread = (28 * Math.PI) / 180;
  return [
    [x2, y2],
    [x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread)],
    [x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread)],
  ];
}

/** Where the visible shaft of an arrow ends, so the stroke does not poke through the head. */
export function arrowShaftEnd(x1: number, y1: number, x2: number, y2: number, width: number): [number, number] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return [x2, y2];
  const back = Math.min(len, Math.max(8, width * 4) * 0.8);
  return [x2 - ((x2 - x1) / len) * back, y2 - ((y2 - y1) / len) * back];
}
