import { Fragment, memo, useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { displaySize, effectiveRotation, pageSize, pageToDisplayMatrix } from '../../core/geometry';
import type { Page, PageId, Rotation } from '../../core/types';
import { requestThumb } from '../../render/pdfRender';
import { deletePagesWithUndo, extractPages, importFilesAt } from '../actions';
import { Menu, useApp, useView, type MenuEntry } from '../components';
import { Icon } from '../Icon';
import { ui } from '../uiStore';
import { AnnotationShape } from '../viewer/AnnotationShape';

/**
 * Page organizer. One component serves both the sidebar (list) and the Organize view
 * (grid). Pages are addressed by id everywhere; drag-and-drop and file drops resolve to
 * an insertion gap, never to a numeric index computed before the drop.
 */

const PAGE_MIME = 'application/x-pdf-workspace-pages';

interface Props {
  layout: 'list' | 'grid';
  thumbWidth: number;
}

export function PageList({ layout, thumbWidth }: Props) {
  const { ctl } = useApp();
  const { state, selection, activePageId } = useView();
  const pages = state.pages;
  const anchor = useRef<PageId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ index: number; files: boolean } | null>(null);
  const [dragging, setDragging] = useState<PageId[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const selected = new Set(selection);

  // Keep the active thumbnail visible when it changes from elsewhere.
  useEffect(() => {
    if (!activePageId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-thumb-id="${activePageId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activePageId]);

  const openPage = useCallback(
    (id: PageId) => {
      ctl.setActive(id);
      ui.set({ view: 'edit' });
      ui.requestScroll();
    },
    [ctl],
  );

  const onThumbClick = useCallback(
    (e: MouseEvent, id: PageId) => {
      const ids = ctl.state.pages.map((p) => p.id);
      if (e.shiftKey && anchor.current && ids.includes(anchor.current)) {
        const a = ids.indexOf(anchor.current);
        const b = ids.indexOf(id);
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        ctl.select(e.ctrlKey || e.metaKey ? [...ctl.view.selection, ...range] : range, id);
      } else if (e.ctrlKey || e.metaKey) {
        const cur = ctl.view.selection;
        ctl.select(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], id);
        anchor.current = id;
      } else {
        ctl.select([id], id);
        anchor.current = id;
      }
      if (layout === 'list') ui.requestScroll();
    },
    [ctl, layout],
  );

  function insertMenu(index: number): MenuEntry[] {
    return [
      { label: 'Insert PDF pages…', icon: 'filePlus', onClick: () => ui.openDialog({ kind: 'insert', index, mode: 'insert', accept: 'pdf' }), testId: 'menu-insert-pdf' },
      { label: 'Insert images…', icon: 'image', onClick: () => ui.openDialog({ kind: 'insert', index, mode: 'insert', accept: 'image' }), testId: 'menu-insert-images' },
      { label: 'Insert blank page', icon: 'blank', onClick: () => void ctl.insertBlankPage(index) },
    ];
  }

  const onContext = useCallback(
    (e: MouseEvent, id: PageId) => {
      e.preventDefault();
      if (!ctl.view.selection.includes(id)) ctl.select([id], id);
      const targets = ctl.view.selection.includes(id) ? ctl.targetPages() : [id];
      const i = ctl.state.pages.findIndex((p) => p.id === id);
      const n = targets.length;
      const many = n > 1 ? ` ${n} pages` : '';
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'Open in editor', icon: 'edit', onClick: () => openPage(id) },
          'divider',
          { label: 'Insert before this page…', icon: 'filePlus', onClick: () => ui.openDialog({ kind: 'insert', index: i, mode: 'insert', accept: 'any' }) },
          { label: 'Insert after this page…', icon: 'filePlus', onClick: () => ui.openDialog({ kind: 'insert', index: i + 1, mode: 'insert', accept: 'any' }) },
          'divider',
          { label: `Rotate left${many}`, icon: 'rotateLeft', onClick: () => ctl.rotatePages(targets, -90) },
          { label: `Rotate right${many}`, icon: 'rotateRight', onClick: () => ctl.rotatePages(targets, 90) },
          { label: `Duplicate${many}`, icon: 'copy', onClick: () => ctl.duplicatePages(targets) },
          { label: 'Replace page…', icon: 'replace', disabled: n !== 1, onClick: () => ui.openDialog({ kind: 'insert', index: i, mode: 'replace', accept: 'any', replacePageId: id }) },
          { label: `Download${many || ' page'} as PDF`, icon: 'extract', onClick: () => void extractPages(ctl, targets) },
          { label: `Copy/move${many || ' page'} to workspace…`, icon: 'move', onClick: () => ui.openDialog({ kind: 'transfer', pageIds: targets }) },
          { label: 'Remove annotations', icon: 'eraser', onClick: () => ctl.clearAnnotations(targets) },
          'divider',
          { label: `Delete${many || ' page'}`, icon: 'trash', danger: true, onClick: () => deletePagesWithUndo(ctl, targets), shortcut: 'Del' },
        ],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctl, openPage],
  );

  /* ------------------------------ drag and drop ----------------------------- */

  const onDragStart = useCallback(
    (e: DragEvent, id: PageId) => {
      let ids = ctl.view.selection.includes(id) ? ctl.targetPages() : [id];
      if (!ctl.view.selection.includes(id)) ctl.select([id], id);
      ids = ctl.state.pages.filter((p) => ids.includes(p.id)).map((p) => p.id);
      e.dataTransfer.setData(PAGE_MIME, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = ids.length === 1 ? `Page ${ctl.pageNumber(ids[0])}` : `${ids.length} pages`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 20);
      setTimeout(() => ghost.remove(), 0);
      setDragging(ids);
    },
    [ctl],
  );

  function gapFromEvent(e: DragEvent): number | null {
    const el = e.target as Element;
    const gap = el.closest?.('[data-gap-index]');
    if (gap) return Number(gap.getAttribute('data-gap-index'));
    const thumb = el.closest?.('[data-thumb-index]');
    if (!thumb) return null;
    const i = Number(thumb.getAttribute('data-thumb-index'));
    const r = thumb.getBoundingClientRect();
    const before = layout === 'list' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
    return before ? i : i + 1;
  }

  function onDragOver(e: DragEvent) {
    const types = [...e.dataTransfer.types];
    const internal = types.includes(PAGE_MIME);
    const files = types.includes('Files');
    if (!internal && !files) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    const idx = gapFromEvent(e);
    if (idx !== null && (drop?.index !== idx || drop.files !== files)) setDrop({ index: idx, files });
    // Auto-scroll near the edges while dragging.
    const box = listRef.current?.getBoundingClientRect();
    if (box && listRef.current) {
      if (e.clientY < box.top + 48) listRef.current.scrollTop -= 14;
      else if (e.clientY > box.bottom - 48) listRef.current.scrollTop += 14;
    }
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const idx = drop?.index ?? gapFromEvent(e) ?? ctl.state.pages.length;
    setDrop(null);
    setDragging(null);
    const raw = e.dataTransfer.getData(PAGE_MIME);
    if (raw) {
      const ids = JSON.parse(raw) as PageId[];
      const before = ctl.state.pages[idx]?.id ?? null;
      ctl.movePages(ids, before);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length) await importFilesAt(ctl, files, idx);
  }

  /* -------------------------------- keyboard -------------------------------- */

  function onKeyDown(e: KeyboardEvent) {
    const ids = pages.map((p) => p.id);
    const cur = activePageId ? ids.indexOf(activePageId) : -1;
    const prevKey = layout === 'list' ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = layout === 'list' ? 'ArrowDown' : 'ArrowRight';
    if (e.key === prevKey || e.key === nextKey) {
      e.preventDefault();
      const dir = e.key === nextKey ? 1 : -1;
      if (e.altKey) {
        // Alt+arrow moves the selected pages.
        const targets = ctl.targetPages();
        const first = ids.indexOf(targets[0]);
        const lastI = ids.indexOf(targets[targets.length - 1]);
        const to = dir < 0 ? first - 1 : lastI + 2;
        if (to >= 0 && to <= ids.length) ctl.movePages(targets, ids[to] ?? null);
        return;
      }
      const next = Math.max(0, Math.min(ids.length - 1, cur + dir));
      const id = ids[next];
      if (e.shiftKey) ctl.select([...new Set([...ctl.view.selection, ids[cur], id].filter(Boolean))], id);
      else ctl.select([id], id);
      anchor.current = id;
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deletePagesWithUndo(ctl, ctl.targetPages());
    } else if (e.key === 'Enter' && activePageId) {
      openPage(activePageId);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      ctl.selectAll();
    }
  }

  return (
    <div
      ref={listRef}
      className={`page-list layout-${layout} ${dragging ? 'is-dragging' : ''}`}
      role="listbox"
      aria-label="Pages"
      aria-multiselectable="true"
      tabIndex={0}
      data-testid={`page-list-${layout}`}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!listRef.current?.contains(e.relatedTarget as Node)) setDrop(null);
      }}
      onDrop={onDrop}
      onDragEnd={() => {
        setDrop(null);
        setDragging(null);
      }}
      style={{ ['--thumb-w' as string]: `${thumbWidth}px` }}
    >
      {pages.map((p, i) => (
        <Fragment key={p.id}>
          <Gap index={i} layout={layout} active={drop?.index === i} files={!!drop?.files} onMenu={(x, y) => setMenu({ x, y, items: insertMenu(i) })} />
          <Thumb
            page={p}
            index={i}
            width={thumbWidth}
            blobId={state.sources[p.sourceId].blobId}
            size={pageSize(state, p)}
            rotation={effectiveRotation(state, p)}
            sourceName={state.sources[p.sourceId].name}
            selected={selected.has(p.id)}
            active={p.id === activePageId}
            dimmed={!!dragging?.includes(p.id)}
            onClick={onThumbClick}
            onDoubleClick={openPage}
            onContextMenu={onContext}
            onDragStart={onDragStart}
          />
        </Fragment>
      ))}
      <Gap index={pages.length} layout={layout} active={drop?.index === pages.length} files={!!drop?.files} last onMenu={(x, y) => setMenu({ x, y, items: insertMenu(pages.length) })} />
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Gap({ index, layout, active, files, last, onMenu }: { index: number; layout: string; active: boolean; files: boolean; last?: boolean; onMenu: (x: number, y: number) => void }) {
  return (
    <div className={`gap gap-${layout} ${active ? 'is-drop' : ''} ${files ? 'is-files' : ''} ${last ? 'is-last' : ''}`} data-gap-index={index}>
      <button
        type="button"
        className="gap-add"
        title={index === 0 ? 'Insert at the start' : `Insert after page ${index}`}
        aria-label={index === 0 ? 'Insert at the start' : `Insert after page ${index}`}
        data-testid={`gap-add-${index}`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(r.right + 4, r.top);
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}

interface ThumbProps {
  page: Page;
  index: number;
  width: number;
  blobId: string;
  size: { width: number; height: number };
  rotation: Rotation;
  sourceName: string;
  selected: boolean;
  active: boolean;
  dimmed: boolean;
  onClick: (e: MouseEvent, id: PageId) => void;
  onDoubleClick: (id: PageId) => void;
  onContextMenu: (e: MouseEvent, id: PageId) => void;
  onDragStart: (e: DragEvent, id: PageId) => void;
}

const Thumb = memo(function Thumb(p: ThumbProps) {
  const { ctl } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const disp = displaySize(p.size.width, p.size.height, p.rotation);
  const aspect = Math.min(disp.height / disp.width, 1.9);
  const h = Math.round(p.width * aspect);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((x) => x.isIntersecting)), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const px = Math.round(p.width * Math.min(2, window.devicePixelRatio || 1));
    const job = requestThumb(p.blobId, p.page.sourcePageIndex, p.rotation, px);
    let alive = true;
    job.promise
      .then((bmp) => {
        const c = canvasRef.current;
        if (!alive || !c) return;
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
        setFailed(false);
      })
      .catch((err) => {
        if (alive && String(err) !== 'Error: cancelled') setFailed(true);
      });
    return () => {
      alive = false;
      job.cancel();
    };
  }, [visible, p.blobId, p.page.sourcePageIndex, p.rotation, p.width]);

  const m = pageToDisplayMatrix(p.size.width, p.size.height, p.rotation);
  const n = p.page.annotations.length;
  return (
    <div
      ref={boxRef}
      className={`thumb ${p.selected ? 'is-selected' : ''} ${p.active ? 'is-active' : ''} ${p.dimmed ? 'is-dimmed' : ''}`}
      role="option"
      aria-selected={p.selected}
      aria-label={`Page ${p.index + 1}`}
      data-thumb-index={p.index}
      data-thumb-id={p.page.id}
      data-testid={`thumb-${p.index + 1}`}
      draggable
      onDragStart={(e) => p.onDragStart(e, p.page.id)}
      onClick={(e) => p.onClick(e, p.page.id)}
      onDoubleClick={() => p.onDoubleClick(p.page.id)}
      onContextMenu={(e) => p.onContextMenu(e, p.page.id)}
      title={`${p.sourceName} — page ${p.page.sourcePageIndex + 1}${n ? ` · ${n} annotation${n === 1 ? '' : 's'}` : ''}`}
    >
      <div className="thumb-frame" style={{ width: p.width, height: h }}>
        <canvas ref={canvasRef} className="thumb-canvas" />
        {n > 0 && (
          <svg className="thumb-anns" viewBox={`0 0 ${disp.width} ${disp.height}`} preserveAspectRatio="none">
            <g transform={`matrix(${m.join(' ')})`}>
              {p.page.annotations.map((a) => (
                <AnnotationShape key={a.id} a={a} />
              ))}
            </g>
          </svg>
        )}
        {failed && <div className="thumb-error">Cannot preview</div>}
        <div className="thumb-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" title="Rotate left" aria-label={`Rotate page ${p.index + 1} left`} onClick={() => ctl.rotatePages([p.page.id], -90)}>
            <Icon name="rotateLeft" size={14} />
          </button>
          <button type="button" title="Rotate right" aria-label={`Rotate page ${p.index + 1} right`} onClick={() => ctl.rotatePages([p.page.id], 90)}>
            <Icon name="rotateRight" size={14} />
          </button>
          <button type="button" title="Delete page" aria-label={`Delete page ${p.index + 1}`} data-testid={`thumb-delete-${p.index + 1}`} onClick={() => deletePagesWithUndo(ctl, [p.page.id])}>
            <Icon name="trash" size={14} />
          </button>
        </div>
        {p.selected && (
          <span className="thumb-check" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
        )}
      </div>
      <div className="thumb-caption">
        <span className="thumb-num">{p.index + 1}</span>
        {n > 0 && (
          <span className="thumb-badge" title={`${n} annotation${n === 1 ? '' : 's'}`}>
            <Icon name="pen" size={11} /> {n}
          </span>
        )}
      </div>
    </div>
  );
});
