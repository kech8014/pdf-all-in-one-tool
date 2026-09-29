/**
 * Freehand clean-up, the way good drawing apps do it:
 *
 *  - SMOOTHING: every stroke is resampled evenly and Gaussian-smoothed, so a jittery
 *    mouse hand gives a calm curve. Ink width is derived from the ORIGINAL drawing speed
 *    first, so smoothing does not flatten the "real ink" feel.
 *  - SHAPE RECOGNITION: a stroke that is clearly meant to be a geometric figure snaps to
 *    the perfect one — straight line (and 0/45/90° when close), arc, circle, ellipse,
 *    rectangle, triangle, or an open run of straight segments (an angle, a zig-zag).
 *
 * Everything here is pure geometry on flat [x0, y0, x1, y1, ...] lists in page space.
 * `unit` is one screen pixel in page units (1 / zoom) so that tolerances follow what the
 * user sees, not the page's point size.
 */

export type ShapeKind = 'line' | 'arc' | 'circle' | 'ellipse' | 'rectangle' | 'triangle' | 'polyline';

export interface RecognisedShape {
  kind: ShapeKind;
  points: number[];
}

type P = [number, number];

const toPts = (flat: number[]): P[] => {
  const out: P[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};
const flat = (pts: P[]): number[] => pts.flatMap((p) => [p[0], p[1]]);
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(pts: P[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

function bbox(pts: P[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, diag: Math.hypot(x1 - x0, y1 - y0) };
}

/** Points evenly spaced along the path; `values` (e.g. pressures) are interpolated too. */
export function resample(pts: P[], step: number, values?: number[]): { pts: P[]; values: number[] } {
  if (pts.length < 2 || step <= 0) return { pts: pts.slice(), values: values?.slice() ?? [] };
  const out: P[] = [pts[0]];
  const vals: number[] = values ? [values[0]] : [];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    if (seg === 0) continue;
    let t = step - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      if (values) vals.push(values[i - 1] + (values[i] - values[i - 1]) * f);
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) {
    out.push(last);
    if (values) vals.push(values[values.length - 1]);
  } else if (out.length > 1) {
    out[out.length - 1] = last; // the stroke ends exactly where it was drawn to end
  }
  return { pts: out, values: vals };
}

/** Gaussian smoothing with the ends pinned (the window shrinks towards each end). */
function gaussian(pts: P[], vals: number[], sigmaSamples: number): { pts: P[]; values: number[] } {
  const n = pts.length;
  const R = Math.ceil(sigmaSamples * 2.5);
  if (n < 3 || R < 1) return { pts, values: vals };
  const w = Array.from({ length: R + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)));
  const outP: P[] = [];
  const outV: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.min(R, i, n - 1 - i);
    let sx = 0;
    let sy = 0;
    let sv = 0;
    let sw = 0;
    for (let k = -r; k <= r; k++) {
      const wk = w[Math.abs(k)];
      sx += pts[i + k][0] * wk;
      sy += pts[i + k][1] * wk;
      if (vals.length) sv += vals[i + k] * wk;
      sw += wk;
    }
    outP.push([sx / sw, sy / sw]);
    if (vals.length) outV.push(sv / sw);
  }
  return { pts: outP, values: outV };
}

/**
 * The same speed → pressure model the ink renderer uses for mouse and finger input
 * (fast = thin, slow = thick), evaluated on the stroke AS DRAWN, before smoothing.
 */
export function speedPressures(points: number[], size: number): number[] {
  const pts = toPts(points);
  const out: number[] = [];
  let prev = 0.5;
  for (let i = 0; i < pts.length; i++) {
    const d = i ? dist(pts[i], pts[i - 1]) : 0;
    const sp = Math.min(1, d / Math.max(size, 0.01));
    const rp = Math.min(1, 1 - sp);
    prev = Math.min(1, prev + (rp - prev) * (sp * 0.275));
    out.push(i ? prev : 0.5);
  }
  // the first samples have no speed yet: start them at the first real value
  if (out.length > 1) out[0] = out[1];
  return out;
}

/**
 * Smooth a freehand stroke. `strength` is the smoothing radius in screen pixels (about 3
 * for a mouse, 1.2 for a stylus, which is already steady).
 */
