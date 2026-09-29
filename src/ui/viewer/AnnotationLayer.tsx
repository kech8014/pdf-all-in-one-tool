import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import {
  annotationBounds,
  applyMatrix,
  hitTest,
  invert,
  localSize,
  normRotation,
  pageToDisplayMatrix,
  rectsIntersect,
  resizeAnnotation,
  transformRect,
  translateAnnotation,
  uprightRotation,
  type Matrix,
} from '../../core/geometry';
import { newId } from '../../core/ids';
import type { RecognisedShape } from '../../core/shapes';
import { recogniseShape } from '../../core/shapes';
import type { Annotation, AnnotationId, ImageAnnotation, LineAnnotation, Page, Rect, Rotation } from '../../core/types';
import { useApp } from '../components';
import { ui, useUi } from '../uiStore';
import { AnnotationShape } from './AnnotationShape';
import { BOX_TOOLS, INK_TOOLS, LINE_TOOLS, TYPE_LABEL, boxFrom, defaultBox, fitText, inkFrom, lineFrom, newNote, newText, shapeInk, strokeFrom, strokeIsIsolated } from './annotationFactory';

/**
 * The interactive annotation layer of one page: an SVG in DISPLAY space (points after
 * rotation) whose content group is transformed from PAGE space. Pointer input is mapped
 * back to page space with the inverse matrix, so drawing is accurate at any zoom and any
 * page rotation. Edits are previewed locally and committed to the document once, on
 * pointer-up, which makes every gesture exactly one undo step.
 */

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'p1' | 'p2';

type Gesture =
  | {
      kind: 'ink';
      tool: 'pen' | 'marker';
      points: number[];
      pressures: number[];
      simulate: boolean;
      /** Screen position where the pointer last settled, for hold-to-snap. */
      anchor: [number, number];
      timer: ReturnType<typeof setTimeout> | null;
      /** Set when the user held still at the end: the stroke becomes this shape. */
      snap: RecognisedShape | null;
    }
  | { kind: 'box'; tool: (typeof BOX_TOOLS)[number]; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'line'; tool: 'line' | 'arrow'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'place'; what: 'text' | 'image'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'erase'; ids: Set<AnnotationId> }
  | { kind: 'move'; x0: number; y0: number; orig: Annotation[]; moved: boolean }
  | { kind: 'resize'; handle: Handle; orig: Annotation; origDisp: Rect }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean; base: AnnotationId[] };

interface Props {
  page: Page;
  width: number;
  height: number;
  rotation: Rotation;
  scale: number;
  pageNumber: number;
}

const HANDLE_PX = 9;

/** Stylus pressure when the device reports it; a neutral value otherwise. */
function pressureOf(e: PointerEvent): number {
  return e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
}

let penSeen = false;
const penListeners = new Set<() => void>();
function markPenSeen() {
  if (penSeen) return;
  penSeen = true;
  penListeners.forEach((l) => l());
}
function usePenSeen() {
  const [seen, setSeen] = useState(penSeen);
  useEffect(() => {
    const l = () => setSeen(true);
    penListeners.add(l);
    return () => void penListeners.delete(l);
  }, []);
  return seen;
}

