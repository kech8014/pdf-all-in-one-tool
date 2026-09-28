import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setBlobReader } from '../render/pdfRender';
import type { WorkspaceController } from '../store/controller';
import { Session } from '../store/session';
import { createWorkerEngine } from '../workers/engineClient';
import { AppContext } from './components';
import { ui } from './uiStore';
import { setAnnotationBlobLoader } from './viewer/AnnotationShape';
import { Workspace } from './Workspace';

declare global {
  interface Window {
    /** Read-only handle for automated end-to-end tests and debugging. */
    __pdfws?: { ctl: WorkspaceController; ui: typeof ui };
  }
}

// One engine, one session and one boot per page load (StrictMode runs effects twice).
let boot: { session: Session; opening: Promise<WorkspaceController> } | null = null;
function getBoot() {
  if (!boot) {
    const session = new Session(createWorkerEngine());
    boot = { session, opening: session.init().then(() => session.openInitial()) };
  }
  return boot;
}

export function App() {
  const session = getBoot().session;
  const [ctl, setCtl] = useState<WorkspaceController | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getBoot()
      .opening.then((c) => alive && setCtl((cur) => cur ?? c))
      .catch((err) => setBootError(String(err)));
    return () => {
      alive = false;
    };
  }, [session]);

  useEffect(() => {
    if (!ctl) return;
    setBlobReader((id) => ctl.blobs.get(id));
    setAnnotationBlobLoader((id) => ctl.blobs.get(id));
    window.__pdfws = { ctl, ui };
    if (!session.persistent) ctl.notify('error', 'This browser blocks local storage, so work is not saved automatically. Download your PDF before closing the tab.');
  }, [ctl, session]);

  const value = useMemo(
    () =>
      ctl && {
        ctl,
        session,
        switchTo(next: WorkspaceController) {
          ctl.dispose();
          ui.set({ selectedAnns: null, editDraft: null, pendingImage: null, dialog: null, tool: 'select', view: 'edit' });
          setCtl(next);
        },
      },
    [ctl, session],
  );

  if (bootError) return <Fatal message={bootError} />;
  if (!value) return <div className="boot">Opening your workspace…</div>;
  return (
    <AppContext.Provider value={value}>
      <ErrorBoundary>
        <Workspace key={value.ctl.state.id} />
      </ErrorBoundary>
    </AppContext.Provider>
  );
}

function Fatal({ message }: { message: string }) {
  return (
    <div className="fatal" role="alert">
      <h1>Something went wrong</h1>
      <p>The workspace could not start. Your saved work is still stored in this browser.</p>
      <code>{message}</code>
      <button type="button" className="btn btn-labelled btn-primary" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <Fatal message={this.state.error.message} />;
    return this.props.children;
  }
}
