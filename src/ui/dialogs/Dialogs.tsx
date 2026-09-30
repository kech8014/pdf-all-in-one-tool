import { useEffect, useState } from 'react';
import { totalAnnotations, usedSourceIds } from '../../core/operations';
import type { CompressionLevel, PageId } from '../../core/types';
import { COMPRESSION_LEVELS } from '../../engine/compress';
import type { WorkspaceSummary } from '../../persistence/idb';
import { formatBytes, type CompressReport } from '../../store/controller';
import { downloadBytes, safeFileName } from '../actions';
import { Dialog, MOD, useApp, useView } from '../components';
import { Icon } from '../Icon';
import { ui, useUi, type DialogState } from '../uiStore';
import { InsertDialog } from './InsertDialog';
import { SignatureDialog } from './SignatureDialog';

export function Dialogs() {
  const dialog = useUi((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'insert':
      return <InsertDialog {...dialog} />;
    case 'compress':
      return <CompressDialog />;
    case 'export':
      return <ExportDialog pageIds={dialog.pageIds} />;
    case 'workspaces':
      return <WorkspacesDialog />;
    case 'transfer':
      return <TransferDialog pageIds={dialog.pageIds} />;
    case 'signature':
      return <SignatureDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'confirm':
      return <ConfirmDialog {...dialog} />;
  }
}

/* -------------------------------- compress -------------------------------- */

function CompressDialog() {
  const { ctl } = useApp();
  const { state, task } = useView();
  const [level, setLevel] = useState<CompressionLevel>('balanced');
  const [report, setReport] = useState<CompressReport | null>(null);
  const size = usedSourceIds(state).reduce((n, id) => n + state.sources[id].byteLength, 0);
  const run = async () => {
    setReport(null);
    const r = await ctl.compress(level);
    if (r) setReport(r);
  };
  const saved = report ? Math.max(0, 1 - report.after / Math.max(1, report.before)) : 0;
  return (
    <Dialog
      title="Compress this document"
      onClose={() => ui.closeDialog()}
      testId="compress-dialog"
      footer={
        report ? (
          <>
            <span className="foot-summary">You can keep editing. Undo reverts the compression.</span>
            <button type="button" className="btn btn-labelled btn-primary" onClick={() => ui.closeDialog()} data-testid="compress-done">
              Continue editing
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-labelled" onClick={() => ui.closeDialog()}>
              Cancel
            </button>
            <button type="button" className="btn btn-labelled btn-primary" disabled={!!task} onClick={run} data-testid="compress-run">
              Compress
            </button>
          </>
        )
      }
    >
      <p className="lead">
        Current size of the document's files: <strong>{formatBytes(size)}</strong>. Pages, order, rotation and annotations stay exactly as they are — only the
        underlying files get smaller.
      </p>
      {report ? (
        <div className="result-card" data-testid="compress-result">
          <Icon name="check" size={28} />
          <div>
            <strong>
              {formatBytes(report.before)} → {formatBytes(report.after)} {saved > 0.005 ? `(${Math.round(saved * 100)}% smaller)` : ''}
            </strong>
            <p className="muted">
              {report.sourcesChanged
                ? `${report.sourcesChanged} file${report.sourcesChanged === 1 ? '' : 's'} compressed${report.imagesRecompressed ? `, ${report.imagesRecompressed} image${report.imagesRecompressed === 1 ? '' : 's'} resized` : ''}.`
                : 'The document was already compact; nothing changed.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="choice-list" role="radiogroup" aria-label="Compression level">
          {(Object.keys(COMPRESSION_LEVELS) as CompressionLevel[]).map((k) => (
            <label key={k} className={`choice ${level === k ? 'is-active' : ''}`}>
              <input type="radio" name="level" checked={level === k} onChange={() => setLevel(k)} data-testid={`level-${k}`} />
              <div>
                <strong>
                  {COMPRESSION_LEVELS[k].label}
                  {k === 'balanced' && <span className="tag">Recommended</span>}
                </strong>
                <p className="muted">{COMPRESSION_LEVELS[k].hint}</p>
              </div>
            </label>
          ))}
        </div>
      )}
      <p className="muted small">Text and drawings are never turned into pictures, so they stay sharp and searchable at every level.</p>
    </Dialog>
  );
}

/* --------------------------------- export --------------------------------- */

function ExportDialog({ pageIds }: { pageIds?: PageId[] }) {
  const { ctl } = useApp();
  const { state, selection, task } = useView();
  const [name, setName] = useState(safeFileName(state.name));
  const initialTitle = state.meta.title || state.name;
  const [title, setTitle] = useState(initialTitle);
  const [onlySelected, setOnlySelected] = useState(!!pageIds?.length);
  const [quality, setQuality] = useState<CompressionLevel | 'none'>('balanced');
  const ids = onlySelected ? (pageIds?.length ? pageIds : selection) : undefined;
  const n = ids ? ids.length : state.pages.length;
  const anns = totalAnnotations(state);
  const run = async () => {
    // Only a title the user actually typed becomes part of the document (and its history).
    if (title.trim() && title !== initialTitle) ctl.apply({ ...ctl.state, meta: { ...ctl.state.meta, title: title.trim() } }, 'Set document title', { coalesce: 'meta' });
    const bytes = await ctl.exportPdf({ pageIds: ids, title, compress: quality === 'none' ? null : quality });
    if (!bytes) return;
    downloadBytes(bytes, `${safeFileName(name)}.pdf`);
    const c = ctl.lastExportCompression;
    const saved = c && c.after < c.before ? ` — compressed from ${formatBytes(c.before)}` : '';
    ctl.notify('success', `Downloaded "${safeFileName(name)}.pdf" (${n} page${n === 1 ? '' : 's'}, ${formatBytes(bytes.byteLength)}${saved}).`, 'The workspace stays open — keep editing any time.');
    ui.closeDialog();
  };
  return (
    <Dialog
      title="Download PDF"
      onClose={() => ui.closeDialog()}
      testId="export-dialog"
      footer={
        <>
          <span className="foot-summary">
            {n} page{n === 1 ? '' : 's'}
            {anns ? `, ${anns} annotation${anns === 1 ? '' : 's'} included` : ''}
          </span>
          <button type="button" className="btn btn-labelled" onClick={() => ui.closeDialog()}>
            Cancel
          </button>
          <button type="button" className="btn btn-labelled btn-primary" disabled={!!task || !n} onClick={run} data-testid="export-run">
            <Icon name="download" /> Download
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>
          File name
          <div className="input-suffix">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="export-name" />
            <span>.pdf</span>
          </div>
        </label>
        <label>
          Document title <span className="muted">(shown by PDF readers)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          File size
          <select value={quality} onChange={(e) => setQuality(e.target.value as CompressionLevel | 'none')} data-testid="export-quality">
            <option value="balanced">Auto-compress (recommended) — photos at 150 DPI</option>
            <option value="lossless">Lossless compression — no visible change</option>
            <option value="strong">Smallest file — photos at 96 DPI</option>
            <option value="none">No compression</option>
          </select>
        </label>
        {selection.length > 0 && selection.length < state.pages.length && (
          <label className="check">
            <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
            Only the {selection.length} selected page{selection.length === 1 ? '' : 's'}
          </label>
        )}
      </div>
      <p className="muted small">
        Original pages are copied as they are (text stays selectable, graphics stay sharp). Annotations are written into the pages; sticky notes become PDF comments.
      </p>
    </Dialog>
  );
}

/* ------------------------------- workspaces ------------------------------- */

function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function WorkspacesDialog() {
  const { ctl, session, switchTo } = useApp();
  const [list, setList] = useState<WorkspaceSummary[] | null>(null);
  const refresh = () => void session.list().then(setList);
  useEffect(refresh, [session]);
  return (
    <Dialog
      title="Your workspaces"
      onClose={() => ui.closeDialog()}
      testId="workspaces-dialog"
      footer={
        <>
          <span className="foot-summary">{session.persistent ? 'Saved automatically in this browser.' : 'This browser does not allow local storage; workspaces are not saved.'}</span>
          <button
            type="button"
            className="btn btn-labelled btn-primary"
            data-testid="new-workspace"
            onClick={async () => {
              await ctl.flush();
              switchTo(session.create());
              ui.closeDialog();
            }}
          >
            <Icon name="plus" /> New workspace
          </button>
        </>
      }
    >
      {!list ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">No saved workspaces yet.</p>
      ) : (
        <ul className="ws-list">
          {list.map((w) => (
            <li key={w.id} className={w.id === ctl.state.id ? 'is-current' : ''}>
              <Icon name="folder" />
              <div className="ws-meta">
                <strong>{w.name}</strong>
                <span className="muted">
                  {w.pageCount} page{w.pageCount === 1 ? '' : 's'} · edited {timeAgo(w.updatedAt)}
                </span>
              </div>
              {w.id === ctl.state.id ? (
                <span className="tag">Open</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-labelled"
                  onClick={async () => {
                    await ctl.flush();
                    const next = await session.open(w.id);
                    if (next) switchTo(next);
                    else ctl.notify('error', `"${w.name}" could not be opened.`);
                    ui.closeDialog();
                  }}
                >
                  Open
                </button>
              )}
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                title="Delete workspace"
                aria-label={`Delete ${w.name}`}
                onClick={() =>
                  ui.openDialog({
                    kind: 'confirm',
                    title: 'Delete workspace?',
                    message: `"${w.name}" and its ${w.pageCount} pages will be removed from this browser. Exported PDFs are not affected.`,
                    confirmLabel: 'Delete',
                    danger: true,
                    onConfirm: async () => {
                      await session.remove(w.id);
                      if (w.id === ctl.state.id) switchTo(session.create());
                      ui.openDialog({ kind: 'workspaces' });
                    },
                  })
                }
              >
                <Icon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function TransferDialog({ pageIds }: { pageIds: PageId[] }) {
  const { ctl, session } = useApp();
  const [list, setList] = useState<WorkspaceSummary[] | null>(null);
  const [target, setTarget] = useState<string>('new');
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => void session.list().then((l) => setList(l.filter((w) => w.id !== ctl.state.id))), [session, ctl]);
  const n = pageIds.length;
  return (
    <Dialog
      title={`Copy or move ${n} page${n === 1 ? '' : 's'}`}
      onClose={() => ui.closeDialog()}
      footer={
        <>
          <button type="button" className="btn btn-labelled" onClick={() => ui.closeDialog()}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-labelled btn-primary"
            disabled={busy || !session.persistent}
            onClick={async () => {
              setBusy(true);
              try {
                await ctl.flush();
                await session.transferPages(ctl, pageIds, target === 'new' ? null : target, move);
                const name = target === 'new' ? 'a new workspace' : `"${list?.find((w) => w.id === target)?.name}"`;
                ctl.notify('success', `${move ? 'Moved' : 'Copied'} ${n} page${n === 1 ? '' : 's'} to ${name}.`);
                ui.closeDialog();
              } catch (err) {
                ctl.notify('error', 'The pages could not be transferred.', String(err));
                setBusy(false);
              }
            }}
          >
            {move ? 'Move' : 'Copy'} {n} page{n === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>
          To workspace
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">A new workspace</option>
            {list?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.pageCount} pages)
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} /> Remove them from this workspace (move instead of copy)
        </label>
      </div>
      <p className="muted small">Pages keep their annotations. The other workspace gets its own independent copy.</p>
    </Dialog>
  );
}

/* -------------------------------- shortcuts ------------------------------- */

function ShortcutsDialog() {
  const rows: [string, string][] = [
    [`${MOD} Z / ${MOD} Shift Z`, 'Undo / redo (pages and annotations share one history)'],
    [`${MOD} O`, 'Add files'],
    [`${MOD} S`, 'Download PDF'],
    ['V H T P M E', 'Select, pan, text, pen, marker, eraser'],
    ['G U K', 'Highlight, underline, strikethrough'],
    ['R O L A', 'Rectangle, ellipse, line, arrow'],
    ['W N I', 'Whiteout, sticky note, image'],
    ['Space + drag', 'Pan with any tool'],
    [`${MOD} + / ${MOD} − / ${MOD} 0`, 'Zoom in / out / fit width'],
    [`${MOD} + scroll`, 'Zoom at the pointer'],
    ['PgUp / PgDn, Home / End', 'Previous / next / first / last page'],
    ['Delete', 'Delete the selected annotations (or pages in the organizer)'],
    [`${MOD} C / ${MOD} V / ${MOD} D`, 'Copy / paste / duplicate annotations'],
    ['Arrow keys (Shift = ×10)', 'Nudge selected annotations'],
    [`${MOD} ] / ${MOD} [`, 'Bring to front / send to back'],
    ['Alt + ↑ / ↓', 'Move selected pages (in the organizer)'],
    ['Shift / Ctrl + click', 'Select a range / several pages'],
    ['Esc', 'Finish editing, clear selection'],
  ];
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => ui.closeDialog()} width={620}>
      <table className="shortcuts">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

function ConfirmDialog(d: Extract<DialogState, { kind: 'confirm' }>) {
  return (
    <Dialog
      title={d.title}
      onClose={() => ui.closeDialog()}
      width={440}
      footer={
        <>
          <button type="button" className="btn btn-labelled" onClick={() => ui.closeDialog()}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn-labelled ${d.danger ? 'btn-danger' : 'btn-primary'}`}
            autoFocus
            onClick={() => {
              ui.closeDialog();
              d.onConfirm();
            }}
          >
            {d.confirmLabel}
          </button>
        </>
      }
    >
      <p>{d.message}</p>
    </Dialog>
  );
}
