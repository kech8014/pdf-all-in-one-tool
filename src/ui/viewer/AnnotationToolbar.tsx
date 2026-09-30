import { useEffect, type ReactNode } from 'react';
import { HIGHLIGHT_COLORS, PRESET_COLORS } from '../../core/color';
import { getPage } from '../../core/operations';
import type { Annotation, FontFamily, TextAnnotation } from '../../core/types';
import { FONT_LABEL } from '../../engine/textLayout';
import { syncStamps } from '../stampCounter';
import { ColorPicker, IconButton, MOD, Slider, useApp, useView } from '../components';
import { Icon, toneClass, type IconName } from '../Icon';
import { convertHandwriting } from '../handwriting';
import { ui, useUi, type Tool, type ToolSettings } from '../uiStore';
import { TYPE_LABEL, applyStyle, type StylePatch } from './annotationFactory';

interface ToolDef {
  tool: Tool;
  icon: IconName;
  label: string;
  key: string;
  hint: string;
}

export const TOOLS: ToolDef[][] = [
  [
    { tool: 'select', icon: 'cursor', label: 'Select', key: 'V', hint: 'Click to select, drag to move, double-click text to edit' },
    { tool: 'hand', icon: 'hand', label: 'Pan', key: 'H', hint: 'Drag to scroll (or hold Space with any tool)' },
  ],
  [
    { tool: 'text', icon: 'text', label: 'Text', key: 'T', hint: 'Click anywhere to type; drag to set the box width' },
    { tool: 'pen', icon: 'pen', label: 'Pen', key: 'P', hint: 'Draw freehand' },
    { tool: 'marker', icon: 'marker', label: 'Marker', key: 'M', hint: 'Translucent freehand highlighter' },
    { tool: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E', hint: 'Drag over drawings and annotations to erase them' },
  ],
  [
    { tool: 'highlight', icon: 'highlight', label: 'Highlight', key: 'G', hint: 'Drag over an area to highlight it' },
    { tool: 'underline', icon: 'underline', label: 'Underline', key: 'U', hint: 'Drag across text to underline it' },
    { tool: 'strikeout', icon: 'strikeout', label: 'Strikethrough', key: 'K', hint: 'Drag across text to strike it through' },
  ],
  [
    { tool: 'rect', icon: 'rect', label: 'Rectangle', key: 'R', hint: 'Drag to draw (Shift for a square)' },
    { tool: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O', hint: 'Drag to draw (Shift for a circle)' },
    { tool: 'line', icon: 'line', label: 'Line', key: 'L', hint: 'Drag to draw (Shift snaps to 45°)' },
    { tool: 'arrow', icon: 'arrow', label: 'Arrow', key: 'A', hint: 'Drag to draw (Shift snaps to 45°)' },
  ],
  [
    { tool: 'whiteout', icon: 'whiteout', label: 'Whiteout', key: 'W', hint: 'Cover content with an opaque box' },
    { tool: 'stamp', icon: 'stamp', label: 'Stamp', key: 'S', hint: 'Click to stamp C1, click again for C2, C3…' },
    { tool: 'note', icon: 'note', label: 'Sticky note', key: 'N', hint: 'Click to add a comment' },
    { tool: 'image', icon: 'image', label: 'Image', key: 'I', hint: 'Place a picture or stamp on the page' },
  ],
];

export const TOOL_BY_KEY: Record<string, Tool> = Object.fromEntries(TOOLS.flat().map((t) => [t.key.toLowerCase(), t.tool]));

export function AnnotationToolbar() {
  const { ctl } = useApp();
  const tool = useUi((s) => s.tool);
  const recognising = useUi((s) => s.recognising);
  const pending = useUi((s) => s.pendingImage);
  const { state } = useView();
  // Undo / redo of a stamp moves the stamp counter back / forward with it.
  useEffect(() => syncStamps(state), [state]);
  return (
    <div className="annot-toolbar" role="toolbar" aria-label="Editing tools">
      <div className="tool-groups">
        {TOOLS.map((group, gi) => (
          <div className="tool-group" key={gi}>
            {group.map((t) => (
              <button
                key={t.tool}
                type="button"
                className={`tool-btn ${toneClass(t.icon)} ${tool === t.tool ? 'is-active' : ''}`}
                title={`${t.label} (${t.key}) — ${t.hint}`}
                aria-label={t.label}
                aria-pressed={tool === t.tool}
                data-testid={`tool-${t.tool}`}
                onClick={() => {
                  ui.setTool(t.tool);
                  if (t.tool === 'image' && !pending) document.getElementById('image-picker')?.click();
                }}
              >
                <span className="tool-chip">
                  <Icon name={t.icon} size={20} />
                </span>
                <span className="tool-label">{t.label}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="tool-group">
          <button
            type="button"
            className={`tool-btn ${toneClass('signature')}`}
            title="Signature — draw, type or upload your signature, then click to place it"
            aria-label="Signature"
            data-testid="tool-signature"
            onClick={() => ui.openDialog({ kind: 'signature' })}
          >
            <span className="tool-chip">
              <Icon name="signature" size={20} />
            </span>
            <span className="tool-label">Sign</span>
          </button>
          <button
            type="button"
            className={`tool-btn ${toneClass('wand')} ${recognising ? 'is-busy' : ''}`}
            title="Auto detect — turn your handwriting (Pen strokes) into typed text. Select strokes first to convert only those; otherwise the whole page is converted."
            aria-label="Auto detect handwriting"
            data-testid="tool-autodetect"
            disabled={recognising}
            onClick={() => void convertHandwriting(ctl)}
          >
            <span className="tool-chip">
              <Icon name="wand" size={20} />
            </span>
            <span className="tool-label">{recognising ? 'Reading…' : 'Auto detect'}</span>
          </button>
        </div>
      </div>
      <ToolOptions />
    </div>
  );
}

/**
 * Options for whatever is in focus: the text/note being edited, else the selected
 * annotations, else the active tool's defaults. Changing an option on a selection edits
 * it (one undo step per burst of changes); with nothing selected it sets the tool's
 * default for the next annotation.
 */
function ToolOptions() {
  const { ctl } = useApp();
  const tool = useUi((s) => s.tool);
  const s = useUi((st) => st.settings);
  const sel = useUi((st) => st.selectedAnns);
  const draft = useUi((st) => st.editDraft);
  const pending = useUi((st) => st.pendingImage);
  const { state } = useView();

  const selectedAnns: Annotation[] = sel ? (getPage(state, sel.pageId)?.annotations.filter((a) => sel.ids.includes(a.id)) ?? []) : [];

  /* ----- context 1: text or note being edited ----- */
  if (draft) {
    const set = (patch: StylePatch) => {
      const d = ui.get().editDraft;
      if (!d) return;
      const next = applyStyle(d.ann, patch) as typeof d.ann;
      ui.set({ editDraft: { ...d, ann: next } });
      if (d.ann.type === 'text') ui.updateSettings(textSettingsFrom(patch));
    };
    return (
      <div className="tool-options" aria-label="Text options">
        <span className="opt-title">{draft.ann.type === 'text' ? 'Text' : 'Note'}</span>
        {draft.ann.type === 'text' ? <TextOptions a={draft.ann} onChange={set} /> : <ColorPicker label="Note colour" value={draft.ann.color} presets={HIGHLIGHT_COLORS} onChange={(c) => c && set({ color: c })} />}
      </div>
    );
  }

  /* ----- context 2: selected annotations ----- */
  if (selectedAnns.length && sel) {
    const first = selectedAnns[0];
    const apply = (patch: StylePatch) => {
      const cur = getPage(ctl.state, sel.pageId)?.annotations.filter((a) => sel.ids.includes(a.id)) ?? [];
      ctl.updateAnnotations(sel.pageId, cur.map((a) => applyStyle(a, patch)), 'Changed style', `style:${sel.ids.join()}`);
    };
    const title = selectedAnns.length === 1 ? TYPE_LABEL[first.type] : `${selectedAnns.length} annotations`;
    return (
      <div className="tool-options" aria-label="Selection options" data-testid="selection-options">
        <span className="opt-title">{title}</span>
        <StyleControls a={first} onChange={apply} />
        <span className="opt-sep" />
        <IconButton icon="front" label="Bring to front" shortcut={`${MOD} ]`} onClick={() => ctl.reorderAnnotations(sel.pageId, sel.ids, 'front')} />
        <IconButton icon="back" label="Send to back" shortcut={`${MOD} [`} onClick={() => ctl.reorderAnnotations(sel.pageId, sel.ids, 'back')} />
        <IconButton
          icon="copy"
          label="Duplicate"
          shortcut={`${MOD} D`}
          onClick={() => {
            const ids = ctl.duplicateAnnotations(sel.pageId, sel.ids);
            ui.selectAnns(sel.pageId, ids);
          }}
        />
        {first.type === 'text' || first.type === 'note' ? (
          <IconButton icon="edit" label="Edit text" onClick={() => ui.set({ editDraft: { pageId: sel.pageId, ann: first as TextAnnotation, isNew: false } })} />
        ) : null}
        <IconButton
          icon="trash"
          label="Delete"
          shortcut="Del"
          variant="danger"
          testId="delete-annotation"
          onClick={() => {
            ctl.removeAnnotations(sel.ids.map((id) => ({ pageId: sel.pageId, annotationId: id })));
            ui.clearAnns();
          }}
        />
      </div>
    );
  }

  /* ----- context 3: the active tool's defaults ----- */
  const upd = (p: Partial<ToolSettings>) => ui.updateSettings(p);
  let body: ReactNode = null;
  switch (tool) {
    case 'select':
      body = <span className="opt-hint">Click an annotation to select it. Drag to move. Double-click text to edit. Shift-click to select several.</span>;
      break;
    case 'hand':
      body = <span className="opt-hint">Drag to move around the page. Tip: hold Space with any tool to pan.</span>;
      break;
    case 'pen':
      body = (
        <>
          <ColorPicker label="Pen colour" value={s.penColor} presets={PRESET_COLORS} onChange={(c) => c && upd({ penColor: c })} testId="pen-color" />
          <Slider label="Thickness" value={s.penWidth} min={0.5} max={30} step={0.5} onChange={(v) => upd({ penWidth: v })} format={(v) => `${v}px`} testId="pen-width" />
          <Slider label="Opacity" value={s.penOpacity} min={0.1} max={1} step={0.05} onChange={(v) => upd({ penOpacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <WidthPresets value={s.penWidth} onChange={(v) => upd({ penWidth: v })} />
          <ShapeMode value={s.penShapes} onChange={(v) => upd({ penShapes: v })} />
        </>
      );
      break;
    case 'marker':
      body = (
        <>
          <ColorPicker label="Marker colour" value={s.markerColor} presets={HIGHLIGHT_COLORS} onChange={(c) => c && upd({ markerColor: c })} />
          <Slider label="Thickness" value={s.markerWidth} min={4} max={40} step={1} onChange={(v) => upd({ markerWidth: v })} format={(v) => `${v}px`} />
          <Slider label="Opacity" value={s.markerOpacity} min={0.1} max={1} step={0.05} onChange={(v) => upd({ markerOpacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <ShapeMode value={s.penShapes} onChange={(v) => upd({ penShapes: v })} />
        </>
      );
      break;
    case 'eraser':
      body = (
        <>
          <Slider label="Eraser size" value={s.eraserSize} min={4} max={60} step={1} onChange={(v) => upd({ eraserSize: v })} format={(v) => `${v}px`} />
          <span className="opt-hint">Erases whole strokes and annotations it touches. Undo brings them back.</span>
        </>
      );
      break;
    case 'text':
      body = <TextOptions a={{ ...s, color: s.textColor, background: s.textBackground, opacity: 1 }} onChange={(p) => upd(textSettingsFrom(p))} />;
      break;
    case 'highlight':
      body = (
        <>
          <ColorPicker label="Highlight colour" value={s.highlightColor} presets={HIGHLIGHT_COLORS} onChange={(c) => c && upd({ highlightColor: c })} />
          <Slider label="Opacity" value={s.highlightOpacity} min={0.15} max={1} step={0.05} onChange={(v) => upd({ highlightOpacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </>
      );
      break;
    case 'underline':
    case 'strikeout':
      body = <ColorPicker label="Line colour" value={s.markupColor} presets={PRESET_COLORS} onChange={(c) => c && upd({ markupColor: c })} />;
      break;
    case 'rect':
    case 'ellipse':
      body = (
        <>
          <ColorPicker label="Border colour" value={s.shapeColor} presets={PRESET_COLORS} onChange={(c) => c && upd({ shapeColor: c })} />
          <Slider label="Border" value={s.shapeWidth} min={0} max={20} step={0.5} onChange={(v) => upd({ shapeWidth: v })} format={(v) => `${v}px`} />
          <span className="opt-label">Fill</span>
          <ColorPicker label="Fill colour" value={s.shapeFill} presets={PRESET_COLORS} allowNone onChange={(c) => upd({ shapeFill: c })} />
          <Slider label="Opacity" value={s.shapeOpacity} min={0.1} max={1} step={0.05} onChange={(v) => upd({ shapeOpacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </>
      );
      break;
    case 'line':
    case 'arrow':
      body = (
        <>
          <ColorPicker label="Line colour" value={s.lineColor} presets={PRESET_COLORS} onChange={(c) => c && upd({ lineColor: c })} />
          <Slider label="Thickness" value={s.lineWidth} min={0.5} max={20} step={0.5} onChange={(v) => upd({ lineWidth: v })} format={(v) => `${v}px`} />
        </>
      );
      break;
    case 'whiteout':
      body = (
        <>
          <ColorPicker label="Cover colour" value={s.whiteoutColor} presets={PRESET_COLORS} onChange={(c) => c && upd({ whiteoutColor: c })} />
          <span className="opt-hint">Hides content visually. The text underneath is still in the file — not a secure redaction.</span>
        </>
      );
      break;
    case 'stamp':
      body = <StampOptions s={s} onChange={upd} />;
      break;
    case 'note':
      body = <ColorPicker label="Note colour" value={s.noteColor} presets={HIGHLIGHT_COLORS} onChange={(c) => c && upd({ noteColor: c })} />;
      break;
    case 'image':
      body = pending ? (
        <>
          <img src={pending.previewUrl} alt="" className="pending-preview" />
          <span className="opt-hint opt-hint-strong">{pending.signature ? 'Click where the signature should go' : 'Click on a page to place the image'} — or drag to set its size.</span>
          <button type="button" className="btn btn-labelled" onClick={() => document.getElementById('image-picker')?.click()}>
            Choose another…
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-labelled btn-primary" onClick={() => document.getElementById('image-picker')?.click()}>
          <Icon name="upload" /> Choose an image…
        </button>
      );
      break;
  }
  return (
    <div className="tool-options" data-testid="tool-options">
      {body}
    </div>
  );
}

function textSettingsFrom(p: StylePatch): Partial<ToolSettings> {
  const out: Partial<ToolSettings> = {};
  if (p.color) out.textColor = p.color;
  if (p.fontFamily) out.fontFamily = p.fontFamily;
  if (p.fontSize) out.fontSize = p.fontSize;
  if (p.bold !== undefined) out.bold = p.bold;
  if (p.italic !== undefined) out.italic = p.italic;
  if (p.align) out.align = p.align;
  if (p.background !== undefined) out.textBackground = p.background;
  return out;
}

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72];

function TextOptions({
  a,
  onChange,
}: {
  a: { color: string; fontFamily: FontFamily; fontSize: number; bold: boolean; italic: boolean; align: TextAnnotation['align']; background: string | null; opacity: number };
  onChange: (p: StylePatch) => void;
}) {
  return (
    <>
      <ColorPicker label="Text colour" value={a.color} presets={PRESET_COLORS} onChange={(c) => c && onChange({ color: c })} testId="text-color" />
      <select className="opt-select" aria-label="Font" value={a.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value as FontFamily })}>
        {(Object.keys(FONT_LABEL) as FontFamily[]).map((f) => (
          <option key={f} value={f}>
            {FONT_LABEL[f]}
          </option>
        ))}
      </select>
      <label className="opt-size" title="Font size">
        <input
          type="number"
          min={4}
          max={200}
          list="font-sizes"
          value={a.fontSize}
          aria-label="Font size"
          data-testid="font-size"
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 4 && v <= 200) onChange({ fontSize: v });
          }}
        />
        <datalist id="font-sizes">
          {FONT_SIZES.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <span>pt</span>
      </label>
      <IconButton icon="bold" label="Bold" active={a.bold} onClick={() => onChange({ bold: !a.bold })} />
      <IconButton icon="italic" label="Italic" active={a.italic} onClick={() => onChange({ italic: !a.italic })} />
      <IconButton icon="alignLeft" label="Align left" active={a.align === 'left'} onClick={() => onChange({ align: 'left' })} />
      <IconButton icon="alignCenter" label="Align centre" active={a.align === 'center'} onClick={() => onChange({ align: 'center' })} />
      <IconButton icon="alignRight" label="Align right" active={a.align === 'right'} onClick={() => onChange({ align: 'right' })} />
      <span className="opt-label">Box</span>
      <ColorPicker label="Background" value={a.background} presets={[{ name: 'White', value: '#ffffff' }, { name: 'Yellow', value: '#fff3a3' }]} allowNone onChange={(c) => onChange({ background: c })} />
    </>
  );
}

const SHAPE_MODES: { v: ToolSettings['penShapes']; label: string; hint: string }[] = [
  { v: 'auto', label: 'Auto', hint: 'Straighten lines and snap clear circles, boxes, arcs and angles automatically. Hold still at the end of any stroke to snap it too.' },
  { v: 'hold', label: 'Hold', hint: 'Keep strokes freehand (smoothed); hold still at the end of a stroke to snap it to a shape.' },
  { v: 'off', label: 'Off', hint: 'Never snap to shapes (strokes are still smoothed).' },
];

/** Smart shapes: how freehand strokes are cleaned up. */
function ShapeMode({ value, onChange }: { value: ToolSettings['penShapes']; onChange: (v: ToolSettings['penShapes']) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Smart shapes" data-testid="shape-mode">
      <span className="seg-label">Smart shapes</span>
      {SHAPE_MODES.map((m) => (
        <button key={m.v} type="button" role="radio" aria-checked={value === m.v} className={`seg-btn ${value === m.v ? 'is-active' : ''}`} title={m.hint} onClick={() => onChange(m.v)} data-testid={`shape-mode-${m.v}`}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

function WidthPresets({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="width-presets" role="group" aria-label="Thickness presets">
      {[1, 2, 3, 5, 8].map((w) => (
        <button key={w} type="button" className={`width-preset ${value === w ? 'is-active' : ''}`} title={`${w}px`} aria-label={`${w} pixel`} data-testid={`pen-width-${w}`} onClick={() => onChange(w)}>
          <span style={{ height: Math.max(1, w), width: 18 }} />
        </button>
      ))}
    </div>
  );
}

function StyleControls({ a, onChange }: { a: Annotation; onChange: (p: StylePatch) => void }) {
  const opacity = (
    <Slider label="Opacity" value={a.opacity} min={0.1} max={1} step={0.05} onChange={(v) => onChange({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
  );
  switch (a.type) {
    case 'ink':
      return (
        <>
          <ColorPicker label="Colour" value={a.color} presets={PRESET_COLORS} onChange={(c) => c && onChange({ color: c })} />
          <Slider label="Thickness" value={a.width} min={0.5} max={40} step={0.5} onChange={(v) => onChange({ width: v })} format={(v) => `${v}px`} />
          {opacity}
        </>
      );
    case 'line':
      return (
        <>
          <ColorPicker label="Colour" value={a.color} presets={PRESET_COLORS} onChange={(c) => c && onChange({ color: c })} />
          <Slider label="Thickness" value={a.width} min={0.5} max={20} step={0.5} onChange={(v) => onChange({ width: v })} format={(v) => `${v}px`} />
          {opacity}
        </>
      );
    case 'shape':
      return (
        <>
          <ColorPicker label="Border" value={a.strokeColor} presets={PRESET_COLORS} onChange={(c) => c && onChange({ color: c })} />
          <Slider label="Border" value={a.strokeWidth} min={0} max={20} step={0.5} onChange={(v) => onChange({ width: v })} format={(v) => `${v}px`} />
          <span className="opt-label">Fill</span>
          <ColorPicker label="Fill" value={a.fillColor} presets={PRESET_COLORS} allowNone onChange={(c) => onChange({ fill: c })} />
          {opacity}
        </>
      );
    case 'highlight':
      return (
        <>
          <ColorPicker label="Colour" value={a.color} presets={HIGHLIGHT_COLORS} onChange={(c) => c && onChange({ color: c })} />
          {opacity}
        </>
      );
    case 'whiteout':
      return <ColorPicker label="Colour" value={a.color} presets={PRESET_COLORS} onChange={(c) => c && onChange({ color: c })} />;
    case 'note':
      return <ColorPicker label="Colour" value={a.color} presets={HIGHLIGHT_COLORS} onChange={(c) => c && onChange({ color: c })} />;
    case 'image':
      return opacity;
    case 'text':
      return <TextOptions a={a} onChange={onChange} />;
  }
}

function StampOptions({ s, onChange }: { s: ToolSettings; onChange: (p: Partial<ToolSettings>) => void }) {
  return (
    <>
      <span className="stamp-preview" style={{ color: s.stampColor }} data-testid="stamp-preview" title="Next stamp">
        {s.stampPrefix}
        {s.stampNext}
      </span>
      <label className="opt-size" title="Text before the number">
        <span>Text</span>
        <input type="text" className="stamp-prefix" value={s.stampPrefix} maxLength={12} aria-label="Stamp text" data-testid="stamp-prefix" onChange={(e) => onChange({ stampPrefix: e.target.value })} />
      </label>
      <label className="opt-size" title="Number of the next stamp">
        <span>Next</span>
        <input
          type="number"
          min={0}
          value={s.stampNext}
          aria-label="Next stamp number"
          data-testid="stamp-next"
          onChange={(e) => {
            const v = Math.floor(Number(e.target.value));
            if (Number.isFinite(v) && v >= 0) onChange({ stampNext: v });
          }}
        />
      </label>
      <button type="button" className="btn btn-labelled" onClick={() => onChange({ stampNext: 1 })} data-testid="stamp-reset">
        Restart at 1
      </button>
      <ColorPicker label="Stamp colour" value={s.stampColor} presets={PRESET_COLORS} onChange={(c) => c && onChange({ stampColor: c })} testId="stamp-color" />
      <label className="opt-size" title="Font size">
        <input
          type="number"
          min={6}
          max={200}
          value={s.stampSize}
          aria-label="Stamp size"
          data-testid="stamp-size"
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 6 && v <= 200) onChange({ stampSize: v });
          }}
        />
        <span>pt</span>
      </label>
      <IconButton icon="bold" label="Bold" active={s.stampBold} onClick={() => onChange({ stampBold: !s.stampBold })} />
    </>
  );
}