export const AnnotationLayer = memo(function AnnotationLayer({ page, width, height, rotation, scale, pageNumber }: Props) {
  const { ctl } = useApp();
  const tool = useUi((s) => s.tool);
  const settings = useUi((s) => s.settings);
  const selected = useUi((s) => (s.selectedAnns?.pageId === page.id ? s.selectedAnns.ids : null));
  const draftEdit = useUi((s) => (s.editDraft?.pageId === page.id ? s.editDraft : null));
  const pending = useUi((s) => s.pendingImage);
  const stylus = usePenSeen();

  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [creating, setCreating] = useState<Annotation | null>(null);
  const [drafts, setDrafts] = useState<Map<AnnotationId, Annotation> | null>(null);
  const [erased, setErased] = useState<Set<AnnotationId> | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);

  const m: Matrix = useMemo(() => pageToDisplayMatrix(width, height, rotation), [width, height, rotation]);
  const inv = useMemo(() => invert(m), [m]);
  const dispW = rotation % 180 === 0 ? width : height;
  const dispH = rotation % 180 === 0 ? height : width;
  const tol = 6 / scale;

  const shown = page.annotations.map((a) => drafts?.get(a.id) ?? a);
  const selectedSet = new Set(selected ?? []);

  function displayPoint(e: { clientX: number; clientY: number }): [number, number] {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * dispW, ((e.clientY - r.top) / r.height) * dispH];
  }
  function pagePoint(e: { clientX: number; clientY: number }): [number, number] {
    const [dx, dy] = displayPoint(e);
    return applyMatrix(inv, dx, dy);
  }
  function topHit(x: number, y: number): Annotation | null {
    for (let i = shown.length - 1; i >= 0; i--) if (hitTest(shown[i], x, y, tol)) return shown[i];
    return null;
  }

  function startEditing(a: Annotation) {
    if (a.type === 'text' || a.type === 'note') {
      ui.set({ editDraft: { pageId: page.id, ann: a, isNew: false }, selectedAnns: { pageId: page.id, ids: [a.id] } });
    }
  }

  function onPointerDown(e: RPointerEvent<SVGSVGElement>) {
    if (e.button !== 0 || tool === 'hand') return;
    if (e.pointerType === 'pen') markPenSeen();
    // Palm rejection: once a stylus has been used, fingers scroll and zoom instead of drawing.
    if (e.pointerType === 'touch' && penSeen && tool !== 'select') return;
    const target = e.target as Element;
    const [x, y] = pagePoint(e);
    const handle = target.getAttribute('data-handle') as Handle | null;
    e.currentTarget.setPointerCapture(e.pointerId);
    ctl.setActive(page.id);

    // Finish any text/note being edited before starting something new.
    if (ui.get().editDraft && !target.closest('.text-editor')) (document.activeElement as HTMLElement | null)?.blur?.();

    if (tool === 'select') {
      if (handle && selected?.length === 1) {
        const orig = shown.find((a) => a.id === selected[0]);
        if (orig) {
          gesture.current = { kind: 'resize', handle, orig, origDisp: transformRect(m, annotationBounds(orig)) };
          return;
        }
      }
      const hit = topHit(x, y);
      if (hit) {
        let ids = selected ?? [];
        if (e.shiftKey) ids = selectedSet.has(hit.id) ? ids.filter((i) => i !== hit.id) : [...ids, hit.id];
        else if (!selectedSet.has(hit.id)) ids = [hit.id];
        ui.selectAnns(page.id, ids);
        const orig = page.annotations.filter((a) => ids.includes(a.id));
        gesture.current = { kind: 'move', x0: x, y0: y, orig, moved: false };
      } else {
        const [dx, dy] = displayPoint(e);
        if (!e.shiftKey) ui.clearAnns();
        gesture.current = { kind: 'marquee', x0: dx, y0: dy, x1: dx, y1: dy, additive: e.shiftKey, base: e.shiftKey ? (selected ?? []) : [] };
      }
      return;
    }

    ui.clearAnns();
    if (INK_TOOLS.includes(tool)) {
      const simulate = e.pointerType !== 'pen';
      const g: Gesture = { kind: 'ink', tool: tool as 'pen' | 'marker', points: [x, y], pressures: [pressureOf(e.nativeEvent)], simulate, anchor: [e.clientX, e.clientY], timer: null, snap: null };
      gesture.current = g;
      armHold(g);
      setCreating(inkFrom(tool as 'pen' | 'marker', settings, [x, y], [pressureOf(e.nativeEvent)], simulate));
    } else if (BOX_TOOLS.includes(tool)) {
      gesture.current = { kind: 'box', tool, x0: x, y0: y, x1: x, y1: y };
    } else if (LINE_TOOLS.includes(tool)) {
      gesture.current = { kind: 'line', tool: tool as 'line' | 'arrow', x0: x, y0: y, x1: x, y1: y };
    } else if (tool === 'eraser') {
      gesture.current = { kind: 'erase', ids: new Set() };
      eraseAt(x, y);
    } else if (tool === 'text') {
      const hit = topHit(x, y);
      if (hit && hit.type === 'text') {
        startEditing(hit);
        gesture.current = null;
        return;
      }
      gesture.current = { kind: 'place', what: 'text', x0: x, y0: y, x1: x, y1: y };
    } else if (tool === 'note') {
      const hit = topHit(x, y);
      if (hit && hit.type === 'note') startEditing(hit);
      else ui.set({ editDraft: { pageId: page.id, ann: newNote(settings, x - 4, y - 4), isNew: true } });
      gesture.current = null;
    } else if (tool === 'image') {
      if (!pending) {
        gesture.current = null;
        document.getElementById('image-picker')?.click();
        return;
      }
      gesture.current = { kind: 'place', what: 'image', x0: x, y0: y, x1: x, y1: y };
    }
  }

  function eraseAt(x: number, y: number) {
    const g = gesture.current;
    if (!g || g.kind !== 'erase') return;
    const reach = Math.max(tol, settings.eraserSize / 2 / scale);
    let changed = false;
    for (const a of page.annotations) {
      if (!g.ids.has(a.id) && hitTest(a, x, y, reach)) {
        g.ids.add(a.id);
        changed = true;
      }
    }
    if (changed) setErased(new Set(g.ids));
  }

  /**
   * Hold-to-snap: when the pointer rests (still pressed) for half a second at the end of
   * a stroke, the stroke turns into the shape it resembles — the preview shows it at
   * once, and releasing keeps it.
   */
  function armHold(g: Extract<Gesture, { kind: 'ink' }>) {
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    if (settings.penShapes === 'off') return;
    g.timer = setTimeout(() => {
      g.timer = null;
      if (gesture.current !== g || g.snap) return;
      const shape = recogniseShape(g.points, { unit: 1 / scale, mode: 'hold' });
      if (!shape) return;
      g.snap = shape;
      setCreating(shapeInk(g.tool, settings, shape));
    }, 550);
  }

  function onPointerMove(e: RPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (tool === 'eraser') setHover(displayPoint(e));
    if (!g) return;
    const [x, y] = pagePoint(e);
    switch (g.kind) {
      case 'ink': {
        const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
        for (const ev of events.length ? events : [e.nativeEvent]) {
          g.points.push(...pagePoint(ev));
          g.pressures.push(pressureOf(ev));
        }
        const moved = Math.hypot(e.clientX - g.anchor[0], e.clientY - g.anchor[1]);
        if (g.snap) {
          // Moving on after a snap: back to freehand.
          if (moved > 10) {
            g.snap = null;
            g.anchor = [e.clientX, e.clientY];
            armHold(g);
          } else break;
        } else if (moved > 3) {
          g.anchor = [e.clientX, e.clientY];
          armHold(g);
        }
        setCreating(strokeFrom(g.tool, settings, g.points, g.pressures, g.simulate, 1 / scale, false));
        break;
      }
      case 'box':
        g.x1 = x;
        g.y1 = y;
        setCreating(boxFrom(g.tool, settings, g.x0, g.y0, x, y, e.shiftKey));
        break;
      case 'line':
        g.x1 = x;
        g.y1 = y;
        setCreating(lineFrom(g.tool, settings, g.x0, g.y0, x, y, e.shiftKey));
        break;
      case 'place':
        g.x1 = x;
        g.y1 = y;
        break;
      case 'erase':
        eraseAt(x, y);
        break;
      case 'move': {
        let dx = x - g.x0;
        let dy = y - g.y0;
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        if (!g.moved && Math.hypot(dx, dy) * scale < 3) return;
        g.moved = true;
        setDrafts(new Map(g.orig.map((a) => [a.id, translateAnnotation(a, dx, dy)])));
        break;
      }
      case 'resize': {
        const next = resizeTo(g, displayPoint(e), e.shiftKey);
        if (next) setDrafts(new Map([[next.id, next]]));
        break;
      }
      case 'marquee': {
        const [dx, dy] = displayPoint(e);
        g.x1 = dx;
        g.y1 = dy;
        setMarquee({ x: Math.min(g.x0, dx), y: Math.min(g.y0, dy), w: Math.abs(dx - g.x0), h: Math.abs(dy - g.y0) });
        break;
      }
    }
  }

  function resizeTo(g: Extract<Gesture, { kind: 'resize' }>, [px, py]: [number, number], free: boolean): Annotation | null {
    const a = g.orig;
    if (g.handle === 'p1' || g.handle === 'p2') {
      const [x, y] = applyMatrix(inv, px, py);
      const l = a as LineAnnotation;
      return g.handle === 'p1' ? { ...l, x1: x, y1: y } : { ...l, x2: x, y2: y };
    }
    const o = g.origDisp;
    let x0 = o.x;
    let y0 = o.y;
    let x1 = o.x + o.w;
    let y1 = o.y + o.h;
    if (g.handle.includes('w')) x0 = Math.min(px, x1 - 4);
    if (g.handle.includes('e')) x1 = Math.max(px, x0 + 4);
    if (g.handle.includes('n')) y0 = Math.min(py, y1 - 4);
    if (g.handle.includes('s')) y1 = Math.max(py, y0 + 4);
    const corner = g.handle.length === 2;
    if (corner && a.type === 'image' && !free) {
      // Keep the picture's proportions on corner drags.
      const k = Math.max((x1 - x0) / o.w, (y1 - y0) / o.h);
      const w = o.w * k;
      const h = o.h * k;
      if (g.handle.includes('w')) x0 = x1 - w;
      else x1 = x0 + w;
      if (g.handle.includes('n')) y0 = y1 - h;
      else y1 = y0 + h;
    }
    const newPage = transformRect(inv, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    if (a.type === 'text') return fitText({ ...a, rect: newPage });
    return resizeAnnotation(a, annotationBounds(a), newPage);
  }

  function onPointerUp(e: RPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const [x, y] = pagePoint(e);
    switch (g.kind) {
      case 'ink': {
        if (g.timer) clearTimeout(g.timer);
        const ann = g.snap ? shapeInk(g.tool, settings, g.snap) : strokeFrom(g.tool, settings, g.points, g.pressures, g.simulate, 1 / scale, true, strokeIsIsolated(g.points, page.annotations));
        ctl.addAnnotation(page.id, ann, g.tool === 'marker' ? 'Drew with the marker' : `Drew with the pen (${settings.penWidth}px)`);
        setCreating(null);
        break;
      }
      case 'box': {
        const small = Math.abs(g.x1 - g.x0) * scale < 4 && Math.abs(g.y1 - g.y0) * scale < 4;
        const [a0, b0, a1, b1] = small ? defaultBox(g.tool, x, y) : [g.x0, g.y0, g.x1, g.y1];
        const ann = boxFrom(g.tool, settings, a0, b0, a1, b1, e.shiftKey);
        if (ann) ctl.addAnnotation(page.id, ann, `Added ${g.tool === 'rect' ? 'rectangle' : g.tool}`);
        setCreating(null);
        break;
      }
      case 'line': {
        const small = Math.hypot(g.x1 - g.x0, g.y1 - g.y0) * scale < 4;
        const ann = small ? lineFrom(g.tool, settings, x - 40, y, x + 40, y, false) : lineFrom(g.tool, settings, g.x0, g.y0, g.x1, g.y1, e.shiftKey);
        ctl.addAnnotation(page.id, ann, `Added ${g.tool}`);
        setCreating(null);
        break;
      }
      case 'place': {
        const dragW = Math.abs(g.x1 - g.x0);
        const dragH = Math.abs(g.y1 - g.y0);
        const x0 = Math.min(g.x0, g.x1);
        const y0 = Math.min(g.y0, g.y1);
        if (g.what === 'text') {
          const upright = uprightRotation(rotation);
          const room = (upright % 180 === 0 ? width - x0 : height - y0) - 8;
          const w = dragW * scale > 20 ? (upright % 180 === 0 ? dragW : dragH) : Math.max(60, Math.min(260, room));
          const t = newText(settings, x0, y0, w, upright);
          ui.set({ editDraft: { pageId: page.id, ann: t, isNew: true }, selectedAnns: null });
        } else if (pending) {
          placeImage(x0, y0, dragW * scale > 10 ? dragW : 0, dragH * scale > 10 ? dragH : 0, g.x0, g.y0);
        }
        break;
      }
      case 'erase':
        if (g.ids.size) ctl.removeAnnotations([...g.ids].map((id) => ({ pageId: page.id, annotationId: id })), g.ids.size === 1 ? 'Erased annotation' : `Erased ${g.ids.size} annotations`);
        setErased(null);
        break;
      case 'move':
        if (g.moved && drafts) {
          const n = drafts.size;
          ctl.updateAnnotations(page.id, [...drafts.values()], n === 1 ? `Moved ${TYPE_LABEL[g.orig[0].type].toLowerCase()}` : `Moved ${n} annotations`);
        }
        setDrafts(null);
        break;
      case 'resize':
        if (drafts) ctl.updateAnnotations(page.id, [...drafts.values()], `Resized ${TYPE_LABEL[g.orig.type].toLowerCase()}`);
        setDrafts(null);
        break;
      case 'marquee': {
        const r = { x: Math.min(g.x0, g.x1), y: Math.min(g.y0, g.y1), w: Math.abs(g.x1 - g.x0), h: Math.abs(g.y1 - g.y0) };
        if (r.w * scale > 3 || r.h * scale > 3) {
          const hits = page.annotations.filter((a) => rectsIntersect(transformRect(m, annotationBounds(a)), r)).map((a) => a.id);
          ui.selectAnns(page.id, [...new Set([...g.base, ...hits])]);
        }
        setMarquee(null);
        break;
      }
    }
  }

  function placeImage(x0: number, y0: number, dragW: number, dragH: number, cx: number, cy: number) {
    if (!pending) return;
    const upright = uprightRotation(rotation);
    const natW = upright % 180 === 0 ? pending.width : pending.height;
    const natH = upright % 180 === 0 ? pending.height : pending.width;
    let w: number;
    let h: number;
    if (dragW && dragH) {
      const k = Math.min(dragW / natW, dragH / natH);
      w = natW * k;
      h = natH * k;
    } else {
      const target = (pending.signature ? 0.3 : 0.4) * Math.min(width, height);
      const k = Math.min(target / Math.max(natW, natH), 1.5);
      w = natW * k;
      h = natH * k;
      x0 = cx - w / 2;
      y0 = cy - h / 2;
    }
    const ann: ImageAnnotation = {
      id: newId('an'),
      type: 'image',
      rect: { x: x0, y: y0, w, h },
      rotation: upright,
      blobId: pending.blobId,
      mime: pending.mime,
      naturalWidth: pending.width,
      naturalHeight: pending.height,
      signature: pending.signature,
      opacity: 1,
    };
    ctl.addAnnotation(page.id, ann, pending.signature ? 'Added signature' : 'Placed image');
    ui.set({ tool: 'select', selectedAnns: { pageId: page.id, ids: [ann.id] }, pendingImage: pending.signature ? null : pending });
  }

  function onDoubleClick(e: RMouseEvent<SVGSVGElement>) {
    if (tool !== 'select' && tool !== 'text') return;
    const [x, y] = pagePoint(e);
    const hit = topHit(x, y);
    if (hit) startEditing(hit);
  }

  /* --------------------------------- render -------------------------------- */

  const selectedShown = shown.filter((a) => selectedSet.has(a.id));
  const hs = HANDLE_PX / scale;
  const cursor =
    tool === 'select' ? 'default' : tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : tool === 'eraser' ? 'none' : tool === 'image' && !pending ? 'pointer' : 'crosshair';

  function handlesFor(a: Annotation) {
    if (a.type === 'line') {
      const p1 = applyMatrix(m, a.x1, a.y1);
      const p2 = applyMatrix(m, a.x2, a.y2);
      return (['p1', 'p2'] as const).map((h, i) => {
        const [cx, cy] = i === 0 ? p1 : p2;
        return <circle key={h} data-handle={h} className="ann-handle" cx={cx} cy={cy} r={hs / 1.6} strokeWidth={1.5 / scale} />;
      });
    }
    if (a.type === 'note') return null;
    const r = transformRect(m, annotationBounds(a));
    let list: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    if (a.type === 'text') list = normRotation(a.rotation + rotation) % 180 === 0 ? ['w', 'e'] : ['n', 's'];
    const pos: Record<string, [number, number]> = {
      nw: [r.x, r.y],
      n: [r.x + r.w / 2, r.y],
      ne: [r.x + r.w, r.y],
      e: [r.x + r.w, r.y + r.h / 2],
      se: [r.x + r.w, r.y + r.h],
      s: [r.x + r.w / 2, r.y + r.h],
      sw: [r.x, r.y + r.h],
      w: [r.x, r.y + r.h / 2],
    };
    return list.map((h) => (
      <rect key={h} data-handle={h} className={`ann-handle h-${h}`} x={pos[h][0] - hs / 2} y={pos[h][1] - hs / 2} width={hs} height={hs} strokeWidth={1.5 / scale} />
    ));
  }

  const editingId = draftEdit?.ann.id;
  return (
    <svg
      ref={svgRef}
      className="ann-layer"
      data-testid={`ann-layer-${pageNumber}`}
      viewBox={`0 0 ${dispW} ${dispH}`}
      preserveAspectRatio="none"
      style={{ cursor, pointerEvents: tool === 'hand' ? 'none' : 'auto', touchAction: stylus ? 'pan-x pan-y pinch-zoom' : 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gesture.current = null;
        setCreating(null);
        setDrafts(null);
        setErased(null);
        setMarquee(null);
      }}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={onDoubleClick}
    >
      <g transform={`matrix(${m.join(' ')})`}>
        {shown.map((a) =>
          erased?.has(a.id) || a.id === editingId ? (
            a.type === 'text' ? <AnnotationShape key={a.id} a={a} hidden /> : null
          ) : (
            <g key={a.id} data-ann-id={a.id} data-ann-type={a.type}>
              <AnnotationShape a={a} />
              {a.type === 'note' && <title>{a.text || 'Empty note'}</title>}
            </g>
          ),
        )}
        {creating && <AnnotationShape a={creating} />}
        {draftEdit?.ann.type === 'note' && <AnnotationShape a={draftEdit.ann} />}
      </g>
      {selectedShown.map((a) => {
        const r = transformRect(m, annotationBounds(a));
        const pad = 2 / scale;
        return <rect key={`sel-${a.id}`} className="ann-selection" x={r.x - pad} y={r.y - pad} width={r.w + 2 * pad} height={r.h + 2 * pad} strokeWidth={1.2 / scale} strokeDasharray={`${4 / scale} ${3 / scale}`} />;
      })}
      {selectedShown.length === 1 && tool === 'select' && handlesFor(selectedShown[0])}
      {marquee && <rect className="ann-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} strokeWidth={1 / scale} />}
      {tool === 'eraser' && hover && <circle className="eraser-cursor" cx={hover[0]} cy={hover[1]} r={Math.max(tol, settings.eraserSize / 2 / scale)} strokeWidth={1 / scale} />}
    </svg>
  );
});

/** Size of a text annotation's local frame on screen (used by the editor overlay). */
export function textLocalCss(a: { rect: Rect; rotation: Rotation }, scale: number) {
  const { w, h } = localSize(a.rect, a.rotation);
  return { w: w * scale, h: h * scale };
}
