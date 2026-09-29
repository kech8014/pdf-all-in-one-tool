import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceController, WorkspaceView } from '../store/controller';
import type { Session } from '../store/session';
import { Icon, toneClass, type IconName } from './Icon';

/* --------------------------------- context -------------------------------- */

export interface AppCtx {
  ctl: WorkspaceController;
  session: Session;
  switchTo(ctl: WorkspaceController): void;
}
export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext missing');
  return c;
}

export function useView(): WorkspaceView {
  const { ctl } = useApp();
  return useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
}

/* --------------------------------- buttons -------------------------------- */

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  shortcut,
  showLabel,
  variant,
  testId,
  className,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  shortcut?: string;
  showLabel?: boolean;
  variant?: 'primary' | 'danger' | 'ghost';
  testId?: string;
  className?: string;
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      className={`btn ${showLabel ? 'btn-labelled' : 'btn-icon'} ${variant ? `btn-${variant}` : toneClass(icon)} ${active ? 'is-active' : ''} ${className ?? ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-testid={testId}
    >
      <Icon name={icon} size={20} />
      {showLabel && <span>{label}</span>}
    </button>
  );
}

/* --------------------------------- dialog --------------------------------- */

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 560,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Parents pass a new onClose on every render; keep the latest in a ref so the focus
  // setup below runs ONCE when the dialog opens. (Re-running it on each keystroke moved
  // the cursor out of the field being typed in.)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const first =
      root?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ??
      root?.querySelector<HTMLElement>('.modal-body input:not([type="hidden"]), .modal-body textarea, .modal-body select') ??
      root?.querySelector<HTMLElement>('.modal-foot button, .modal-body button') ??
      root?.querySelector<HTMLElement>('button');
    first?.focus();
    if (first instanceof HTMLInputElement && first.type === 'text') first.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref} data-testid={testId}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------- menu ---------------------------------- */

export interface MenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  testId?: string;
}
export type MenuEntry = MenuItem | 'divider';

/** Dropdown/context menu rendered in a portal at a screen position. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    el.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div className="menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it === 'divider' ? (
          <div key={i} className="menu-divider" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${it.danger ? 'is-danger' : ''}`}
            disabled={it.disabled}
            data-testid={it.testId}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon ? (
              <span className={`menu-icon ${it.danger ? 'tone tone-red' : toneClass(it.icon)}`}>
                <Icon name={it.icon} size={17} />
              </span>
            ) : (
              <span className="menu-icon-pad" />
            )}
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** A button that opens a dropdown menu underneath itself. */
export function MenuButton({ icon, label, items, showLabel = true, testId, variant }: { icon: IconName; label: string; items: MenuEntry[]; showLabel?: boolean; testId?: string; variant?: 'primary' }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`btn ${showLabel ? 'btn-labelled' : 'btn-icon'} ${variant ? `btn-${variant}` : toneClass(icon)} ${open ? 'is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!open}
        title={label}
        aria-label={label}
        data-testid={testId}
        onClick={() => {
          const r = ref.current!.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <Icon name={icon} size={20} />
        {showLabel && <span>{label}</span>}
        <Icon name="chevronDown" size={14} />
      </button>
      {open && <Menu x={open.x} y={open.y} items={items} onClose={() => setOpen(null)} />}
    </>
  );
}

/* --------------------------------- colours -------------------------------- */

export function ColorPicker({
  value,
  onChange,
  presets,
  allowNone,
  label,
  testId,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  presets: readonly { name: string; value: string }[];
  allowNone?: boolean;
  label: string;
  testId?: string;
}) {
  return (
    <div className="color-picker" role="group" aria-label={label} data-testid={testId}>
      {allowNone && (
        <button
          type="button"
          className={`swatch swatch-none ${value === null ? 'is-active' : ''}`}
          title="None"
          aria-label="No colour"
          onClick={() => onChange(null)}
        />
      )}
      {presets.map((c) => (
        <button
          key={c.value}
          type="button"
          className={`swatch ${value?.toLowerCase() === c.value ? 'is-active' : ''}`}
          style={{ background: c.value }}
          title={c.name}
          aria-label={c.name}
          data-color={c.name.toLowerCase()}
          onClick={() => onChange(c.value)}
        />
      ))}
      <label className="swatch swatch-custom" title="Custom colour">
        <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} aria-label={`Custom ${label.toLowerCase()}`} />
      </label>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  testId?: string;
}) {
  return (
    <label className="slider" title={label}>
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} data-testid={testId} />
      <span className="slider-value">{format ? format(value) : value}</span>
    </label>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
export const MOD = isMac() ? '⌘' : 'Ctrl';
