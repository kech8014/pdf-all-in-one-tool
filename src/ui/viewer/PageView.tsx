import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HIGHLIGHT_COLORS } from '../../core/color';
import { NOTE_SIZE, applyMatrix, localSize, normRotation, pageToDisplayMatrix, transformRect } from '../../core/geometry';
import type { NoteAnnotation, Page, Rotation, TextAnnotation } from '../../core/types';
import { CSS_FONT, LINE_HEIGHT, TEXT_PADDING, hasUnsupportedChars } from '../../engine/textLayout';
import { renderPage } from '../../render/pdfRender';
import { ColorPicker, useApp } from '../components';
import { Icon } from '../Icon';
import { ui, useUi } from '../uiStore';
import { AnnotationLayer } from './AnnotationLayer';
import { fitText } from './annotationFactory';
import { commitEditDraft } from './editing';

interface Props {
  page: Page;
  blobId: string;
  sourceIndex: number;
  width: number;
  height: number;
  rotation: Rotation;
  scale: number;
  pageNumber: number;
  active: boolean;
}

/**
 * One page in the viewer: the pdf.js rendering (a pure view of the source) with the
 * annotation layer on top. Re-renders only when its source, rotation or zoom changes;
 * annotation edits never trigger a canvas re-render.
 */
export const PageView = memo(function PageView(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const dispW = p.rotation % 180 === 0 ? p.width : p.height;
  const dispH = p.rotation % 180 === 0 ? p.height : p.width;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setError(null);
    // Debounce during continuous zooming so we do not start a render per wheel tick.
    let handle: ReturnType<typeof renderPage> | null = null;
    const t = setTimeout(() => {
      handle = renderPage(canvas, p.blobId, p.sourceIndex, p.rotation, p.scale);
      handle.promise.then(() => setReady(true)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, 60);
    return () => {
      clearTimeout(t);
      handle?.cancel();
    };
  }, [p.blobId, p.sourceIndex, p.rotation, p.scale]);

  return (
    <div
      className={`page-view ${p.active ? 'is-active' : ''}`}
      style={{ width: dispW * p.scale, height: dispH * p.scale }}
      data-page-number={p.pageNumber}
      data-page-id={p.page.id}
    >
      <canvas ref={canvasRef} className="page-canvas" style={{ width: '100%', height: '100%', opacity: ready ? 1 : 0 }} />
      {!ready && !error && <div className="page-loading">Loading page {p.pageNumber}…</div>}
      {error && (
        <div className="page-error" role="alert">
          <Icon name="alert" /> {error}
        </div>
      )}
      <AnnotationLayer page={p.page} width={p.width} height={p.height} rotation={p.rotation} scale={p.scale} pageNumber={p.pageNumber} />
      <EditOverlay pageId={p.page.id} width={p.width} height={p.height} rotation={p.rotation} scale={p.scale} />
    </div>
  );
});

function EditOverlay({ pageId, width, height, rotation, scale }: { pageId: string; width: number; height: number; rotation: Rotation; scale: number }) {
  const draft = useUi((s) => (s.editDraft?.pageId === pageId ? s.editDraft : null));
  if (!draft) return null;
  return draft.ann.type === 'text' ? (
    <TextEditor key={draft.ann.id} ann={draft.ann} width={width} height={height} rotation={rotation} scale={scale} />
  ) : (
    <NoteEditor key={draft.ann.id} ann={draft.ann} isNew={draft.isNew} width={width} height={height} rotation={rotation} scale={scale} />
  );
}

function TextEditor({ ann, width, height, rotation, scale }: { ann: TextAnnotation; width: number; height: number; rotation: Rotation; scale: number }) {
  const { ctl } = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const m = pageToDisplayMatrix(width, height, rotation);
  const disp = transformRect(m, ann.rect);
  const { w, h } = localSize(ann.rect, ann.rotation);
  const angle = normRotation(ann.rotation + rotation);
  const [extra, setExtra] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setExtra(Math.max(0, el.scrollHeight - h * scale));
  }, [ann.text, ann.fontSize, h, scale]);

  const update = (text: string) => {
    const d = ui.get().editDraft;
    if (d && d.ann.type === 'text') ui.set({ editDraft: { ...d, ann: fitText({ ...d.ann, text }) } });
  };
  const warn = hasUnsupportedChars(ann.text, ann.fontFamily);

  return (
    <div
      className="text-editor"
      style={{
        left: (disp.x + disp.w / 2) * scale,
        top: (disp.y + disp.h / 2) * scale,
        width: w * scale,
        transform: `translate(-50%, -50%) rotate(${angle}deg)`,
      }}
    >
      <textarea
        ref={ref}
        data-testid="text-editor"
        value={ann.text}
        placeholder="Type here…"
        spellCheck
        onChange={(e) => update(e.target.value)}
        onBlur={() => commitEditDraft(ctl)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            commitEditDraft(ctl);
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          height: h * scale + extra,
          fontFamily: CSS_FONT[ann.fontFamily],
          fontSize: ann.fontSize * scale,
          fontWeight: ann.bold ? 700 : 400,
          fontStyle: ann.italic ? 'italic' : 'normal',
          lineHeight: LINE_HEIGHT,
          padding: TEXT_PADDING * scale,
          textAlign: ann.align,
          color: ann.color,
          background: ann.background ?? 'rgba(255,255,255,0.35)',
          opacity: ann.opacity,
        }}
      />
      {warn && <div className="text-warning">Some characters are not in the PDF standard fonts and will export as “?”.</div>}
    </div>
  );
}

function NoteEditor({ ann, isNew, width, height, rotation, scale }: { ann: NoteAnnotation; isNew: boolean; width: number; height: number; rotation: Rotation; scale: number }) {
  const { ctl } = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const m = pageToDisplayMatrix(width, height, rotation);
  const [dx, dy] = applyMatrix(m, ann.x + NOTE_SIZE, ann.y);
  useEffect(() => ref.current?.focus(), []);
  const set = (patch: Partial<NoteAnnotation>) => {
    const d = ui.get().editDraft;
    if (d && d.ann.type === 'note') ui.set({ editDraft: { ...d, ann: { ...d.ann, ...patch } } });
  };
  return (
    <div className="note-editor" style={{ left: dx * scale + 6, top: dy * scale }} onPointerDown={(e) => e.stopPropagation()} data-testid="note-editor">
      <div className="note-editor-head">
        <strong>{isNew ? 'New note' : 'Note'}</strong>
        <ColorPicker label="Note colour" value={ann.color} presets={HIGHLIGHT_COLORS} onChange={(c) => c && set({ color: c })} />
      </div>
      <textarea
        ref={ref}
        value={ann.text}
        placeholder="Write a comment…"
        onChange={(e) => set({ text: e.target.value })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) commitEditDraft(ctl);
        }}
      />
      <div className="note-editor-foot">
        <span className="muted">Exported as a PDF comment</span>
        {!isNew && (
          <button
            type="button"
            className="btn btn-labelled btn-ghost"
            onClick={() => {
              const d = ui.get().editDraft;
              ui.set({ editDraft: null, selectedAnns: null });
              if (d) ctl.removeAnnotations([{ pageId: d.pageId, annotationId: ann.id }], 'Deleted note');
            }}
          >
            Delete
          </button>
        )}
        <button type="button" className="btn btn-labelled btn-primary" onClick={() => commitEditDraft(ctl)}>
          Done
        </button>
      </div>
    </div>
  );
}
