import { clusterInk, cleanRecognised, dominantColor, isHandwritingCandidate, textForBlock, type InkBlock } from '../core/handwriting';
import { effectiveRotation, pageSize, pageToDisplayMatrix } from '../core/geometry';
import { inkOutline, outlineSvg } from '../core/ink';
import { getPage } from '../core/operations';
import { segsToSvg, smoothStroke } from '../core/paths';
import type { InkAnnotation, PageId, Rotation, TextAnnotation } from '../core/types';
import type { WorkspaceController } from '../store/controller';
import { ui } from './uiStore';

/**
 * "Auto detect": turn handwriting drawn with the pen into real, editable text.
 *
 *  1. The pen strokes are grouped into blocks of writing (core/handwriting.ts).
 *  2. Each block is rendered black-on-white to a PNG — only the strokes, never the page.
 *  3. The blocks are read by the handwriting recogniser on the server (Claude vision,
 *     /api/handwriting) or, when that is not configured, by on-device OCR (Tesseract).
 *  4. Each block's strokes are replaced by a text box of the same size, colour and
 *     position, in a single undo step.
 */

const PAD = 24;
const MAX_SIDE = 1400;

export function renderBlock(block: InkBlock, pageW: number, pageH: number, rotation: Rotation): HTMLCanvasElement {
  const { box } = block;
  const s = Math.max(2, Math.min(8, MAX_SIDE / Math.max(box.w, box.h, 1)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(box.w * s + 2 * PAD);
  canvas.height = Math.ceil(box.h * s + 2 * PAD);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(s, 0, 0, s, PAD - box.x * s, PAD - box.y * s);
  const [a, b, c, d, e, f] = pageToDisplayMatrix(pageW, pageH, rotation);
  ctx.transform(a, b, c, d, e, f);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const ink of block.inks) {
    const outline = inkOutline(ink);
    if (outline) {
      ctx.fill(new Path2D(outlineSvg(outline)));
    } else {
      ctx.lineWidth = Math.max(ink.width, 1);
      ctx.stroke(new Path2D(segsToSvg(smoothStroke(ink.points))));
    }
  }
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

async function recogniseOnDevice(canvases: HTMLCanvasElement[]): Promise<string[]> {
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const out: string[] = [];
    for (const c of canvases) {
      const { data } = await worker.recognize(c);
      // On-device OCR is built for print: accept only confident reads, never a guess.
      out.push(data.confidence >= 70 ? data.text : '');
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

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
  const progress = ctl.notify('info', 'Reading your handwriting…');
  try {
    const blocks = clusterInk(inks, width, height, rotation);
    const canvases = blocks.map((b) => renderBlock(b, width, height, rotation));
    const ai = await serverRecogniser();
    const texts = ai ? await recogniseOnServer(canvases) : await recogniseOnDevice(canvases);
    const created: TextAnnotation[] = [];
    const removeIds: string[] = [];
    blocks.forEach((b, i) => {
      const text = cleanRecognised(texts[i] ?? '');
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
      if (ai) ctl.notify('info', 'No readable handwriting found.', 'Drawings, ticks and scribbles are left as they are.');
      else
        ctl.notify(
          'error',
          'Handwriting reading is not switched on yet.',
          'Without it, only very neat print can be read on this device. To read real handwriting, add ANTHROPIC_API_KEY to the Vercel project (Settings → Environment Variables) and redeploy.',
        );
      return 0;
    }
    ctl.replaceAnnotations(page.id, stillThere, created, `Converted handwriting to text on page ${pageNo}`);
    ui.setTool('select');
    ui.set({ selectedAnns: { pageId: page.id, ids: created.map((a) => a.id) } });
    const skipped = blocks.length - created.length;
    ctl.notify(
      'success',
      created.length === 1 ? 'Handwriting converted to text.' : `${created.length} pieces of handwriting converted to text.`,
      skipped ? `${skipped} drawing${skipped === 1 ? '' : 's'} left as ${skipped === 1 ? 'it is' : 'they are'}. Double-click a text box to correct it.` : 'Double-click a text box to correct it.',
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
