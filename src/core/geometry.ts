import type { Annotation, Page, Rect, Rotation, SourcePageInfo, WorkspaceState } from './types';

/**
 * Coordinate spaces
 * -----------------
 * PAGE SPACE     points, origin top-left of the page's UNROTATED visible box, y down.
 *                Annotations live here, so they are independent of how the page is shown.
 * DISPLAY SPACE  points, origin top-left of the page as shown after its effective
 *                rotation (source /Rotate + user rotation), y down. Multiply by the zoom
 *                factor to get CSS pixels.
 * PDF SPACE      points, origin bottom-left of the MediaBox, y up (export only).
 *
 * A 2-D affine matrix is [a, b, c, d, e, f] mapping (x, y) -> (a x + c y + e, b x + d y + f),
 * the same convention as SVG and canvas.
 */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function normRotation(deg: number): Rotation {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

export function sourcePageInfo(state: WorkspaceState, page: Page): SourcePageInfo {
  const src = state.sources[page.sourceId];
  if (!src) throw new Error(`Page ${page.id} references missing source ${page.sourceId}`);
  const info = src.pages[page.sourcePageIndex];
  if (!info) throw new Error(`Page ${page.id} references missing page ${page.sourcePageIndex} of ${src.name}`);
  return info;
}

/** Rotation the page is shown with: its own /Rotate plus the user's rotation. */
export function effectiveRotation(state: WorkspaceState, page: Page): Rotation {
  return normRotation(sourcePageInfo(state, page).rotation + page.rotation);
}

/** Unrotated page size in points (page space extent). */
export function pageSize(state: WorkspaceState, page: Page): { width: number; height: number } {
  const info = sourcePageInfo(state, page);
  return { width: info.width, height: info.height };
}

/** Size of the page as displayed (after effective rotation), in points. */
export function displaySize(width: number, height: number, rotation: Rotation): { width: number; height: number } {
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** Matrix mapping page space -> display space for a page of size w x h shown at rotation r. */
export function pageToDisplayMatrix(w: number, h: number, r: Rotation): Matrix {
  switch (r) {
    case 0:
      return [1, 0, 0, 1, 0, 0];
    case 90:
      return [0, 1, -1, 0, h, 0];
    case 180:
      return [-1, 0, 0, -1, w, h];
    case 270:
      return [0, -1, 1, 0, 0, w];
  }
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  // (m ∘ n)(p) = m(n(p))
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error('Matrix is not invertible');
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** Axis-aligned bounding box of a rect after a matrix (exact for 90° multiples). */
export function transformRect(m: Matrix, r: Rect): Rect {
  const pts = [
    applyMatrix(m, r.x, r.y),
    applyMatrix(m, r.x + r.w, r.y),
    applyMatrix(m, r.x, r.y + r.h),
    applyMatrix(m, r.x + r.w, r.y + r.h),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/**
 * Local frame of a rotated box annotation (text, image). Content is laid out in a
 * frame of size localSize(), origin top-left, y down, then mapped into page space.
 */
export function localSize(rect: Rect, rotation: Rotation): { w: number; h: number } {
  return rotation % 180 === 0 ? { w: rect.w, h: rect.h } : { w: rect.h, h: rect.w };
}

/** Matrix mapping a box annotation's local frame -> page space (clockwise rotation). */
export function localToPageMatrix(rect: Rect, rotation: Rotation): Matrix {
  const { x, y, w, h } = rect;
  switch (rotation) {
    case 0:
      return [1, 0, 0, 1, x, y];
    case 90:
      return [0, 1, -1, 0, x + w, y];
    case 180:
      return [-1, 0, 0, -1, x + w, y + h];
    case 270:
      return [0, -1, 1, 0, x, y + h];
  }
}

/** Rotation a new box annotation needs so it reads upright on a page shown at `viewRotation`. */
export function uprightRotation(viewRotation: Rotation): Rotation {
  return normRotation(360 - viewRotation);
}

/* ---------------------------- annotation geometry ------------------------ */

export function annotationBounds(a: Annotation): Rect {
  switch (a.type) {
    case 'ink': {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < a.points.length; i += 2) {
        minX = Math.min(minX, a.points[i]);
        maxX = Math.max(maxX, a.points[i]);
        minY = Math.min(minY, a.points[i + 1]);
        maxY = Math.max(maxY, a.points[i + 1]);
      }
      const pad = a.width / 2;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
    }
    case 'line': {
      const pad = a.width / 2 + (a.style === 'arrow' ? a.width * 3 : 0);
      const r = normalizeRect(a.x1, a.y1, a.x2, a.y2);
      return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    }
    case 'note':
      return { x: a.x, y: a.y, w: NOTE_SIZE, h: NOTE_SIZE };
    default:
      return a.rect;
  }
}

/** Size of the sticky-note icon in points. */
export const NOTE_SIZE = 20;

export function translateAnnotation<T extends Annotation>(a: T, dx: number, dy: number): T {
  switch (a.type) {
    case 'ink':
      return { ...a, points: a.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) };
    case 'line':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    case 'note':
      return { ...a, x: a.x + dx, y: a.y + dy };
    default:
      return { ...a, rect: { ...(a as { rect: Rect }).rect, x: (a as { rect: Rect }).rect.x + dx, y: (a as { rect: Rect }).rect.y + dy } };
  }
}

/** Scale an annotation so its bounds map from `from` to `to` (used by resize handles). */
export function resizeAnnotation<T extends Annotation>(a: T, from: Rect, to: Rect): T {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  const mx = (x: number) => to.x + (x - from.x) * sx;
  const my = (y: number) => to.y + (y - from.y) * sy;
  switch (a.type) {
    case 'ink':
      return { ...a, points: a.points.map((v, i) => (i % 2 === 0 ? mx(v) : my(v))) };
    case 'line':
      return { ...a, x1: mx(a.x1), y1: my(a.y1), x2: mx(a.x2), y2: my(a.y2) };
    case 'note':
      return { ...a, x: mx(a.x), y: my(a.y) };
    default:
      return { ...a, rect: { ...to } };
  }
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function pointInRect(px: number, py: number, r: Rect, pad = 0): boolean {
  return px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
}

/** Hit test in page space. `tol` is the tolerance in points (grows as the user zooms out). */
export function hitTest(a: Annotation, px: number, py: number, tol: number): boolean {
  switch (a.type) {
    case 'ink': {
      const reach = a.width / 2 + tol;
      if (a.points.length === 2) return Math.hypot(px - a.points[0], py - a.points[1]) <= reach;
      for (let i = 0; i + 3 < a.points.length; i += 2) {
        if (distToSegment(px, py, a.points[i], a.points[i + 1], a.points[i + 2], a.points[i + 3]) <= reach) return true;
      }
      return false;
    }
    case 'line':
      return distToSegment(px, py, a.x1, a.y1, a.x2, a.y2) <= a.width / 2 + tol;
    case 'shape':
      if (a.fillColor) return pointInRect(px, py, a.rect, tol);
      if (a.shape === 'ellipse') {
        const rx = a.rect.w / 2;
        const ry = a.rect.h / 2;
        if (rx <= 0 || ry <= 0) return pointInRect(px, py, a.rect, tol);
        const cx = a.rect.x + rx;
        const cy = a.rect.y + ry;
        const d = Math.hypot((px - cx) / rx, (py - cy) / ry);
        const band = (a.strokeWidth / 2 + tol) / Math.min(rx, ry);
        return Math.abs(d - 1) <= band;
      }
      // Unfilled rectangle: hit the border only, so objects inside stay selectable.
      return pointInRect(px, py, a.rect, tol + a.strokeWidth / 2) && !pointInRect(px, py, a.rect, -(tol + a.strokeWidth / 2));
    default:
      return pointInRect(px, py, annotationBounds(a), tol);
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}
