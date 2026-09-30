import { useEffect, useRef, useState, type DragEvent } from 'react';
import { effectiveRotation } from '../../core/geometry';
import { documentGroups } from '../../core/operations';
import type { SourceId } from '../../core/types';
import { requestThumb } from '../../render/pdfRender';
import { useApp, useView } from '../components';
import { Icon } from '../Icon';
import { ui } from '../uiStore';
import { ACCEPT_ANY, importFilesAt, pickFiles } from '../actions';

/**
 * "Organize PDFs": the document seen file by file. Each file is one card (first page,
 * name, page count); drag the cards — or use the arrows — to decide which file comes
 * before which, then "Done" shows the pages. Reordering here moves every page of a file
 * as one block, and is one undo step like everything else.
 */
export function FileList() {
  const { ctl } = useApp();
  const { state } = useView();
  const groups = documentGroups(state);
  const [dragging, setDragging] = useState<SourceId | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const order = groups.map((g) => g.sourceId);

  const move = (id: SourceId, to: number) => {
    const rest = order.filter((x) => x !== id);
    rest.splice(Math.max(0, Math.min(rest.length, to)), 0, id);
    ctl.reorderDocuments(rest);
  };

  const onDragOver = (e: DragEvent, i: number) => {
    if (!dragging && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const at = dropAt ?? groups.length;
    setDropAt(null);
    if (dragging) {
      const from = order.indexOf(dragging);
      move(dragging, at > from ? at - 1 : at);
      setDragging(null);
      return;
    }
    // Files dropped from the computer land between the files, at the marker.
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const pageIndex = at >= groups.length ? state.pages.length : state.pages.findIndex((p) => p.id === groups[at].pageIds[0]);
    await importFilesAt(ctl, files, pageIndex);
  };

  return (
    <div className="files" data-testid="file-list">
      <div className="files-head">
        <div>
          <h2>Organize PDFs</h2>
          <p className="muted">
            {groups.length} file{groups.length === 1 ? '' : 's'} · {state.pages.length} pages. Drag a file to put it before or after another. Nothing is merged until you download.
          </p>
        </div>
        <div className="files-actions">
          <button type="button" className="pill" onClick={async () => importFilesAt(ctl, await pickFiles(ACCEPT_ANY), state.pages.length)} data-testid="files-add">
            <Icon name="plus" size={16} /> Add files
          </button>
          <button type="button" className="pill pill-solid" onClick={() => ui.set({ view: 'organize' })} data-testid="files-done">
            <Icon name="check" size={16} /> Save order — show pages
          </button>
        </div>
      </div>
      <ol
        className="files-grid"
        onDragOver={(e) => {
          if (!dragging && !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
        }}
        onDrop={onDrop}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropAt(null);
        }}
      >
        {groups.map((g, i) => {
          const src = state.sources[g.sourceId];
          const first = state.pages.find((p) => p.id === g.pageIds[0])!;
          return (
            <li
              key={g.sourceId}
              className={`file-card ${dragging === g.sourceId ? 'is-dragging' : ''} ${dropAt === i ? 'drop-before' : ''} ${dropAt === i + 1 && i === groups.length - 1 ? 'drop-after' : ''}`}
              draggable
              data-testid={`file-${i + 1}`}
              onDragStart={(e) => {
                setDragging(g.sourceId);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', src.name);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropAt(null);
              }}
              onDragOver={(e) => onDragOver(e, i)}
              onDoubleClick={() => {
                ctl.setActive(first.id);
                ui.set({ view: 'organize' });
              }}
            >
              <button
                type="button"
                className="file-remove"
                title="Remove this PDF"
                aria-label={`Remove ${src.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  ctl.removeDocument(g.sourceId);
                  ctl.notify('info', `Removed ${src.name}.`, undefined, { label: 'Undo', run: () => ctl.undo() });
                }}
                data-testid={`file-remove-${i + 1}`}
              >
                <Icon name="close" size={16} strokeWidth={2.6} />
              </button>
              <FileThumb blobId={src.blobId} index={first.sourcePageIndex} rotation={effectiveRotation(state, first)} />
              <div className="file-meta">
                <span className="file-name" title={src.name}>
                  {src.name}
                </span>
                <span className="muted">
                  {g.pageIds.length} page{g.pageIds.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="file-btns">
                <button type="button" className="tone tone-blue" title="Move earlier" aria-label={`Move ${src.name} earlier`} disabled={i === 0} onClick={() => move(g.sourceId, i - 1)} data-testid={`file-up-${i + 1}`}>
                  <Icon name="chevronLeft" size={18} />
                </button>
                <button type="button" className="tone tone-blue" title="Move later" aria-label={`Move ${src.name} later`} disabled={i === groups.length - 1} onClick={() => move(g.sourceId, i + 1)} data-testid={`file-down-${i + 1}`}>
                  <Icon name="chevronRight" size={18} />
                </button>
                <span className="file-pos" title={`Position ${i + 1} of ${groups.length}`}>
                  {i + 1}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FileThumb({ blobId, index, rotation }: { blobId: string; index: number; rotation: Parameters<typeof requestThumb>[2] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const job = requestThumb(blobId, index, rotation, Math.round(180 * Math.min(2, window.devicePixelRatio || 1)));
    let alive = true;
    job.promise
      .then((bmp) => {
        const c = ref.current;
        if (!alive || !c) return;
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
      })
      .catch((err) => {
        if (alive && String(err) !== 'Error: cancelled') setFailed(true);
      });
    return () => {
      alive = false;
      job.cancel();
    };
  }, [blobId, index, rotation]);
  return <div className="file-thumb">{failed ? <span className="muted">No preview</span> : <canvas ref={ref} />}</div>;
}
