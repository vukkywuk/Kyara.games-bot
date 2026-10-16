import { motion } from 'motion/react';
import type { ButtonHTMLAttributes, ComponentType, ReactNode, SVGProps } from 'react';
import { forwardRef, useId } from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }>;

// ------------------------------------------------------------------ buttons

type Variant = 'primary' | 'quiet' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  // primary is paper on ink: colour stays reserved for rarity
  primary: 'bg-washi text-ink-0 hover:bg-washi-hi active:bg-washi-dim font-bold',
  quiet: 'border border-line bg-transparent text-washi hover:bg-ink-2 hover:border-line-strong',
  ghost: 'bg-transparent text-washi-dim hover:bg-ink-2 hover:text-washi',
  danger: 'border border-bad/50 bg-transparent text-bad hover:bg-bad/10',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: Icon;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'quiet', size = 'md', icon: I, busy, children, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-ctl)] transition-[background-color,border-color,color,opacity] duration-150 ease-out disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-base',
        variants[variant],
        className,
      )}
    >
      {busy ? <RotateCw size={15} className="animate-spin" aria-hidden /> : I ? <I size={16} aria-hidden /> : null}
      {children}
    </button>
  );
});

export function IconButton({ icon: I, label, className, size = 36, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { icon: Icon; label: string; size?: number }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cx('inline-grid place-items-center rounded-[var(--radius-ctl)] text-washi-dim transition-colors duration-150 hover:bg-ink-2 hover:text-washi', className)}
    >
      <I size={18} aria-hidden />
    </button>
  );
}

// ------------------------------------------------------------------ layout

export function Panel({ title, action, children, className, bodyClass, id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string }) {
  const hid = useId();
  return (
    <section aria-labelledby={title ? hid : undefined} id={id} className={cx('rounded-[var(--radius-panel)] bg-ink-1', className)}>
      {(title || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4">
          {title && (
            <h2 id={hid} className="text-md font-bold text-washi">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      <div className={cx('p-4', bodyClass)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight text-washi">{title}</h1>
        {description && <p className="mt-1 max-w-[70ch] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ states

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={cx('skeleton rounded-[var(--radius-ctl)]', className)} style={style} />;
}

export function EmptyState({ icon: I, title, children, action }: { icon?: Icon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {I && <I size={28} className="mb-3 text-faint" aria-hidden />}
      <p className="text-md font-bold text-washi">{title}</p>
      {children && <div className="mt-1 max-w-[52ch] text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry, compact }: { message: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div role="alert" className={cx('flex items-start gap-3 rounded-[var(--radius-ctl)] border border-bad/30 bg-bad/5 text-washi', compact ? 'p-3' : 'p-4')}>
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" icon={RotateCw} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'live';
const toneColor: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', idle: 'bg-faint', live: 'bg-ok' };

export function StatusDot({ tone, label }: { tone: Tone; label?: string }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {tone === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-40 motion-reduce:hidden" />}
      <span className={cx('relative h-2 w-2 rounded-full', toneColor[tone])} />
    </span>
  );
}

// ------------------------------------------------------------------ inputs

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm text-washi-dim">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'h-10 w-full rounded-[var(--radius-ctl)] border border-line bg-ink-2 px-3 text-washi placeholder:text-faint transition-colors duration-150 hover:border-line-strong focus:border-focus focus:outline-none';

export function Chip({ children, onRemove, removeLabel }: { children: ReactNode; onRemove: () => void; removeLabel: string }) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ duration: 0.16 }}
      className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-chip)] border border-line bg-ink-2 pl-2.5 pr-1 text-sm text-washi"
    >
      {children}
      <button type="button" onClick={onRemove} aria-label={removeLabel} className="grid h-5 w-5 place-items-center rounded-[2px] text-muted hover:bg-ink-3 hover:text-washi">
        <X size={13} aria-hidden />
      </button>
    </motion.span>
  );
}

/** Segmented control with a sliding indicator (transform only). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  layoutId,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  label: string;
  layoutId: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-[var(--radius-ctl)] bg-ink-2 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(o.value)}
            className={cx('relative h-8 rounded-[5px] px-3 text-sm transition-colors duration-150', active ? 'text-ink-0' : 'text-washi-dim hover:text-washi')}
          >
            {active && <motion.span layoutId={layoutId} className="absolute inset-0 rounded-[5px] bg-washi" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
            <span className="relative inline-flex items-center gap-1.5">
              {o.label}
              {o.count !== undefined && <span className={cx('num text-xs', active ? 'text-ink-3' : 'text-faint')}>{o.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Meter({ value, max, color = 'var(--color-washi)', label }: { value: number; max: number; color?: string; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="h-1.5 w-full overflow-hidden rounded-full bg-ink-3">
      <motion.div className="h-full origin-left rounded-full" style={{ background: color }} initial={{ scaleX: 0 }} animate={{ scaleX: pct / 100 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} />
    </div>
  );
}