export function smoothFreehand(points: number[], pressures: number[] | undefined, unit: number, strength: number): { points: number[]; pressures?: number[] } {
  const pts = toPts(points);
  if (pts.length < 3) return { points: points.slice(), pressures: pressures?.slice() };
  const step = unit * 1.2;
  const r = resample(pts, step, pressures);
  // Two passes: jitter makes the drawn path longer than the intended one, so a single
  // kernel measured along it covers too little of the real curve.
  const g1 = gaussian(r.pts, r.values, strength / 1.2);
  const r2 = resample(g1.pts, step, pressures ? g1.values : undefined);
  const g = gaussian(r2.pts, r2.values, strength / 1.2);
  return { points: flat(g.pts), pressures: pressures ? g.values.map((v) => Math.max(0, Math.min(1, v))) : undefined };
}

/* ------------------------------ recognition ------------------------------ */

function perpDist(p: P, a: P, b: P): number {
  const L = dist(a, b);
  if (L === 0) return dist(p, a);
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L;
}

function segDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker: indices of the corners of a polyline. */
function rdp(pts: P[], eps: number, lo = 0, hi = pts.length - 1, out: number[] = []): number[] {
  if (lo === 0 && hi === pts.length - 1) out.push(0);
  let best = -1;
  let bestD = 0;
  for (let i = lo + 1; i < hi; i++) {
    const d = perpDist(pts[i], pts[lo], pts[hi]);
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD > eps && best > 0) {
    rdp(pts, eps, lo, best, out);
    out.push(best);
    rdp(pts, eps, best, hi, out);
  }
  if (lo === 0 && hi === pts.length - 1) out.push(hi);
  return out;
}

/** Snap an angle (radians) to the nearest multiple of 45° when within `tol` radians. */
function snapAngle(a: number, tol: number): number {
  const step = Math.PI / 4;
  const s = Math.round(a / step) * step;
  return Math.abs(a - s) <= tol ? s : a;
}

function densify(corners: P[], spacing: number): P[] {
  const out: P[] = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1];
    const b = corners[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / spacing));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function meanDistToPolygon(pts: P[], poly: P[]): number {
  let s = 0;
  for (const p of pts) {
    let d = Infinity;
    for (let i = 1; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i - 1], poly[i]));
    s += d;
  }
  return s / pts.length;
}

/** Least-squares circle (Kåsa). */
function fitCircle(pts: P[]): { cx: number; cy: number; r: number } | null {
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const [x, y] of pts) {
    const u = x - mx;
    const v = y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = 0.5 * (suuu + suvv);
  const b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return { cx: uc + mx, cy: vc + my, r };
}

/** Ellipse from the second moments of evenly spaced points; `err` is the mean radial error. */
function fitEllipse(pts: P[]) {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - cx) ** 2;
    syy += (y - cy) ** 2;
    sxy += (x - cx) * (y - cy);
  }
  sxx /= n;
  syy /= n;
  sxy /= n;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const tr = sxx + syy;
  const disc = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  const l1 = tr / 2 + disc;
  const l2 = Math.max(1e-9, tr / 2 - disc);
  // For points spread evenly around an ellipse the variance along an axis is ~ a²/2.
  let a = Math.sqrt(2 * l1);
  let b = Math.sqrt(2 * l2);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // refine the radii to the mean of the drawn extent
  let err = 0;
  let su = 0;
  let sv = 0;
  for (const [x, y] of pts) {
    const u = (x - cx) * cos + (y - cy) * sin;
    const v = -(x - cx) * sin + (y - cy) * cos;
    su = Math.max(su, Math.abs(u));
    sv = Math.max(sv, Math.abs(v));
  }
  a = (a + su) / 2;
  b = (b + sv) / 2;
  for (const [x, y] of pts) {
    const u = (x - cx) * cos + (y - cy) * sin;
    const v = -(x - cx) * sin + (y - cy) * cos;
    err += Math.abs(Math.hypot(u / a, v / b) - 1);
  }
  return { cx, cy, a, b, theta, err: err / n };
}

function ellipsePoints(cx: number, cy: number, a: number, b: number, theta: number, n = 96): P[] {
  const out: P[] = [];
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const u = a * Math.cos(t);
    const v = b * Math.sin(t);
    out.push([cx + u * cos - v * sin, cy + u * sin + v * cos]);
  }
  return out;
}

export interface RecogniseOptions {
  /** One screen pixel in page units (1 / zoom). */
  unit: number;
  /**
   * 'auto': snap only strokes that are unmistakably geometric, and leave anything the size
   * of handwriting alone (except a truly straight stroke). 'hold': the user held still at
   * the end of the stroke to ask for a shape, so every size qualifies and tolerances are
   * looser.
   */
  mode: 'auto' | 'hold';
  /**
   * False when the stroke is part of writing (drawn right after, and right next to,
   * another stroke). In 'auto' mode such strokes only ever get line-straightening, so
   * letters like E, O or C are never turned into boxes, circles or arcs.
   */
  isolated?: boolean;
}

