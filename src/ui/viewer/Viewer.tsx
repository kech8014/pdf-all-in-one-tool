import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { effectiveRotation, displaySize, pageSize } from '../../core/geometry';
import { IconButton, useApp, useView } from '../components';
import { MAX_ZOOM, MIN_ZOOM, PT_TO_PX, ZOOM_STEPS, ui, useUi } from '../uiStore';
import { PageView } from './PageView';

const PAD = 24;
const GAP = 34;
const ZOOMBAR_SPACE = 64;

/**
 * Continuous vertical viewer. Only pages near the viewport are mounted (and therefore
 * rendered), so a 1,000-page document costs the same as a 5-page one while scrolling.
 */
export function Viewer() {
  const { ctl } = useApp();
  const { state, activePageId } = useView();
  const zoom = useUi((s) => s.zoom);
  const zoomMode = useUi((s) => s.zoomMode);
  const tool = useUi((s) => s.tool);
  const scrollRequest = useUi((s) => s.scrollRequest);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600, top: 0 });
  const activeFromScroll = useRef<string | null>(null);
  const anchor = useRef<{ index: number; frac: number; offset: number } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  const geo = useMemo(
    () =>
      state.pages.map((page) => {
        const { width, height } = pageSize(state, page);
        const rotation = effectiveRotation(state, page);
        const d = displaySize(width, height, rotation);
        const src = state.sources[page.sourceId];
        return { page, width, height, rotation, dispW: d.width, dispH: d.height, blobId: src.blobId, index: page.sourcePageIndex };
      }),
    [state],
  );

  const activeIdx = Math.max(0, geo.findIndex((g) => g.page.id === activePageId));
  const maxW = geo.reduce((m, g) => Math.max(m, g.dispW), 1);
  const availW = Math.max(100, box.w - 2 * PAD);
  // Leave room for the floating zoom bar so "Fit page" really shows the whole page.
  const availH = Math.max(100, box.h - 2 * PAD - ZOOMBAR_SPACE);
  const ref = geo[activeIdx];
  let scale = zoom * PT_TO_PX;
  if (zoomMode === 'fit-width') scale = availW / maxW;
  else if (zoomMode === 'fit-page' && ref) scale = Math.min(availW / ref.dispW, availH / ref.dispH);
  scale = Math.max(MIN_ZOOM * PT_TO_PX, Math.min(MAX_ZOOM * PT_TO_PX, scale));

  // Report the effective zoom so the zoom box shows it in fit modes.
  useEffect(() => {
    const z = scale / PT_TO_PX;
    if (Math.abs(z - ui.get().zoom) > 0.001) ui.set({ zoom: z });
  }, [scale]);

  const layout = useMemo(() => {
    const tops: number[] = [];
    let y = PAD;
    for (const g of geo) {
      tops.push(y);
      y += g.dispH * scale + GAP;
    }
    return { tops, total: y - GAP + PAD + ZOOMBAR_SPACE };
  }, [geo, scale]);

  const innerW = Math.max(box.w, maxW * scale + 2 * PAD);

  /* ------------------------------ viewport tracking ------------------------- */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight, top: el.scrollTop });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageAt = useCallback(
    (y: number) => {
      const { tops } = layout;
      let lo = 0;
      let hi = tops.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [layout],
  );

  const raf = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el || !geo.length) return;
      setBox((b) => (b.top === el.scrollTop ? b : { ...b, top: el.scrollTop }));
      const i = pageAt(el.scrollTop + el.clientHeight * 0.35);
      const id = geo[i]?.page.id;
      if (id && id !== ctl.view.activePageId) {
        activeFromScroll.current = id;
        ctl.setActive(id);
      }
    });
  };

  // Keep the reading position when the zoom (and therefore the layout) changes.
  const lastScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || lastScale.current === scale || !geo.length) {
      lastScale.current = scale;
      return;
    }
    const a = anchor.current ?? (() => {
      const oldTops: number[] = [];
      let y = PAD;
      for (const g of geo) {
        oldTops.push(y);
        y += g.dispH * lastScale.current + GAP;
      }
      let i = 0;
      while (i + 1 < oldTops.length && oldTops[i + 1] <= el.scrollTop) i++;
      return { index: i, frac: (el.scrollTop - oldTops[i]) / (geo[i].dispH * lastScale.current + GAP), offset: 0 };
    })();
    anchor.current = null;
    lastScale.current = scale;
    const g = geo[a.index];
    if (g) el.scrollTop = layout.tops[a.index] + a.frac * (g.dispH * scale + GAP) - a.offset;
  }, [scale, geo, layout]);

  // Scroll to the active page when it was chosen elsewhere (organizer, page box, keys).
  const lastRequest = useRef(scrollRequest);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !activePageId) return;
    const explicit = scrollRequest !== lastRequest.current;
    lastRequest.current = scrollRequest;
    if (!explicit && activeFromScroll.current === activePageId) return;
    const i = geo.findIndex((g) => g.page.id === activePageId);
    if (i < 0) return;
    const top = layout.tops[i];
    const bottom = top + geo[i].dispH * scale;
    if (explicit || top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) el.scrollTop = top - PAD / 2;
    activeFromScroll.current = activePageId;
    // Only re-run when the target changes, not on every layout change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId, scrollRequest]);

  /* ---------------------------------- zoom ---------------------------------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const y = el.scrollTop + (e.clientY - r.top);
      const i = pageAt(y);
      const g = geo[i];
      if (!g) return;
      const cur = ui.get().zoom;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cur * Math.exp(-e.deltaY * 0.0022)));
      anchor.current = { index: i, frac: (y - layout.tops[i]) / (g.dispH * scale + GAP), offset: e.clientY - r.top };
      ui.set({ zoom: next, zoomMode: 'custom' });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [geo, layout, pageAt, scale]);

  /* ---------------------------------- panning ------------------------------- */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        if (!e.repeat) setSpaceDown(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceDown(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  const panning = tool === 'hand' || spaceDown;
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  /* --------------------------------- render --------------------------------- */
  if (!geo.length) return null;
  const overscan = box.h;
  const first = pageAt(Math.max(0, box.top - overscan));
  const last = pageAt(box.top + box.h + overscan);

  return (
    <div className="viewer">
      <div
        ref={scrollRef}
        className={`viewer-scroll ${panning ? 'is-panning' : ''}`}
        onScroll={onScroll}
        data-testid="viewer"
        onPointerDownCapture={(e) => {
          if (!(panning || e.button === 1)) return;
          e.preventDefault();
          e.stopPropagation();
          const el = scrollRef.current!;
          pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (!p) return;
          const el = scrollRef.current!;
          el.scrollLeft = p.left - (e.clientX - p.x);
          el.scrollTop = p.top - (e.clientY - p.y);
        }}
        onPointerUp={() => (pan.current = null)}
      >
        <div className="viewer-inner" style={{ height: layout.total, width: innerW }}>
          {geo.slice(first, last + 1).map((g, k) => {
            const i = first + k;
            return (
              <div key={g.page.id} className="viewer-slot" style={{ top: layout.tops[i], left: innerW / 2, transform: 'translateX(-50%)' }}>
                <PageView
                  page={g.page}
                  blobId={g.blobId}
                  sourceIndex={g.index}
                  width={g.width}
                  height={g.height}
                  rotation={g.rotation}
                  scale={scale}
                  pageNumber={i + 1}
                  active={g.page.id === activePageId}
                />
                <div className="viewer-page-label">
                  Page {i + 1} of {geo.length}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <ZoomBar pageNumber={activeIdx + 1} pageCount={geo.length} />
    </div>
  );
}

function ZoomBar({ pageNumber, pageCount }: { pageNumber: number; pageCount: number }) {
  const { ctl } = useApp();
  const zoom = useUi((s) => s.zoom);
  const zoomMode = useUi((s) => s.zoomMode);
  const [pageText, setPageText] = useState(String(pageNumber));
  useEffect(() => setPageText(String(pageNumber)), [pageNumber]);

  const go = (n: number) => {
    const p = ctl.state.pages[Math.max(0, Math.min(pageCount - 1, n - 1))];
    if (p) {
      ctl.setActive(p.id);
      ui.requestScroll();
    }
  };
  const step = (dir: 1 | -1) => {
    const cur = zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
    ui.set({ zoom: next ?? cur, zoomMode: 'custom' });
  };
  return (
    <div className="zoombar" role="toolbar" aria-label="Zoom and page navigation">
      <IconButton icon="chevronLeft" label="Previous page" shortcut="PgUp" onClick={() => go(pageNumber - 1)} disabled={pageNumber <= 1} />
      <label className="page-box">
        <span className="sr-only">Page number</span>
        <input
          value={pageText}
          inputMode="numeric"
          aria-label="Current page"
          data-testid="page-input"
          onChange={(e) => setPageText(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            go(Number(pageText) || 1);
            // Hand the keyboard back to the document so shortcuts work right away.
            e.currentTarget.blur();
          }}
          onBlur={() => setPageText(String(pageNumber))}
        />
        <span>/ {pageCount}</span>
      </label>
      <IconButton icon="chevronRight" label="Next page" shortcut="PgDn" onClick={() => go(pageNumber + 1)} disabled={pageNumber >= pageCount} />
      <span className="zoombar-sep" />
      <IconButton icon="zoomOut" label="Zoom out" shortcut="Ctrl -" onClick={() => step(-1)} testId="zoom-out" />
      <ZoomBox zoom={zoom} zoomMode={zoomMode} />
      <IconButton icon="zoomIn" label="Zoom in" shortcut="Ctrl +" onClick={() => step(1)} testId="zoom-in" />
      <IconButton icon="fitWidth" label="Fit width" active={zoomMode === 'fit-width'} onClick={() => ui.set({ zoomMode: 'fit-width' })} />
      <IconButton icon="fitPage" label="Fit page" active={zoomMode === 'fit-page'} onClick={() => ui.set({ zoomMode: 'fit-page' })} />
    </div>
  );
}

/**
 * Zoom box: type any percentage (e.g. "135" or "135%") or pick a preset / fit mode.
 */
function ZoomBox({ zoom, zoomMode }: { zoom: number; zoomMode: string }) {
  const shown = zoomMode === 'fit-width' ? 'Fit width' : zoomMode === 'fit-page' ? 'Fit page' : `${Math.round(zoom * 100)}%`;
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);
  const apply = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (v.startsWith('fit w')) ui.set({ zoomMode: 'fit-width' });
    else if (v.startsWith('fit p')) ui.set({ zoomMode: 'fit-page' });
    else {
      const n = parseFloat(v.replace('%', ''));
      if (Number.isFinite(n) && n > 0) ui.set({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, n / 100)), zoomMode: 'custom' });
    }
    setEditing(false);
  };
  return (
    <>
      <input
        className="zoom-select"
        aria-label="Zoom level"
        data-testid="zoom-select"
        list="zoom-presets"
        value={editing ? text : shown}
        onFocus={(e) => {
          setEditing(true);
          setText('');
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          // Picking an option from the list applies it immediately.
          if (ZOOM_PRESET_LABELS.includes(e.target.value)) {
            apply(e.target.value);
            e.currentTarget.blur();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            apply(text);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => setEditing(false)}
      />
      <datalist id="zoom-presets">
        {ZOOM_PRESET_LABELS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </>
  );
}

const ZOOM_PRESET_LABELS = ['Fit width', 'Fit page', ...ZOOM_STEPS.filter((z) => z >= 0.25).map((z) => `${Math.round(z * 100)}%`)];
