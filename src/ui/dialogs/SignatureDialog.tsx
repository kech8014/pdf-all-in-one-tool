import { useEffect, useRef, useState } from 'react';
import { readFiles, pickFiles, ACCEPT_IMAGES } from '../actions';
import { Dialog, useApp } from '../components';
import { Icon } from '../Icon';
import { stageImageForPlacement } from '../imagePlacement';
import { ui } from '../uiStore';

const SAVED_KEY = 'pdf-workspace:signatures';
type Tab = 'draw' | 'type' | 'upload';

function loadSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
  } catch {
    return [];
  }
}

/** Crop a canvas to its non-transparent pixels and return PNG bytes. */
async function trimmedPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export function SignatureDialog() {
  const { ctl } = useApp();
  const [tab, setTab] = useState<Tab>('draw');
  const [color, setColor] = useState('#1d2b64');
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState('italic 64px "Times New Roman", Times, serif');
  const [saved, setSaved] = useState<string[]>(loadSaved);
  const [remember, setRemember] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ last: [number, number] } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (tab === 'type' && typed) {
      ctx.fillStyle = color;
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.fillText(typed, 20, c.height / 2, c.width - 40);
    }
    if (tab !== 'draw') setHasInk(!!typed);
  }, [tab, typed, font, color]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * e.currentTarget.width, ((e.clientY - r.top) / r.height) * e.currentTarget.height];
  };

  async function use(bytes: Uint8Array | null) {
    if (!bytes) return;
    if (remember) {
      const url = await new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsDataURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
      });
      const next = [url, ...saved.filter((s) => s !== url)].slice(0, 4);
      try {
        localStorage.setItem(SAVED_KEY, JSON.stringify(next));
      } catch {
        /* storage full: skip */
      }
    }
    ui.closeDialog();
    await stageImageForPlacement(ctl, bytes, true);
  }

  async function useSaved(url: string) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    ui.closeDialog();
    await stageImageForPlacement(ctl, bytes, true);
  }

  return (
    <Dialog
      title="Add a signature"
      onClose={() => ui.closeDialog()}
      width={640}
      testId="signature-dialog"
      footer={
        <>
          <label className="check foot-summary">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember in this browser
          </label>
          <button type="button" className="btn btn-labelled" onClick={() => ui.closeDialog()}>
            Cancel
          </button>
          <button type="button" className="btn btn-labelled btn-primary" disabled={!hasInk} data-testid="signature-use" onClick={async () => use(await trimmedPng(canvasRef.current!))}>
            Place signature
          </button>
        </>
      }
    >
      {saved.length > 0 && (
        <div className="saved-signatures">
          <span className="muted">Saved:</span>
          {saved.map((s) => (
            <button key={s} type="button" className="saved-signature" onClick={() => void useSaved(s)} title="Use this signature">
              <img src={s} alt="Saved signature" />
            </button>
          ))}
          <button
            type="button"
            className="btn btn-labelled btn-ghost"
            onClick={() => {
              localStorage.removeItem(SAVED_KEY);
              setSaved([]);
            }}
          >
            Forget
          </button>
        </div>
      )}
      <div className="tabs" role="tablist">
        {(['draw', 'type', 'upload'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'draw' ? 'Draw' : t === 'type' ? 'Type' : 'Upload image'}
          </button>
        ))}
        <span className="tabs-spacer" />
        {tab !== 'upload' &&
          ['#1d2b64', '#111111', '#1d4ed8', '#e11d2a'].map((c) => (
            <button key={c} type="button" className={`swatch ${color === c ? 'is-active' : ''}`} style={{ background: c }} aria-label={`Ink ${c}`} onClick={() => setColor(c)} />
          ))}
      </div>
      {tab === 'upload' ? (
        <div className="dropzone">
          <Icon name="upload" size={28} />
          <p className="muted">A PNG with a transparent background works best.</p>
          <button
            type="button"
            className="btn btn-labelled"
            onClick={async () => {
              const [f] = await pickFiles(ACCEPT_IMAGES, false);
              if (!f) return;
              const [input] = await readFiles([f]);
              ui.closeDialog();
              await stageImageForPlacement(ctl, input.bytes, true);
            }}
          >
            Choose image…
          </button>
        </div>
      ) : (
        <>
          {tab === 'type' && (
            <div className="form-grid">
              <input autoFocus placeholder="Type your name" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="signature-typed" />
              <select value={font} onChange={(e) => setFont(e.target.value)} aria-label="Signature style">
                <option value='italic 64px "Times New Roman", Times, serif'>Classic</option>
                <option value='italic 600 60px "Brush Script MT", "Segoe Script", cursive'>Script</option>
                <option value='56px Helvetica, Arial, sans-serif'>Plain</option>
              </select>
            </div>
          )}
          <div className="sig-pad">
            <canvas
              ref={canvasRef}
              width={1200}
              height={360}
              data-testid="signature-pad"
              onPointerDown={(e) => {
                if (tab !== 'draw') return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drawing.current = { last: pos(e) };
              }}
              onPointerMove={(e) => {
                if (tab !== 'draw' || !drawing.current) return;
                const ctx = e.currentTarget.getContext('2d')!;
                const p = pos(e);
                ctx.strokeStyle = color;
                ctx.lineWidth = 5;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(...drawing.current.last);
                ctx.lineTo(...p);
                ctx.stroke();
                drawing.current.last = p;
                setHasInk(true);
              }}
              onPointerUp={() => (drawing.current = null)}
            />
            {tab === 'draw' && !hasInk && <span className="sig-hint">Sign here with your mouse, pen or finger</span>}
            <button
              type="button"
              className="btn btn-labelled btn-ghost sig-clear"
              onClick={() => {
                const c = canvasRef.current!;
                c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
                setHasInk(false);
                setTyped('');
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
