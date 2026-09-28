import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceError } from '../../core/errors';
import { normRotation } from '../../core/geometry';
import { PAGE_SIZES, type ImagePageSize } from '../../engine/ingest';
import { requestThumb } from '../../render/pdfRender';
import type { InputFile, PreparedFile } from '../../store/controller';
import { ACCEPT_ANY, ACCEPT_IMAGES, ACCEPT_PDF, pickFiles, readFiles } from '../actions';
import { Dialog, useApp, useView } from '../components';
import { Icon } from '../Icon';
import { ui, type DialogState } from '../uiStore';

type Props = Extract<DialogState, { kind: 'insert' }>;

type Where = 'start' | 'before' | 'after' | 'end';
type SizeChoice = 'image' | 'letter' | 'a4' | 'legal' | 'match';

interface Locked {
  name: string;
  bytes: Uint8Array;
  error: WorkspaceError;
  password: string;
}

/**
 * Insert (or replace) pages from other files. Files are read and validated first and
 * their pages shown, so the user picks exactly which pages go in and where — before
 * anything changes in the document.
 */
export function InsertDialog(props: Props) {
  const { ctl } = useApp();
  const { state, activePageId } = useView();
  const count = state.pages.length;
  const replacing = props.mode === 'replace';
  const [inputs, setInputs] = useState<InputFile[]>([]);
  const [prepared, setPrepared] = useState<PreparedFile[]>([]);
  const [picked, setPicked] = useState<Record<string, number[]>>({});
  const [errors, setErrors] = useState<{ name: string; message: string; detail?: string }[]>([]);
  const [locked, setLocked] = useState<Locked[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sizeChoice, setSizeChoice] = useState<SizeChoice>('image');
  const [margin, setMargin] = useState(0);

  const initialWhere: Where = count === 0 ? 'end' : props.index <= 0 ? 'start' : props.index >= count ? 'end' : 'after';
  const [where, setWhere] = useState<Where>(initialWhere);
  const [pageNo, setPageNo] = useState(() => Math.max(1, Math.min(count, props.index || (activePageId ? ctl.pageNumber(activePageId) : 1))));

  const imageSize: ImagePageSize = useMemo(() => {
    if (sizeChoice === 'image') return { mode: 'image' };
    if (sizeChoice === 'match') {
      const p = state.pages.find((x) => x.id === activePageId) ?? state.pages[0];
      if (p) {
        const info = state.sources[p.sourceId].pages[p.sourcePageIndex];
        return { mode: 'fixed', width: info.width, height: info.height, margin };
      }
      return { mode: 'fixed', ...PAGE_SIZES.letter, margin };
    }
    return { mode: 'fixed', width: PAGE_SIZES[sizeChoice].width, height: PAGE_SIZES[sizeChoice].height, margin };
  }, [sizeChoice, margin, state, activePageId]);

  async function load(files: InputFile[], passwords?: Record<string, string>, replaceExisting = false) {
    if (!files.length) return;
    setBusy(true);
    try {
      const { prepared: ok, failures } = await ctl.prepareFiles(files, { imageSize, passwords });
      setPrepared((cur) => (replaceExisting ? ok : [...cur, ...ok]));
      setPicked((cur) => {
        const next = replaceExisting ? {} : { ...cur };
        for (const f of ok) next[f.key] = replacing ? (f === ok[0] && !prepared.length ? [0] : []) : f.pages.map((_, i) => i);
        return next;
      });
      setLocked((cur) => [
        ...cur.filter((l) => !files.some((f) => f.name === l.name)),
        ...failures.filter((f) => f.needsPassword).map((f) => ({ name: f.name, bytes: f.bytes, error: f.error, password: passwords?.[f.name] ?? '' })),
      ]);
      setErrors((cur) => [...cur, ...failures.filter((f) => !f.needsPassword).map((f) => ({ name: f.name, message: f.error.message, detail: f.error.detail }))]);
    } finally {
      setBusy(false);
    }
  }

  async function addFiles(files: File[]) {
    const read = await readFiles(files);
    setInputs((cur) => [...cur, ...read]);
    await load(read);
  }

  // Files handed in by drag-and-drop or by a failed quick import.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (props.files?.length) void addFiles(props.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-convert images when the page-size option changes.
  const firstSize = useRef(true);
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    const imgs = inputs.filter((f) => prepared.some((p) => p.name === f.name && p.kind === 'image'));
    if (!imgs.length) return;
    void (async () => {
      setBusy(true);
      const { prepared: again } = await ctl.prepareFiles(imgs, { imageSize });
      setPrepared((cur) => cur.map((p) => (p.kind === 'image' ? (again.find((a) => a.name === p.name) ?? p) : p)));
      setPicked((cur) => {
        const next = { ...cur };
        for (const a of again) {
          const old = prepared.find((p) => p.name === a.name && p.kind === 'image');
          next[a.key] = old ? (cur[old.key] ?? a.pages.map((_, i) => i)) : a.pages.map((_, i) => i);
        }
        return next;
      });
      setBusy(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSize]);

  const index = where === 'start' ? 0 : where === 'end' ? count : where === 'before' ? pageNo - 1 : pageNo;
  const total = prepared.reduce((n, f) => n + (picked[f.key]?.length ?? 0), 0);
  const hasImages = prepared.some((p) => p.kind === 'image') || inputs.some((f) => /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i.test(f.name));

  function confirm() {
    if (replacing) {
      const f = prepared.find((p) => picked[p.key]?.length);
      if (!f || !props.replacePageId) return;
      ctl.replacePage(props.replacePageId, f, picked[f.key][0]);
      ui.closeDialog();
      return;
    }
    const ids = ctl.insertPrepared(prepared, index, picked);
    if (ids.length) {
      ctl.notify('success', `Inserted ${ids.length} page${ids.length === 1 ? '' : 's'}.`, undefined, { label: 'Undo', run: () => ctl.undo() });
      ui.requestScroll();
    }
    ui.closeDialog();
  }

  const accept = props.accept === 'pdf' ? ACCEPT_PDF : props.accept === 'image' ? ACCEPT_IMAGES : ACCEPT_ANY;
  const title = replacing ? `Replace page ${props.replacePageId ? ctl.pageNumber(props.replacePageId) : ''}` : props.accept === 'image' ? 'Insert images' : props.accept === 'pdf' ? 'Insert PDF pages' : 'Insert pages';
  const whereText =
    count === 0 ? '' : where === 'start' ? 'at the beginning' : where === 'end' ? 'at the end' : `${where} page ${pageNo}`;

  return (
    <Dialog
      title={title}
      onClose={() => ui.closeDialog()}
      width={760}
      testId="insert-dialog"
      footer={
        <>
          <span className="foot-summary">
            {replacing
              ? total
                ? 'The chosen page replaces this one. Its annotations are removed.'
                : 'Choose the page to use.'
              : total
                ? `${total} page${total === 1 ? '' : 's'} will be inserted ${whereText}.`
                : 'Choose files, then pick the pages to insert.'}
          </span>
          <button type="button" className="btn btn-labelled" onClick={() => ui.closeDialog()}>
            Cancel
          </button>
          <button type="button" className="btn btn-labelled btn-primary" disabled={!total || busy} onClick={confirm} data-testid="insert-confirm">
            {replacing ? 'Replace page' : `Insert ${total || ''} page${total === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div
        className={`dropzone ${dragOver ? 'is-over' : ''} ${prepared.length ? 'is-compact' : ''}`}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void addFiles([...e.dataTransfer.files]);
        }}
      >
        <Icon name="upload" size={prepared.length ? 18 : 28} />
        <div>
          <strong>{prepared.length ? 'Add more files' : 'Drop files here'}</strong>
          {!prepared.length && <p className="muted">PDF, JPG, PNG, WebP, GIF, BMP or TIFF. Images become pages automatically.</p>}
        </div>
        <button type="button" className="btn btn-labelled" onClick={async () => addFiles(await pickFiles(accept, !replacing))} data-testid="insert-choose">
          Choose files…
        </button>
        {!replacing && !prepared.length && count > 0 && (
          <button
            type="button"
            className="btn btn-labelled btn-ghost"
            onClick={() => {
              void ctl.insertBlankPage(index);
              ui.closeDialog();
            }}
          >
            Insert a blank page instead
          </button>
        )}
      </div>

      {busy && <div className="inline-busy">Reading files…</div>}

      {errors.map((e, i) => (
        <div key={i} className="inline-error" role="alert">
          <Icon name="alert" /> <span>{e.message}</span>
          {e.detail && <small>{e.detail}</small>}
        </div>
      ))}

      {locked.map((l) => (
        <div key={l.name} className="inline-locked">
          <Icon name="lock" />
          <span>{l.error.message}</span>
          <input
            type="password"
            placeholder="Password"
            aria-label={`Password for ${l.name}`}
            value={l.password}
            onChange={(e) => setLocked((cur) => cur.map((x) => (x.name === l.name ? { ...x, password: e.target.value } : x)))}
            onKeyDown={(e) => e.key === 'Enter' && void load([{ name: l.name, bytes: l.bytes }], { [l.name]: l.password })}
          />
          <button type="button" className="btn btn-labelled" onClick={() => void load([{ name: l.name, bytes: l.bytes }], { [l.name]: l.password })}>
            Unlock
          </button>
        </div>
      ))}

      {hasImages && !replacing && (
        <div className="option-row">
          <label>
            Image page size
            <select value={sizeChoice} onChange={(e) => setSizeChoice(e.target.value as SizeChoice)} aria-label="Image page size">
              <option value="image">Same as the image (no borders)</option>
              <option value="letter">{PAGE_SIZES.letter.label}</option>
              <option value="a4">{PAGE_SIZES.a4.label}</option>
              <option value="legal">{PAGE_SIZES.legal.label}</option>
              {count > 0 && <option value="match">Same size as the current page</option>}
            </select>
          </label>
          {sizeChoice !== 'image' && (
            <label>
              Margin
              <select value={margin} onChange={(e) => setMargin(Number(e.target.value))} aria-label="Margin">
                <option value={0}>None</option>
                <option value={18}>Small (¼ in)</option>
                <option value={36}>Medium (½ in)</option>
                <option value={72}>Large (1 in)</option>
              </select>
            </label>
          )}
          <span className="muted">Images keep their full resolution.</span>
        </div>
      )}

      <div className="prepared-list">
        {prepared.map((f) => (
          <PreparedFileView
            key={f.key}
            file={f}
            picked={picked[f.key] ?? []}
            single={replacing}
            onPick={(list) =>
              setPicked((cur) => {
                if (!replacing) return { ...cur, [f.key]: list };
                const next: Record<string, number[]> = {};
                for (const k of Object.keys(cur)) next[k] = [];
                next[f.key] = list.slice(-1);
                return next;
              })
            }
            onRemove={() => {
              setPrepared((cur) => cur.filter((x) => x.key !== f.key));
              setPicked((cur) => {
                const { [f.key]: _drop, ...rest } = cur;
                void _drop;
                return rest;
              });
            }}
          />
        ))}
      </div>

      {!replacing && count > 0 && (
        <fieldset className="position">
          <legend>Where should the pages go?</legend>
          <label>
            <input type="radio" name="where" checked={where === 'start'} onChange={() => setWhere('start')} /> At the beginning
          </label>
          <label>
            <input type="radio" name="where" checked={where === 'before'} onChange={() => setWhere('before')} /> Before page
          </label>
          <label>
            <input type="radio" name="where" checked={where === 'after'} onChange={() => setWhere('after')} data-testid="where-after" /> After page
          </label>
          <input
            type="number"
            className="page-num-input"
            min={1}
            max={count}
            value={pageNo}
            aria-label="Page number"
            data-testid="where-page"
            disabled={where === 'start' || where === 'end'}
            onChange={(e) => setPageNo(Math.max(1, Math.min(count, Number(e.target.value) || 1)))}
          />
          <label>
            <input type="radio" name="where" checked={where === 'end'} onChange={() => setWhere('end')} /> At the end
          </label>
          <span className="muted">of {count} pages</span>
        </fieldset>
      )}
    </Dialog>
  );
}

function parseRanges(text: string, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

function PreparedFileView({ file, picked, single, onPick, onRemove }: { file: PreparedFile; picked: number[]; single: boolean; onPick: (l: number[]) => void; onRemove: () => void }) {
  const [range, setRange] = useState('');
  const set = new Set(picked);
  const n = file.pages.length;
  return (
    <section className="prepared" data-testid="prepared-file">
      <header>
        <Icon name={file.kind === 'image' ? 'image' : 'file'} />
        <strong className="prepared-name">{file.name}</strong>
        <span className="muted">
          {n} page{n === 1 ? '' : 's'} · {picked.length} selected
        </span>
        {!single && n > 1 && (
          <>
            <button type="button" className="btn btn-labelled btn-ghost" onClick={() => onPick(file.pages.map((_, i) => i))}>
              All
            </button>
            <button type="button" className="btn btn-labelled btn-ghost" onClick={() => onPick([])}>
              None
            </button>
            <input
              className="range-input"
              placeholder="e.g. 1-3, 5"
              aria-label={`Pages of ${file.name}`}
              value={range}
              onChange={(e) => {
                setRange(e.target.value);
                const r = parseRanges(e.target.value, n);
                if (r) onPick(r);
              }}
            />
          </>
        )}
        <button type="button" className="btn btn-icon btn-ghost" title="Remove this file" aria-label={`Remove ${file.name}`} onClick={onRemove}>
          <Icon name="close" />
        </button>
      </header>
      <div className="prepared-pages">
        {file.pages.map((ref, i) => {
          const src = file.sources.find((s) => s.id === ref.sourceId)!;
          return (
            <label key={i} className={`prepared-page ${set.has(i) ? 'is-picked' : ''}`} data-testid={`pick-${i + 1}`}>
              <input
                type={single ? 'radio' : 'checkbox'}
                name={single ? 'replace-pick' : undefined}
                checked={set.has(i)}
                onChange={(e) => onPick(single ? [i] : e.target.checked ? [...picked, i].sort((a, b) => a - b) : picked.filter((x) => x !== i))}
              />
              <MiniThumb blobId={src.blobId} index={ref.index} rotation={src.pages[ref.index].rotation} />
              <span>{i + 1}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function MiniThumb({ blobId, index, rotation }: { blobId: string; index: number; rotation: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver((e) => setVisible(e.some((x) => x.isIntersecting)), { rootMargin: '200px' });
    if (box.current) io.observe(box.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const job = requestThumb(blobId, index, normRotation(rotation), 160);
    let alive = true;
    job.promise
      .then((bmp) => {
        const c = ref.current;
        if (!alive || !c) return;
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      job.cancel();
    };
  }, [visible, blobId, index, rotation]);
  return (
    <div className="mini-thumb" ref={box}>
      <canvas ref={ref} />
    </div>
  );
}
