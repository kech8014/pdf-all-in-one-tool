import { clusterInk, cleanRecognised, dominantColor, isHandwritingCandidate, splitLines, textForBlock, type InkBlock } from '../core/handwriting';
import { effectiveRotation, pageSize, pageToDisplayMatrix } from '../core/geometry';
import { getPage } from '../core/operations';
import { segsToSvg, smoothStroke } from '../core/paths';
import type { InkAnnotation, PageId, Rotation, TextAnnotation } from '../core/types';
import type { WorkspaceController } from '../store/controller';
import { ui } from './uiStore';

/**
 * "Auto detect": turn handwriting drawn with the pen into real, editable text.
 *
 *  1. The pen strokes are grouped into blocks of writing, and each block into its lines
 *     (core/handwriting.ts).
 *  2. Each line is rendered black-on-white, normalised the way handwriting models expect
 *     (fixed x-height, even stroke width) — only the strokes, never the page.
 *  3. The lines are read by a handwriting-recognition model:
 *       - Claude vision on the server (/api/handwriting) when ANTHROPIC_API_KEY is set;
 *       - otherwise TrOCR, a model trained on handwritten text, running IN THE BROWSER
 *         (downloaded once, ~60 MB, then cached — no key, no upload).
 *  4. Each block's strokes are replaced by a text box of the same size, colour and
 *     position, in a single undo step.
 */

/** A line of writing drawn for recognition: ~64px tall, strokes ~4px wide, padded. */
export function renderLine(line: InkBlock, pageW: number, pageH: number, rotation: Rotation, lineHeight = 64): HTMLCanvasElement {
  const { box } = line;
  const s = lineHeight / Math.max(box.h, 1);
  const pad = Math.round(lineHeight * 0.3);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(lineHeight, Math.ceil(box.w * s + 2 * pad));
  canvas.height = Math.ceil(box.h * s + 2 * pad);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(s, 0, 0, s, pad - box.x * s, pad - box.y * s);
  const [a, b, c, d, e, f] = pageToDisplayMatrix(pageW, pageH, rotation);
  ctx.transform(a, b, c, d, e, f);
  ctx.strokeStyle = '#000000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2.5, lineHeight * 0.06) / s; // even pen, like a scanned page
  for (const ink of line.inks) ctx.stroke(new Path2D(segsToSvg(smoothStroke(ink.points))));
  return canvas;
}

let aiAvailable: Promise<boolean> | null = null;
function serverRecogniser(): Promise<boolean> {
  aiAvailable ??= fetch('/api/handwriting', { cache: 'no-store' })
    .then(async (r) => r.ok && (r.headers.get('content-type') ?? '').includes('json') && !!((await r.json()) as { ai?: boolean }).ai)
    .catch(() => false);
  return aiAvailable;
}

async function recogniseOnServer(canvases: HTMLCanvasElement[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < canvases.length; i += 16) {
    const images = canvases.slice(i, i + 16).map((c) => c.toDataURL('image/png').split(',')[1]);
    const res = await fetch('/api/handwriting', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images }) });
    const body = (await res.json().catch(() => ({}))) as { texts?: string[]; error?: string };
    if (!res.ok || !Array.isArray(body.texts)) throw new Error(body.error ?? `Recogniser error ${res.status}`);
    out.push(...body.texts);
  }
  return out;
}

/* ------------------------- on-device handwriting model ------------------------- */

export const HANDWRITING_MODEL = 'Xenova/trocr-small-handwritten';
type Reader = (image: string) => Promise<string>;
let reader: Promise<Reader> | null = null;

function loadReader(onProgress: (pct: number) => void): Promise<Reader> {
  reader ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    const files = new Map<string, { loaded: number; total: number }>();
    const pipe = await pipeline('image-to-text', HANDWRITING_MODEL, {
      dtype: 'q8',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file || !p.total) return;
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        onProgress(total ? Math.round((loaded / total) * 100) : 0);
      },
    });
    return async (image: string) => {
      const out = (await pipe(image, { max_new_tokens: 48 })) as { generated_text: string }[] | { generated_text: string }[][];
      const first = Array.isArray(out[0]) ? (out[0] as { generated_text: string }[])[0] : (out[0] as { generated_text: string });
      return first?.generated_text ?? '';
    };
  })();
  reader.catch(() => (reader = null)); // a failed download can be retried
  return reader;
}

