import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { FilePatch } from '@repomind/core';

// ------------------------------------------------------------------ icons (inline, no icon font)

const PATHS: Record<string, string> = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  repos: 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4zM4 16a4 4 0 0 1 4-4h12',
  explorer: 'M3 6h6l2 2h10v11H3zM3 6v13',
  brain: 'M12 5a3 3 0 1 0-5.9.8A3 3 0 0 0 4 11a3 3 0 0 0 2 5.2V17a3 3 0 0 0 6 0zM12 5a3 3 0 1 1 5.9.8A3 3 0 0 1 20 11a3 3 0 0 1-2 5.2V17a3 3 0 0 1-6 0z',
  context: 'M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3',
  workflow: 'M5 6h4v4H5zM15 6h4v4h-4zM10 15h4v4h-4zM9 8h6M7 10l5 5M17 10l-5 5',
  patch: 'M9 5H5v14h14v-4M14 4h6v6M20 4l-9 9',
  build: 'M14 7l3-3 3 3-3 3M17 4v8M4 20l7-7M9 9l6 6',
  memory: 'M6 3h12v18l-6-4-6 4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  folder: 'M3 6h6l2 2h10v11H3z',
  github: 'M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.7 11.7 0 0 0-6.2 0C6.6 2.8 5.6 3.1 5.6 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.2 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  warn: 'M12 3l10 18H2zM12 10v4M12 17v.5',
  tab: 'M3 5h18v14H3zM3 9h18'
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS['x']} />
    </svg>
  );
}

// ------------------------------------------------------------------ primitives

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', icon, children, small, busy, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: string; small?: boolean; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant}${small ? ' btn-sm' : ''} ${rest.className ?? ''}`} disabled={rest.disabled || busy}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={small ? 14 : 15} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'high' | 'bad' | 'info'; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function RiskBadge({ level }: { level: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' }) {
  const tone = level === 'LOW' ? 'ok' : level === 'MODERATE' ? 'warn' : level === 'HIGH' ? 'high' : 'bad';
  return <Badge tone={tone}>{level}</Badge>;
}

export function SeverityBadge({ s }: { s: 'info' | 'low' | 'medium' | 'high' | 'error' | 'warning' }) {
  const tone = s === 'high' || s === 'error' ? 'bad' : s === 'medium' || s === 'warning' ? 'warn' : s === 'low' ? 'info' : 'neutral';
  return <Badge tone={tone}>{s}</Badge>;
}

export function Card({ title, actions, children, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="row gap-xs">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={o.id === value} className={`tab ${o.id === value ? 'active' : ''}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={`progress ${pct > 100 ? 'over' : ''}`} role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div style={{ width: `${pct}%` }} className={value > max ? 'over' : ''} />
    </div>
  );
}

export function Modal({ title, children, onClose, footer, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function CodeBlock({ code, maxHeight = 360, lineNumbers = true, highlightLine }: { code: string; maxHeight?: number; lineNumbers?: boolean; highlightLine?: number }) {
  const lines = code.split('\n');
  const shown = lines.length > 4000 ? lines.slice(0, 4000) : lines;
  return (
    <pre className="code" style={{ maxHeight }}>
      {shown.map((l, i) => (
        <div key={i} className={`code-line ${highlightLine === i + 1 ? 'hl' : ''}`}>
          {lineNumbers && <span className="ln">{i + 1}</span>}
          <span className="lc">{l || ' '}</span>
        </div>
      ))}
      {lines.length > shown.length && <div className="muted small">… {lines.length - shown.length} more lines</div>}
    </pre>
  );
}

export function DiffView({ file }: { file: FilePatch }) {
  return (
    <div className="diff">
      {file.hunks.map((h, i) => {
        let o = h.oldStart;
        let n = h.newStart;
        return (
          <div key={i} className="hunk">
            <div className="hunk-head">
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@ {h.section}
              {h.recounted && <Badge tone="warn">counts fixed</Badge>}
            </div>
            {h.lines.map((l, k) => {
              const on = l.type === '+' ? '' : String(o++);
              const nn = l.type === '-' ? '' : String(n++);
              return (
                <div key={k} className={`dl dl-${l.type === '+' ? 'add' : l.type === '-' ? 'del' : 'ctx'}`}>
                  <span className="ln">{on}</span>
                  <span className="ln">{nn}</span>
                  <span className="sign">{l.type}</span>
                  <span className="lc">{l.text || ' '}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {file.hunks.length === 0 && <div className="muted small pad">No textual hunks.</div>}
    </div>
  );
}

export function Confirm({ title, children, confirmLabel, danger, onConfirm, onCancel }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea spellCheck={false} {...props} className={`input textarea ${props.className ?? ''}`} />;
}