/** Returns the perfect shape the stroke was meant to be, or null to keep it freehand. */
export function recogniseShape(points: number[], opts: RecogniseOptions): RecognisedShape | null {
  const raw = toPts(points);
  if (raw.length < 2) return null;
  const hold = opts.mode === 'hold';
  // Measure length on a lightly smoothed copy: hand jitter adds length that is not there.
  const calm = gaussian(resample(raw, opts.unit * 1.2).pts, [], 3 / 1.2).pts;
  const L = pathLength(calm);
  const box = bbox(raw);
  const px = (v: number) => v / opts.unit; // page units -> screen pixels
  if (px(L) < (hold ? 12 : 24)) return null;
  const loose = hold ? 1.6 : 1;
  const bigEnough = hold || px(box.diag) >= 90; // handwriting stays handwriting
  const pts = resample(raw, L / 96).pts;
  const a0 = raw[0];
  const a1 = raw[raw.length - 1];
  const chord = dist(a0, a1);

  /* 1. straight line */
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, perpDist(p, a0, a1));
  if (chord > 0 && chord / L > 0.94 && maxDev / chord < 0.045 * loose) {
    const ang = snapAngle(Math.atan2(a1[1] - a0[1], a1[0] - a0[0]), (4 * Math.PI) / 180);
    return { kind: 'line', points: [a0[0], a0[1], a0[0] + Math.cos(ang) * chord, a0[1] + Math.sin(ang) * chord] };
  }
  if (!bigEnough) return null;
  // Automatic snapping beyond straight lines is reserved for closed figures drawn on
  // their own. Open shapes (angles, arcs) look too much like letters: those snap only
  // when the user holds still at the end of the stroke.
  if (!hold && opts.isolated === false) return null;

  const closed = chord < Math.max(0.2 * box.diag, 14 * opts.unit) && L > 1.8 * box.diag;
  const spacing = Math.max(opts.unit, box.diag / 60);

  if (closed) {
    // Close the loop for fitting.
    const loop = resample([...raw, raw[0]], L / 120).pts;
    const ell = fitEllipse(loop);
    // corners of the loop
    const idx = rdp(loop, box.diag * 0.07);
    let corners = idx.map((i) => loop[i]);
    // merge the start/end duplicate and near-duplicate corners
    corners = corners.filter((c, i) => i === 0 || dist(c, corners[i - 1]) > box.diag * 0.08);
    if (corners.length > 2 && dist(corners[0], corners[corners.length - 1]) < box.diag * 0.12) corners.pop();
    // RDP always keeps the start point; drop it when it sits mid-edge (straight angle)
    const cleaned: P[] = [];
    for (let i = 0; i < corners.length; i++) {
      const prev = corners[(i - 1 + corners.length) % corners.length];
      const next = corners[(i + 1) % corners.length];
      const v1 = [corners[i][0] - prev[0], corners[i][1] - prev[1]];
      const v2 = [next[0] - corners[i][0], next[1] - corners[i][1]];
      const turn = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]));
      if (turn > (25 * Math.PI) / 180) cleaned.push(corners[i]);
    }
    const k = cleaned.length;
    const polyErr = k >= 3 ? meanDistToPolygon(loop, [...cleaned, cleaned[0]]) / box.diag : Infinity;
    const ellErr = ell.err;

    if ((k === 3 || k === 4) && polyErr < 0.035 * loose && polyErr < ellErr * 0.6) {
      if (k === 3) return { kind: 'triangle', points: flat(densify([...cleaned, cleaned[0]], spacing)) };
      // quadrilateral: make it a true rectangle, axis-aligned when it is nearly so
      const e0 = Math.atan2(cleaned[1][1] - cleaned[0][1], cleaned[1][0] - cleaned[0][0]);
      const e2 = Math.atan2(cleaned[2][1] - cleaned[3][1], cleaned[2][0] - cleaned[3][0]);
      let ang = Math.atan2(Math.sin(e0) + Math.sin(e2), Math.cos(e0) + Math.cos(e2));
      ang = snapAngle(ang, (7 * Math.PI) / 180);
      const w = (dist(cleaned[0], cleaned[1]) + dist(cleaned[2], cleaned[3])) / 2;
      const h = (dist(cleaned[1], cleaned[2]) + dist(cleaned[3], cleaned[0])) / 2;
      const cx = cleaned.reduce((s, c) => s + c[0], 0) / 4;
      const cy = cleaned.reduce((s, c) => s + c[1], 0) / 4;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const turnSign = Math.sign(
        (cleaned[1][0] - cleaned[0][0]) * (cleaned[2][1] - cleaned[1][1]) - (cleaned[1][1] - cleaned[0][1]) * (cleaned[2][0] - cleaned[1][0]),
      ) || 1;
      const rect: P[] = [
        [-w / 2, -turnSign * h / 2],
        [w / 2, -turnSign * h / 2],
        [w / 2, turnSign * h / 2],
        [-w / 2, turnSign * h / 2],
      ].map(([u, v]) => [cx + u * cos - v * sin, cy + u * sin + v * cos] as P);
      return { kind: 'rectangle', points: flat(densify([...rect, rect[0]], spacing)) };
    }
    if (ellErr < 0.09 * loose) {
      const ratio = ell.a / ell.b;
      if (ratio < 1.15) {
        const r = (ell.a + ell.b) / 2;
        return { kind: 'circle', points: flat(ellipsePoints(ell.cx, ell.cy, r, r, 0)) };
      }
      const th = snapAngle(ell.theta, (8 * Math.PI) / 180);
      return { kind: 'ellipse', points: flat(ellipsePoints(ell.cx, ell.cy, ell.a, ell.b, th)) };
    }
    return null;
  }

  if (!hold) return null;

  /* 2. open run of straight segments: an angle, a check mark, a zig-zag */
  const idx = rdp(pts, box.diag * 0.06 * loose);
  const corners = idx.map((i) => pts[i]);
  if (corners.length >= 3 && corners.length <= 5) {
    const segs = corners.length - 1;
    const minSeg = Math.min(...corners.slice(1).map((c, i) => dist(corners[i], c)));
    const err = meanDistToPolygon(pts, corners) / box.diag;
    if (minSeg > L * 0.12 && err < 0.018 * loose) {
      // each corner is sharp: the turn there is more than 30°
      let sharp = true;
      for (let i = 1; i < segs; i++) {
        const v1 = [corners[i][0] - corners[i - 1][0], corners[i][1] - corners[i - 1][1]];
        const v2 = [corners[i + 1][0] - corners[i][0], corners[i + 1][1] - corners[i][1]];
        const turn = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]));
        if (turn < (40 * Math.PI) / 180) sharp = false;
      }
      // ...and every segment is itself straight (a smooth wave is not a zig-zag)
      for (let j = 0; j < segs && sharp; j++) {
        const a = corners[j];
        const b = corners[j + 1];
        const len = dist(a, b);
        for (let i = idx[j]; i <= idx[j + 1]; i++) {
          if (perpDist(pts[i], a, b) > len * 0.035 * loose) {
            sharp = false;
            break;
          }
        }
      }
      if (sharp) return { kind: 'polyline', points: flat(densify(corners, spacing)) };
    }
  }

  /* 3. arc */
  const c = fitCircle(pts);
  if (c && c.r < box.diag * 4) {
    let rms = 0;
    for (const p of pts) rms += (Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) ** 2;
    rms = Math.sqrt(rms / pts.length) / c.r;
    // total signed sweep, and it must turn one way only
    let sweep = 0;
    let back = 0;
    let prevA = Math.atan2(pts[0][1] - c.cy, pts[0][0] - c.cx);
    for (let i = 1; i < pts.length; i++) {
      const a = Math.atan2(pts[i][1] - c.cy, pts[i][0] - c.cx);
      let d = a - prevA;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
      prevA = a;
      if (i > 1 && Math.sign(d) !== Math.sign(sweep)) back += Math.abs(d);
    }
    const deg = (Math.abs(sweep) * 180) / Math.PI;
    if (rms < 0.04 * loose && deg > 25 && deg < 330 && back < Math.abs(sweep) * 0.05) {
      const start = Math.atan2(a0[1] - c.cy, a0[0] - c.cx);
      const n = Math.max(12, Math.ceil(deg / 3));
      const out: P[] = [];
      for (let i = 0; i <= n; i++) {
        const t = start + (sweep * i) / n;
        out.push([c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t)]);
      }
      return { kind: 'arc', points: flat(out) };
    }
  }
  return null;
}