async function recogniseOnDevice(canvases: HTMLCanvasElement[], ctl: WorkspaceController): Promise<string[]> {
  let noticeId: string | null = null;
  let shown = -1;
  const read = await loadReader((pct) => {
    const step = Math.floor(pct / 10) * 10;
    if (step === shown) return;
    shown = step;
    if (noticeId) ctl.dismiss(noticeId);
    noticeId = ctl.notify('info', `Downloading the handwriting model — ${step}%`, 'First use only (about 60 MB). It runs on your device; nothing is uploaded.');
  }).finally(() => {
    if (noticeId) ctl.dismiss(noticeId);
  });
  const out: string[] = [];
  for (const c of canvases) out.push(await read(c.toDataURL('image/png')));
  return out;
}

/* ----------------------------------- action ----------------------------------- */

let busy = false;

/**
 * Convert the selected pen strokes, or — with nothing selected — every pen stroke on the
 * current page. Returns the number of text boxes created.
 */
export async function convertHandwriting(ctl: WorkspaceController): Promise<number> {
  if (busy) return 0;
  const sel = ui.get().selectedAnns;
  const pageId: PageId | null = sel?.pageId ?? ctl.view.activePageId;
  const page = pageId ? getPage(ctl.state, pageId) : undefined;
  if (!page) {
    ctl.notify('info', 'Open a page first, then write on it with the Pen.');
    return 0;
  }
  const pool = page.annotations.filter((a): a is InkAnnotation => a.type === 'ink' && isHandwritingCandidate(a));
  const chosen = sel?.pageId === page.id ? pool.filter((a) => sel.ids.includes(a.id)) : [];
  const inks = chosen.length ? chosen : pool;
  const pageNo = ctl.pageNumber(page.id);
  if (!inks.length) {
    ctl.notify('info', `No handwriting on page ${pageNo}.`, 'Write with the Pen tool, then press Auto detect to turn it into text.');
    return 0;
  }

  busy = true;
  ui.set({ recognising: true });
  const { width, height } = pageSize(ctl.state, page);
  const rotation = effectiveRotation(ctl.state, page);
  let progress = ctl.notify('info', 'Reading your handwriting…');
  try {
    const blocks = clusterInk(inks, width, height, rotation);
    const lines = blocks.map((b) => splitLines(b, width, height, rotation));
    const canvases = lines.flat().map((l) => renderLine(l, width, height, rotation));
    const ai = await serverRecogniser();
    let texts: string[];
    if (ai) {
      texts = await recogniseOnServer(canvases);
    } else {
      ctl.dismiss(progress);
      texts = await recogniseOnDevice(canvases, ctl);
      progress = ctl.notify('info', 'Reading your handwriting…');
    }
    const created: TextAnnotation[] = [];
    const removeIds: string[] = [];
    let k = 0;
    blocks.forEach((b, bi) => {
      const text = cleanRecognised(lines[bi].map(() => cleanRecognised(texts[k++] ?? '')).join('\n'));
      if (!text) return;
      created.push(textForBlock(text, b.box, dominantColor(b.inks), width, height, rotation));
      removeIds.push(...b.inks.map((a) => a.id));
    });
    ctl.dismiss(progress);
    // The page may have been edited while the recogniser was working: only replace
    // strokes that still exist.
    const current = new Set(getPage(ctl.state, page.id)?.annotations.map((a) => a.id) ?? []);
    const stillThere = removeIds.filter((id) => current.has(id));
    if (!created.length) {
      ctl.notify('info', 'No readable handwriting found.', 'Drawings, ticks and scribbles are left as they are.');
      return 0;
    }
    ctl.replaceAnnotations(page.id, stillThere, created, `Converted handwriting to text on page ${pageNo}`);
    ui.setTool('select');
    ui.set({ selectedAnns: { pageId: page.id, ids: created.map((a) => a.id) } });
    ctl.notify(
      'success',
      created.length === 1 ? 'Handwriting converted to text.' : `${created.length} pieces of handwriting converted to text.`,
      'Double-click the text to correct it, or Undo to get the handwriting back.',
      { label: 'Undo', run: () => ctl.undo() },
    );
    return created.length;
  } catch (e) {
    ctl.dismiss(progress);
    ctl.notify('error', 'Could not read the handwriting.', e instanceof Error ? e.message : String(e));
    return 0;
  } finally {
    busy = false;
    ui.set({ recognising: false });
  }
}
