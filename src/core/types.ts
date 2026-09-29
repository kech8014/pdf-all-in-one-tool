/**
 * Canonical workspace model.
 *
 * The workspace never stores rendered pixels or a "current output PDF". It stores:
 *   - immutable SOURCES: validated PDF files (images and blank pages are converted to
 *     one-page PDFs on ingest), referenced by a blob id in the blob store;
 *   - an ordered list of PAGES, each a stable-id reference to (source, page index)
 *     plus a user rotation and its own annotation layer.
 *
 * Every operation is a pure function State -> State (see operations.ts). The final
 * PDF is generated from this state only at export time (engine/export.ts), so
 * vector content, fonts and embedded images of the originals are copied through
 * untouched and annotations stay editable until the user exports.
 */

export type SourceId = string;
export type PageId = string;
export type AnnotationId = string;
export type BlobId = string;

export type Rotation = 0 | 90 | 180 | 270;

/** Geometry of one page of a source, as the PDF defines it (before any rotation). */
export interface SourcePageInfo {
  /** Visible box (CropBox) width in PDF points, unrotated. */
  width: number;
  /** Visible box (CropBox) height in PDF points, unrotated. */
  height: number;
  /** The page's own /Rotate value, normalised to 0/90/180/270. */
  rotation: Rotation;
}

export type SourceOrigin = 'pdf' | 'image' | 'blank';

export interface SourceDoc {
  id: SourceId;
  /** File name shown to the user. */
  name: string;
  origin: SourceOrigin;
  /** Bytes of a valid, unencrypted PDF in the blob store. */
  blobId: BlobId;
  byteLength: number;
  pageCount: number;
  pages: SourcePageInfo[];
  /** Set when the source was replaced by a compressed version. */
  compression?: { level: CompressionLevel; originalBytes: number };
}

export type CompressionLevel = 'lossless' | 'balanced' | 'strong';

export interface Page {
  id: PageId;
  sourceId: SourceId;
  sourcePageIndex: number;
  /** Rotation added by the user, on top of the source page's own rotation. */
  rotation: Rotation;
  /** Annotations in page space (see geometry.ts). Order = paint order (last on top). */
  annotations: Annotation[];
}

export interface WorkspaceMeta {
  title: string;
  author: string;
  subject: string;
}

export interface WorkspaceState {
  schema: 1;
  id: string;
  name: string;
  createdAt: number;
  sources: Record<SourceId, SourceDoc>;
  pages: Page[];
  meta: WorkspaceMeta;
}

/* ------------------------------------------------------------------------- */
/* Annotations                                                               */
/*                                                                           */
/* All coordinates are in PAGE SPACE: PDF points, origin at the top-left of   */
/* the page's unrotated visible box, y pointing down. Because the space is   */
/* attached to the page and not to the screen, annotations follow the page   */
/* through reordering, rotation, duplication and compression untouched.     */
/* ------------------------------------------------------------------------- */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FontFamily = 'helvetica' | 'times' | 'courier';
export type TextAlign = 'left' | 'center' | 'right';

interface AnnotationBase {
  id: AnnotationId;
  /** 0..1 */
  opacity: number;
}

/** One freehand stroke. Points are a flat [x0, y0, x1, y1, ...] list. */
export interface InkAnnotation extends AnnotationBase {
  type: 'ink';
  points: number[];
  color: string;
  /** Nominal thickness. With `pressures`, the stroke swells and thins around it. */
  width: number;
  /**
   * Pen pressure per point (0..1). Present = "ink" rendering: a filled, variable-width
   * outline. Absent = a uniform stroke (marker, older drawings).
   */
  pressures?: number[];
  /** True when the device gave no real pressure: width then follows drawing speed. */
  simulatePressure?: boolean;
  /** Set when smart shapes turned the stroke into a perfect figure (line, circle…). */
  shape?: string;
}

export interface TextAnnotation extends AnnotationBase {
  type: 'text';
  /** Axis-aligned box in page space. */
  rect: Rect;
  /**
   * Clockwise rotation of the text relative to page space. Set when the text is
   * placed on a rotated page so it reads upright on screen; it then turns with
   * the page if the page is rotated later, exactly like printed text.
   */
  rotation: Rotation;
  text: string;
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  color: string;
  /** Optional box fill (null = transparent). */
  background: string | null;
}

export type ShapeKind = 'rect' | 'ellipse';

export interface ShapeAnnotation extends AnnotationBase {
  type: 'shape';
  shape: ShapeKind;
  rect: Rect;
  strokeColor: string;
  strokeWidth: number;
  fillColor: string | null;
}

/** Translucent area highlight painted with a multiply blend. */
export interface HighlightAnnotation extends AnnotationBase {
  type: 'highlight';
  rect: Rect;
  color: string;
}

/** Opaque cover. Visually hides content; see the README for why it is not a redaction. */
export interface WhiteoutAnnotation extends AnnotationBase {
  type: 'whiteout';
  rect: Rect;
  color: string;
}

export type LineStyle = 'line' | 'arrow' | 'underline' | 'strikeout';

export interface LineAnnotation extends AnnotationBase {
  type: 'line';
  style: LineStyle;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

/** Sticky note: exported as a real PDF comment (/Text annotation). */
export interface NoteAnnotation extends AnnotationBase {
  type: 'note';
  x: number;
  y: number;
  text: string;
  color: string;
}

/** Picture placed on a page (stamps, logos, signatures). */
export interface ImageAnnotation extends AnnotationBase {
  type: 'image';
  rect: Rect;
  rotation: Rotation;
  blobId: BlobId;
  mime: 'image/png' | 'image/jpeg';
  /** Pixel size of the stored image, used for aspect-ratio locking. */
  naturalWidth: number;
  naturalHeight: number;
  /** True for signatures drawn in the signature pad. */
  signature?: boolean;
}

export type Annotation =
  | InkAnnotation
  | TextAnnotation
  | ShapeAnnotation
  | HighlightAnnotation
  | WhiteoutAnnotation
  | LineAnnotation
  | NoteAnnotation
  | ImageAnnotation;

export type AnnotationType = Annotation['type'];

/** Distributive Omit so each union member keeps its own fields. */
export type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type NewAnnotation = WithoutId<Annotation>;
