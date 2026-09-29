import { useSyncExternalStore } from 'react';
import type { AnnotationId, BlobId, FontFamily, NoteAnnotation, PageId, TextAlign, TextAnnotation } from '../core/types';

/**
 * UI-only state: the active tool and its settings, zoom, which annotations are selected,
 * which dialog is open. None of this is part of the document, so none of it is in the
 * undo history. Tool settings persist in localStorage between visits.
 */

export type Tool =
  | 'select'
  | 'hand'
  | 'text'
  | 'pen'
  | 'marker'
  | 'eraser'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'whiteout'
  | 'note'
  | 'image';

export interface ToolSettings {
  penColor: string;
  penWidth: number;
  penOpacity: number;
  /** Freehand clean-up: 'auto' snaps clear shapes, 'hold' only when you pause at the end, 'off' never. */
  penShapes: 'auto' | 'hold' | 'off';
  markerColor: string;
  markerWidth: number;
  markerOpacity: number;
  textColor: string;
  fontFamily: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  textBackground: string | null;
  shapeColor: string;
  shapeWidth: number;
  shapeFill: string | null;
  shapeOpacity: number;
  lineColor: string;
  lineWidth: number;
  highlightColor: string;
  highlightOpacity: number;
  markupColor: string;
  whiteoutColor: string;
  noteColor: string;
  eraserSize: number;
}

export const DEFAULT_SETTINGS: ToolSettings = {
  penColor: '#e11d2a',
  penWidth: 3,
  penOpacity: 1,
  penShapes: 'auto',
  markerColor: '#ffe14d',
  markerWidth: 14,
  markerOpacity: 0.45,
  textColor: '#e11d2a',
  fontFamily: 'helvetica',
  fontSize: 14,
  bold: false,
  italic: false,
  align: 'left',
  textBackground: null,
  shapeColor: '#e11d2a',
  shapeWidth: 2,
  shapeFill: null,
  shapeOpacity: 1,
  lineColor: '#e11d2a',
  lineWidth: 2,
  highlightColor: '#ffe14d',
  highlightOpacity: 0.5,
  markupColor: '#e11d2a',
  whiteoutColor: '#ffffff',
  noteColor: '#ffd400',
  eraserSize: 10,
};

export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

export type DialogState =
  | { kind: 'insert'; index: number; mode: 'insert' | 'replace'; accept: 'pdf' | 'image' | 'any'; files?: File[]; replacePageId?: PageId }
  | { kind: 'compress' }
  | { kind: 'export'; pageIds?: PageId[] }
  | { kind: 'workspaces' }
  | { kind: 'transfer'; pageIds: PageId[] }
  | { kind: 'signature' }
  | { kind: 'shortcuts' }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void };

export interface PendingImage {
  blobId: BlobId;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  signature: boolean;
  previewUrl: string;
}

export interface UiState {
  tool: Tool;
  settings: ToolSettings;
  zoom: number;
  zoomMode: ZoomMode;
  view: 'edit' | 'organize';
  selectedAnns: { pageId: PageId; ids: AnnotationId[] } | null;
  /** Text box or sticky note being edited (not in the document until committed). */
  editDraft: { pageId: PageId; ann: TextAnnotation | NoteAnnotation; isNew: boolean } | null;
  dialog: DialogState | null;
  historyOpen: boolean;
  sidebarOpen: boolean;
  pendingImage: PendingImage | null;
  /** Bumped to ask the viewer to scroll the active page into view. */
  scrollRequest: number;
  /** Handwriting -> text is running. */
  recognising: boolean;
}

const SETTINGS_KEY = 'pdf-workspace:tool-settings';

function loadSettings(): ToolSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

class UiStore {
  private listeners = new Set<() => void>();
  state: UiState = {
    tool: 'select',
    settings: typeof localStorage === 'undefined' ? { ...DEFAULT_SETTINGS } : loadSettings(),
    zoom: 1,
    zoomMode: 'fit-width',
    view: 'edit',
    selectedAnns: null,
    editDraft: null,
    dialog: null,
    recognising: false,
    historyOpen: false,
    sidebarOpen: true,
    pendingImage: null,
    scrollRequest: 0,
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.state;

  set(patch: Partial<UiState>) {
    this.state = { ...this.state, ...patch };
    if (patch.settings) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.state.settings));
      } catch {
        /* ignore */
      }
    }
    for (const l of this.listeners) l();
  }

  setTool(tool: Tool) {
    this.set({ tool, editDraft: null, selectedAnns: tool === 'select' ? this.state.selectedAnns : null, pendingImage: tool === 'image' ? this.state.pendingImage : null });
  }
  updateSettings(patch: Partial<ToolSettings>) {
    this.set({ settings: { ...this.state.settings, ...patch } });
  }
  selectAnns(pageId: PageId, ids: AnnotationId[]) {
    this.set({ selectedAnns: ids.length ? { pageId, ids } : null });
  }
  clearAnns() {
    if (this.state.selectedAnns) this.set({ selectedAnns: null });
  }
  openDialog(dialog: DialogState) {
    this.set({ dialog });
  }
  closeDialog() {
    this.set({ dialog: null });
  }
  requestScroll() {
    this.set({ scrollRequest: this.state.scrollRequest + 1 });
  }
}

export const ui = new UiStore();

export function useUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(ui.subscribe, () => select(ui.get()));
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
/** CSS pixels per PDF point at 100% (a PDF point is 1/72 in, a CSS pixel 1/96 in). */
export const PT_TO_PX = 96 / 72;
