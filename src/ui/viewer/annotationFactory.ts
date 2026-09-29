import { localSize, normalizeRect } from '../../core/geometry';
import { newId } from '../../core/ids';
import type { Annotation, NoteAnnotation, Rect, Rotation, TextAnnotation } from '../../core/types';
import { layoutText } from '../../engine/textLayout';
import type { Tool, ToolSettings } from '../uiStore';

/** Tools that create an annotation by dragging a rectangle. */
export const BOX_TOOLS: Tool[] = ['rect', 'ellipse', 'highlight', 'whiteout', 'underline', 'strikeout'];
export const LINE_TOOLS: Tool[] = ['line', 'arrow'];
export const INK_TOOLS: Tool[] = ['pen', 'marker'];

/**
 * Pen strokes are "ink" (variable width from pressure or speed); the marker stays a
 * uniform translucent band like a real highlighter.
 */
export function inkFrom(tool: 'pen' | 'marker', s: ToolSettings, points: number[], pressures?: number[], simulate = true): Annotation {
  const marker = tool === 'marker';
  const ink: Annotation = {
    id: newId('an'),
    type: 'ink',
    points,
    color: marker ? s.markerColor : s.penColor,
    width: marker ? s.markerWidth : s.penWidth,
    opacity: marker ? s.markerOpacity : s.penOpacity,
  };
  if (!marker && pressures && pressures.length === points.length / 2) {
    ink.pressures = pressures;
    ink.simulatePressure = simulate;
  }
  return ink;
}

/** Annotation for a box tool dragged from (x1,y1) to (x2,y2) in page space. */
export function boxFrom(tool: Tool, s: ToolSettings, x1: number, y1: number, x2: number, y2: number, square: boolean): Annotation | null {
  let r = normalizeRect(x1, y1, x2, y2);
  if (square && (tool === 'rect' || tool === 'ellipse')) {
    const side = Math.max(r.w, r.h);
    r = { x: x2 < x1 ? x1 - side : x1, y: y2 < y1 ? y1 - side : y1, w: side, h: side };
  }
  const id = newId('an');
  switch (tool) {
    case 'rect':
    case 'ellipse':
      return { id, type: 'shape', shape: tool, rect: r, strokeColor: s.shapeColor, strokeWidth: s.shapeWidth, fillColor: s.shapeFill, opacity: s.shapeOpacity };
    case 'highlight':
      return { id, type: 'highlight', rect: r, color: s.highlightColor, opacity: s.highlightOpacity };
    case 'whiteout':
      return { id, type: 'whiteout', rect: r, color: s.whiteoutColor, opacity: 1 };
    case 'underline':
    case 'strikeout': {
      const y = tool === 'underline' ? r.y + r.h : r.y + r.h / 2;
      return { id, type: 'line', style: tool, x1: r.x, y1: y, x2: r.x + r.w, y2: y, color: s.markupColor, width: Math.max(1, Math.min(3, r.h * 0.08 || 1.5)), opacity: 1 };
    }
    default:
      return null;
  }
}

/** Default box when the user clicks instead of dragging. */
export function defaultBox(tool: Tool, x: number, y: number): [number, number, number, number] {
  switch (tool) {
    case 'rect':
    case 'ellipse':
      return [x - 50, y - 30, x + 50, y + 30];
    case 'highlight':
    case 'whiteout':
      return [x - 60, y - 8, x + 60, y + 8];
    default:
      return [x - 60, y - 7, x + 60, y + 7];
  }
}

export function lineFrom(tool: 'line' | 'arrow', s: ToolSettings, x1: number, y1: number, x2: number, y2: number, snap: boolean): Annotation {
  if (snap) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const step = Math.PI / 4;
    const a = Math.round(ang / step) * step;
    const len = Math.hypot(x2 - x1, y2 - y1);
    x2 = x1 + Math.cos(a) * len;
    y2 = y1 + Math.sin(a) * len;
  }
  return { id: newId('an'), type: 'line', style: tool, x1, y1, x2, y2, color: s.lineColor, width: s.lineWidth, opacity: 1 };
}

export function newText(s: ToolSettings, x: number, y: number, width: number, rotation: Rotation): TextAnnotation {
  const a: TextAnnotation = {
    id: newId('an'),
    type: 'text',
    rect: rotation % 180 === 0 ? { x, y, w: width, h: 20 } : { x, y, w: 20, h: width },
    rotation,
    text: '',
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    bold: s.bold,
    italic: s.italic,
    align: s.align,
    color: s.textColor,
    background: s.textBackground,
    opacity: 1,
  };
  return fitText(a);
}

/** Text boxes grow and shrink vertically to fit their content (width is the user's). */
export function fitText(a: TextAnnotation): TextAnnotation {
  const { w } = localSize(a.rect, a.rotation);
  const h = layoutText({ ...a, text: a.text || ' ', boxWidth: w }).height;
  const rect: Rect = a.rotation % 180 === 0 ? { ...a.rect, h } : { ...a.rect, w: h };
  return rect.w === a.rect.w && rect.h === a.rect.h ? a : { ...a, rect };
}

export function newNote(s: ToolSettings, x: number, y: number): NoteAnnotation {
  return { id: newId('an'), type: 'note', x, y, text: '', color: s.noteColor, opacity: 1 };
}

/* ----------------------------- style editing ----------------------------- */

export interface StylePatch {
  color?: string;
  fill?: string | null;
  width?: number;
  opacity?: number;
  fontFamily?: TextAnnotation['fontFamily'];
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: TextAnnotation['align'];
  background?: string | null;
}

/** Apply a style change to an annotation of any type (fields that do not apply are ignored). */
export function applyStyle(a: Annotation, p: StylePatch): Annotation {
  const opacity = p.opacity ?? a.opacity;
  switch (a.type) {
    case 'ink':
      return { ...a, color: p.color ?? a.color, width: p.width ?? a.width, opacity };
    case 'line':
      return { ...a, color: p.color ?? a.color, width: p.width ?? a.width, opacity };
    case 'shape':
      return { ...a, strokeColor: p.color ?? a.strokeColor, strokeWidth: p.width ?? a.strokeWidth, fillColor: p.fill !== undefined ? p.fill : a.fillColor, opacity };
    case 'highlight':
    case 'whiteout':
    case 'note':
      return { ...a, color: p.color ?? a.color, opacity };
    case 'image':
      return { ...a, opacity };
    case 'text':
      return fitText({
        ...a,
        color: p.color ?? a.color,
        opacity,
        fontFamily: p.fontFamily ?? a.fontFamily,
        fontSize: p.fontSize ?? a.fontSize,
        bold: p.bold ?? a.bold,
        italic: p.italic ?? a.italic,
        align: p.align ?? a.align,
        background: p.background !== undefined ? p.background : a.background,
      });
  }
}

export const TYPE_LABEL: Record<Annotation['type'], string> = {
  ink: 'Drawing',
  text: 'Text',
  shape: 'Shape',
  highlight: 'Highlight',
  whiteout: 'Whiteout',
  line: 'Line',
  note: 'Note',
  image: 'Image',
};
