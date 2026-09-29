import type { WorkspaceController } from '../store/controller';
import { useEffect, useRef, useState } from 'react';
import * as H from '../core/history';
import { getPage, usedSourceIds } from '../core/operations';
import { translateAnnotation } from '../core/geometry';
import type { WorkspaceSummary } from '../persistence/idb';
import { formatBytes } from '../store/controller';
import { FileList } from './organizer/FileList';
import { ACCEPT_ANY, addFilesAndOrganize, deletePagesWithUndo, extractPages, insertionIndexAfterActive, pickFiles, readFiles } from './actions';
import { IconButton, MOD, MenuButton, useApp, useView } from './components';
import { Dialogs } from './dialogs/Dialogs';
import { Icon } from './Icon';
import { stageImageForPlacement } from './imagePlacement';
import { PageList } from './organizer/PageList';
import { ui, useUi, ZOOM_STEPS } from './uiStore';
import { AnnotationToolbar, TOOL_BY_KEY } from './viewer/AnnotationToolbar';
import { cancelEditDraft, commitEditDraft } from './viewer/editing';
import { Viewer } from './viewer/Viewer';

export function Workspace() {
  const { ctl } = useApp();
  const view = useView();
  const mode = useUi((s) => s.view);
  const historyOpen = useUi((s) => s.historyOpen);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const [dropping, setDropping] = useState(false);
  const empty = view.state.pages.length === 0;

  useKeyboard();
  useUnloadGuard();

  return (
    <div
      className={`app ${historyOpen ? 'with-history' : ''}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (files.length) void addFilesAndOrganize(ctl, files, insertionIndexAfterActive(ctl));
      }}
    >
      <Header />
      {!empty && <DocToolbar />}
      {!empty && mode === 'edit' && <AnnotationToolbar />}
      <div className="main">
        {!empty && mode === 'edit' && sidebarOpen && (
          <aside className="sidebar" aria-label="Page organizer">
            <div className="sidebar-head">
              <span>Pages</span>
              <span className="muted">{view.selection.length > 1 ? `${view.selection.length} selected` : `${view.state.pages.length}`}</span>
            </div>
            <PageList layout="list" thumbWidth={150} />
          </aside>
        )}
        <main className="center">
          {empty ? <EmptyState /> : mode === 'edit' ? <Viewer /> : mode === 'files' ? <FileList /> : <OrganizeView />}
        </main>
        {historyOpen && <HistoryPanel />}
      </div>
      {dropping && !empty && (
        <div className="drop-overlay">
          <div>
            <Icon name="upload" size={36} />
            <strong>Drop to add after page {view.activePageId ? ctl.pageNumber(view.activePageId) : view.state.pages.length}</strong>
            <span>Tip: drop onto the page list to choose the exact position.</span>
          </div>
        </div>
      )}
      <input
        id="image-picker"
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const [input] = await readFiles([f]);
          await stageImageForPlacement(ctl, input.bytes, false);
        }}
      />
      <Dialogs />
      <Toasts />
      <BusyOverlay />
    </div>
  );
}

/* --------------------------------- header --------------------------------- */

function Header() {
  const { ctl, session, switchTo } = useApp();
  const { state, history, saveStatus, activePageId, exportedState } = useView();
  const historyOpen = useUi((s) => s.historyOpen);
  const [name, setName] = useState(state.name);
  useEffect(() => setName(state.name), [state.name]);
  const pageNo = activePageId ? ctl.pageNumber(activePageId) : 0;
  const size = usedSourceIds(state).reduce((n, id) => n + state.sources[id].byteLength, 0);
  const unexported = exportedState !== state && state.pages.length > 0;
  const statusText = { saved: 'Saved', saving: 'Saving…', pending: 'Saving…', error: 'Not saved', off: 'Not saved (storage unavailable)' }[saveStatus];
  return (
    <header className="topbar">
      <IconButton
        icon="home"
        label="Home — start page (this document stays saved under Recent)"
        testId="home-button"
        onClick={async () => {
          ui.set({ view: 'edit', selectedAnns: null, editDraft: null, dialog: null });
          if (!ctl.state.pages.length) return;
          await ctl.flush(); // saved before leaving, so it is listed under Recent
          switchTo(session.create());
        }}
      />
      <button type="button" className="brand" onClick={() => ui.openDialog({ kind: 'workspaces' })} title="Your workspaces" data-testid="workspaces-button">
        <span className="brand-mark"><Icon name="sparkle" size={14} fill="currentColor" strokeWidth={0} /></span>
        <span>Folio</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <div className="doc-title">
        <input
          className="name-input"
          value={name}
          aria-label="Workspace name"
          data-testid="workspace-name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => ctl.rename(name)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setName(state.name);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="doc-meta" data-testid="doc-meta">
          <span>
            {state.pages.length} page{state.pages.length === 1 ? '' : 's'}
          </span>
          {state.pages.length > 0 && <span>Page {pageNo} active</span>}
          {size > 0 && <span>{formatBytes(size)}</span>}
          <span className={`status status-${saveStatus}`} data-testid="save-status" title="Your work is saved in this browser automatically">
            {statusText}
          </span>
          {unexported && (
            <span className="status status-unexported" title="Changes since the last download" data-testid="unexported">
              Not downloaded yet
            </span>
          )}
        </div>
      </div>
      <div className="topbar-actions">
        <IconButton icon="undo" label={H.undoLabel(history) ? `Undo: ${H.undoLabel(history)}` : 'Undo'} shortcut={`${MOD} Z`} disabled={!H.canUndo(history)} onClick={() => ctl.undo()} testId="undo" />
        <IconButton icon="redo" label={H.redoLabel(history) ? `Redo: ${H.redoLabel(history)}` : 'Redo'} shortcut={`${MOD} Shift Z`} disabled={!H.canRedo(history)} onClick={() => ctl.redo()} testId="redo" />
        <IconButton icon="history" label="History" showLabel active={historyOpen} onClick={() => ui.set({ historyOpen: !historyOpen })} testId="history-toggle" />
        <IconButton icon="help" label="Keyboard shortcuts" onClick={() => ui.openDialog({ kind: 'shortcuts' })} />
        <IconButton icon="download" label="Download PDF" showLabel variant="primary" disabled={!state.pages.length} shortcut={`${MOD} S`} onClick={() => ui.openDialog({ kind: 'export' })} testId="export-button" />
      </div>
    </header>
  );
}

/* ----------------------------- document toolbar --------------------------- */

function DocToolbar() {
  const { ctl } = useApp();
  const { selection, state } = useView();
  const mode = useUi((s) => s.view);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const targets = ctl.targetPages();
  const n = targets.length;
  const what = n > 1 ? `${n} pages` : 'page';
  const at = insertionIndexAfterActive(ctl);
  return (
    <div className="doc-toolbar" role="toolbar" aria-label="Page operations">
      {mode === 'edit' && <IconButton icon="sidebar" label={sidebarOpen ? 'Hide pages' : 'Show pages'} active={sidebarOpen} onClick={() => ui.set({ sidebarOpen: !sidebarOpen })} />}
      <IconButton icon="plus" label="Add files" showLabel shortcut={`${MOD} O`} testId="add-files" onClick={async () => addFilesAndOrganize(ctl, await pickFiles(ACCEPT_ANY), state.pages.length)} />
      <MenuButton
        icon="filePlus"
        label="Insert"
        testId="insert-menu"
        items={[
          { label: `PDF pages after page ${at}…`, icon: 'filePlus', onClick: () => ui.openDialog({ kind: 'insert', index: at, mode: 'insert', accept: 'pdf' }), testId: 'insert-pdf' },
          { label: `Images after page ${at}…`, icon: 'image', onClick: () => ui.openDialog({ kind: 'insert', index: at, mode: 'insert', accept: 'image' }), testId: 'insert-images' },
          { label: `Blank page after page ${at}`, icon: 'blank', onClick: () => void ctl.insertBlankPage(at) },
        ]}
      />
      <span className="tb-sep" />
      <IconButton icon="rotateLeft" label={`Rotate ${what} left`} disabled={!n} onClick={() => ctl.rotatePages(targets, -90)} testId="rotate-left" />
      <IconButton icon="rotateRight" label={`Rotate ${what} right`} disabled={!n} onClick={() => ctl.rotatePages(targets, 90)} testId="rotate-right" />
      <IconButton icon="copy" label={`Duplicate ${what}`} disabled={!n} onClick={() => ctl.duplicatePages(targets)} testId="duplicate" />
      <IconButton icon="trash" label={`Delete ${what}`} disabled={!n} onClick={() => deletePagesWithUndo(ctl, targets)} testId="delete-pages" />
      <MenuButton
        icon="more"
        label="More"
        showLabel={false}
        testId="more-menu"
        items={[
          { label: `Download ${what} as a new PDF`, icon: 'extract', disabled: !n, onClick: () => void extractPages(ctl, targets) },
          { label: 'Replace page…', icon: 'replace', disabled: n !== 1, onClick: () => ui.openDialog({ kind: 'insert', index: ctl.pageNumber(targets[0]) - 1, mode: 'replace', accept: 'any', replacePageId: targets[0] }) },
          { label: `Copy / move ${what} to another workspace…`, icon: 'move', disabled: !n, onClick: () => ui.openDialog({ kind: 'transfer', pageIds: targets }) },
          { label: `Remove annotations from ${what}`, icon: 'eraser', disabled: !n, onClick: () => ctl.clearAnnotations(targets) },
          'divider',
          { label: 'Select all pages', onClick: () => ctl.selectAll(), shortcut: `${MOD} A` },
          { label: 'Clear selection', disabled: !selection.length, onClick: () => ctl.clearSelection() },
        ]}
      />
      <span className="tb-sep" />
      <IconButton icon="compress" label="Compress" showLabel onClick={() => ui.openDialog({ kind: 'compress' })} testId="compress-button" />
      <span className="tb-flex" />
      {selection.length > 1 && (
        <span className="selection-chip">
          {selection.length} pages selected
          <button type="button" onClick={() => ctl.clearSelection()} aria-label="Clear selection">
            <Icon name="close" size={12} />
          </button>
        </span>
      )}
      <div className="segmented" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'is-active' : ''} onClick={() => ui.set({ view: 'edit' })} data-testid="view-edit">
          <Icon name="edit" size={16} /> Edit
        </button>
        <button type="button" role="tab" aria-selected={mode === 'organize'} className={mode === 'organize' ? 'is-active' : ''} onClick={() => ui.set({ view: 'organize' })} data-testid="view-organize">
          <Icon name="grid" size={16} /> Organize pages
        </button>
        <button type="button" role="tab" aria-selected={mode === 'files'} className={mode === 'files' ? 'is-active' : ''} onClick={() => ui.set({ view: 'files' })} data-testid="view-files">
          <Icon name="folder" size={16} /> Organize PDFs
        </button>
      </div>
    </div>
  );
}

function OrganizeView() {
  const [size, setSize] = useState(() => Number(localStorage.getItem('pdf-workspace:grid-size')) || 170);
  return (
    <div className="organize">
      <div className="organize-head">
        <span>
          <strong>Organize pages.</strong> Drag to reorder · Ctrl/Shift-click to select several · drop files between pages to insert them there · double-click a page to edit it.
        </span>
        <label className="slider">
          <span className="slider-label">Size</span>
          <input
            type="range"
            min={100}
            max={300}
            value={size}
            aria-label="Thumbnail size"
            onChange={(e) => {
              setSize(Number(e.target.value));
              localStorage.setItem('pdf-workspace:grid-size', e.target.value);
            }}
          />
        </label>
      </div>
      <PageList layout="grid" thumbWidth={size} />
    </div>
  );
}

/* --------------------------------- panels --------------------------------- */

function HistoryPanel() {
  const { ctl } = useApp();
  const { history } = useView();
  const entries = history.entries.map((e, i) => ({ ...e, i })).reverse();
  return (
    <aside className="history" aria-label="History" data-testid="history-panel">
      <div className="sidebar-head">
        <span>History</span>
        <button type="button" className="btn btn-icon btn-ghost" onClick={() => ui.set({ historyOpen: false })} aria-label="Close history">
          <Icon name="close" />
        </button>
      </div>
      <p className="muted small history-hint">Everything you do is listed here. Click a step to go back to it — later steps stay available until you make a new change.</p>
      <ol className="history-list">
        {entries.map((e) => (
          <li key={e.i} className={`${e.i === history.index ? 'is-current' : ''} ${e.i > history.index ? 'is-future' : ''}`}>
            <button type="button" onClick={() => ctl.jumpTo(e.i)}>
              <span className="history-label">{e.label}</span>
              <span className="history-time">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function Toasts() {
  const { ctl } = useApp();
  const { notices } = useView();
  // One timer per toast, started once, so a busy session cannot keep old toasts alive.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const n of notices) {
      if (n.kind === 'error' || timers.current.has(n.id)) continue;
      timers.current.set(
        n.id,
        setTimeout(() => {
          timers.current.delete(n.id);
          ctl.dismiss(n.id);
        }, n.action ? 6500 : 3500),
      );
    }
  }, [notices, ctl]);
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);
  const visible = notices.slice(-3);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {visible.map((n) => (
        <div key={n.id} className={`toast toast-${n.kind}`} data-testid={`toast-${n.kind}`}>
          <Icon name={n.kind === 'error' ? 'alert' : n.kind === 'success' ? 'check' : 'info'} />
          <div className="toast-body">
            <span>{n.message}</span>
            {n.detail && (
              <details>
                <summary>Details</summary>
                <code>{n.detail}</code>
              </details>
            )}
          </div>
          {n.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                n.action!.run();
                ctl.dismiss(n.id);
              }}
            >
              {n.action.label}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => ctl.dismiss(n.id)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function BusyOverlay() {
  const { task } = useView();
  if (!task) return null;
  return (
    <div className="busy" role="alertdialog" aria-live="assertive" aria-label={task.label} data-testid="busy">
      <div className="busy-card">
        <div className="spinner" />
        <strong>{task.label}…</strong>
        <div className="progress">
          <div className={`progress-bar ${task.progress === null ? 'is-indeterminate' : ''}`} style={{ width: task.progress === null ? '40%' : `${Math.round(task.progress * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}

/**
 * Starting with several files opens "Organize PDFs" first, so the files can be put in
 * order before looking at pages. A single file goes straight to the pages.
 */
async function startWith(ctl: WorkspaceController, files: File[]) {
  await addFilesAndOrganize(ctl, files, 0);
}

function EmptyState() {
  const { ctl, session, switchTo } = useApp();
  const { history } = useView();
  const [over, setOver] = useState(false);
  const [recent, setRecent] = useState<WorkspaceSummary[]>([]);
  useEffect(() => {
    void session.list().then((l) => setRecent(l.filter((w) => w.pageCount > 0 && w.id !== ctl.state.id).slice(0, 4)));
  }, [session, ctl]);
  const choose = async () => startWith(ctl, await pickFiles(ACCEPT_ANY));
  return (
    <div className="home" data-testid="empty-state">
      <div className="home-grid" aria-hidden="true" />
      <section className="home-hero">
        <span className="pill-badge">
          <Icon name="sparkle" size={12} fill="currentColor" strokeWidth={0} className="spark" /> ONE LIVE DOCUMENT
        </span>
        <h1 className="home-title">
          <span className="dim">Every PDF task.</span>
          <br />
          One living document.
        </h1>
        <p className="home-lead">
          Merge, reorder, insert, compress, annotate and sign — in any order, as often as you like. Download only when it&rsquo;s finished. Nothing ever leaves your
          computer.
        </p>
        <div className="home-actions">
          <button type="button" className="pill pill-solid" data-testid="empty-choose" onClick={choose}>
            Choose files <Icon name="arrowRight" size={16} />
          </button>
          {recent.length > 0 ? (
            <button type="button" className="pill pill-ghost" onClick={() => ui.openDialog({ kind: 'workspaces' })}>
              Open a workspace <Icon name="folder" size={16} />
            </button>
          ) : (
            <button type="button" className="pill pill-ghost" onClick={() => ui.openDialog({ kind: 'shortcuts' })}>
              Keyboard shortcuts <Icon name="keyboard" size={16} />
            </button>
          )}
          {H.canUndo(history) && (
            <button type="button" className="pill pill-ghost" onClick={() => ctl.undo()}>
              <Icon name="undo" size={16} /> Undo “{H.undoLabel(history)}”
            </button>
          )}
        </div>
        <div className="home-caps">
          {['Merge', 'Reorder', 'Insert', 'Compress', 'Annotate', 'Sign'].map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      </section>

      <section
        className={`home-card ${over ? 'is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void startWith(ctl, [...e.dataTransfer.files]);
        }}
      >
        <div className="home-card-head">
          <span>New workspace</span>
          <span className="home-dots" aria-hidden="true">
            •••
          </span>
        </div>
        <button type="button" className="home-drop" onClick={choose} aria-label="Choose files to start">
          <div className="stack" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <strong>Drop PDFs or images</strong>
          <span>or click to browse · PDF, JPG, PNG, WebP, TIFF</span>
        </button>
        <div className="home-stats">
          <div>
            <b>0</b>
            <span>uploads</span>
          </div>
          <div>
            <b>100%</b>
            <span>on this device</span>
          </div>
          <div>
            <b>∞</b>
            <span>undo steps</span>
          </div>
        </div>
        {recent.length > 0 && (
          <div className="home-recent">
            <span className="home-recent-title">Recent</span>
            {recent.map((w) => (
              <button
                key={w.id}
                type="button"
                className="home-recent-item"
                onClick={async () => {
                  const next = await session.open(w.id);
                  if (next) switchTo(next);
                }}
              >
                <Icon name="file" size={16} />
                <span className="name">{w.name}</span>
                <span className="meta">{w.pageCount} pages</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* -------------------------------- keyboard -------------------------------- */

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function useKeyboard() {
  const { ctl } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const s = ui.get();
      if (s.dialog) return;
      if (isTyping(e.target)) {
        if (mod && k === 's') e.preventDefault();
        return;
      }
      const sel = s.selectedAnns;
      const activeId = ctl.view.activePageId;

      if (mod && k === 'z') {
        e.preventDefault();
        commitEditDraft(ctl);
        if (e.shiftKey) ctl.redo();
        else ctl.undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        ctl.redo();
        return;
      }
      if (mod && k === 's') {
        e.preventDefault();
        if (ctl.state.pages.length) ui.openDialog({ kind: 'export' });
        return;
      }
      if (mod && k === 'o') {
        e.preventDefault();
        void pickFiles(ACCEPT_ANY).then((f) => addFilesAndOrganize(ctl, f, ctl.state.pages.length));
        return;
      }
      if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        const z = s.zoom;
        ui.set({ zoom: ZOOM_STEPS.find((x) => x > z + 0.001) ?? z, zoomMode: 'custom' });
        return;
      }
      if (mod && k === '-') {
        e.preventDefault();
        const z = s.zoom;
        ui.set({ zoom: [...ZOOM_STEPS].reverse().find((x) => x < z - 0.001) ?? z, zoomMode: 'custom' });
        return;
      }
      if (mod && k === '0') {
        e.preventDefault();
        ui.set({ zoomMode: 'fit-width' });
        return;
      }
      if (e.key === 'Escape') {
        cancelEditDraft();
        if (s.selectedAnns) ui.clearAnns();
        else if (s.tool !== 'select') ui.setTool('select');
        else ctl.clearSelection();
        return;
      }
      if (sel) {
        const page = getPage(ctl.state, sel.pageId);
        const anns = page?.annotations.filter((a) => sel.ids.includes(a.id)) ?? [];
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          ctl.removeAnnotations(sel.ids.map((id) => ({ pageId: sel.pageId, annotationId: id })));
          ui.clearAnns();
          return;
        }
        if (mod && k === 'c') {
          ctl.copyAnnotations(sel.pageId, sel.ids);
          ctl.notify('info', `Copied ${sel.ids.length === 1 ? 'annotation' : `${sel.ids.length} annotations`}. Paste on any page with ${MOD} V.`);
          return;
        }
        if (mod && k === 'x') {
          ctl.copyAnnotations(sel.pageId, sel.ids);
          ctl.removeAnnotations(sel.ids.map((id) => ({ pageId: sel.pageId, annotationId: id })), 'Cut annotation');
          ui.clearAnns();
          return;
        }
        if (mod && k === 'd') {
          e.preventDefault();
          ui.selectAnns(sel.pageId, ctl.duplicateAnnotations(sel.pageId, sel.ids));
          return;
        }
        if (mod && (e.key === ']' || e.key === '[')) {
          e.preventDefault();
          ctl.reorderAnnotations(sel.pageId, sel.ids, e.key === ']' ? (e.shiftKey ? 'forward' : 'front') : e.shiftKey ? 'backward' : 'back');
          return;
        }
        if (e.key.startsWith('Arrow')) {
          e.preventDefault();
          const d = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
          const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
          ctl.updateAnnotations(sel.pageId, anns.map((a) => translateAnnotation(a, dx, dy)), 'Nudged annotation', `nudge:${sel.ids.join()}`);
          return;
        }
      }
      if (mod && k === 'v' && activeId && ctl.view.clipboard) {
        e.preventDefault();
        ui.selectAnns(activeId, ctl.pasteAnnotations(activeId));
        return;
      }
      if (mod && k === 'a' && ui.get().view === 'edit' && activeId) {
        e.preventDefault();
        const page = getPage(ctl.state, activeId);
        if (page?.annotations.length) ui.selectAnns(activeId, page.annotations.map((a) => a.id));
        else ctl.selectAll();
        return;
      }
      if (e.key === 'Delete' && ui.get().view === 'organize') {
        deletePagesWithUndo(ctl, ctl.targetPages());
        return;
      }
      if (['PageDown', 'PageUp', 'Home', 'End'].includes(e.key) && ctl.state.pages.length) {
        e.preventDefault();
        const ids = ctl.state.pages.map((p) => p.id);
        const cur = Math.max(0, activeId ? ids.indexOf(activeId) : 0);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, cur + (e.key === 'PageDown' ? 1 : -1)));
        ctl.setActive(ids[next]);
        ui.requestScroll();
        return;
      }
      if (e.key === '?') {
        ui.openDialog({ kind: 'shortcuts' });
        return;
      }
      if (!mod && !e.altKey && ctl.state.pages.length && ui.get().view === 'edit') {
        const tool = TOOL_BY_KEY[k];
        if (tool) {
          ui.setTool(tool);
          if (tool === 'image' && !ui.get().pendingImage) document.getElementById('image-picker')?.click();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl]);
}

function useUnloadGuard() {
  const { ctl } = useApp();
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      void ctl.flush();
      if (ctl.view.saveStatus === 'pending' || ctl.view.saveStatus === 'saving' || ctl.view.saveStatus === 'off' || ctl.view.saveStatus === 'error') {
        if (ctl.state.pages.length) {
          e.preventDefault();
          e.returnValue = '';
        }
      }
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') void ctl.flush();
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [ctl]);
}

