import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Button, IconButton, cx } from './ui';

const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Focus handling shared by dialogs and drawers: focus in on open, restore on close, Tab stays inside. */
function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      el ? [...el.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')] : [];
    requestAnimationFrame(() => (el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? el)?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

export function Dialog({ open, onClose, title, children, footer, width = 460 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useFocusTrap(open, onClose);
  const id = useId();
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <motion.div className="absolute inset-0 bg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onClick={onClose} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={id}
            tabIndex={-1}
            style={{ width: `min(${width}px, 100%)` }}
            className="relative rounded-[var(--radius-panel)] bg-ink-1 shadow-[var(--shadow-pop)] focus:outline-none"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99, transition: { duration: 0.12 } }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <h2 id={id} className="text-md font-bold">
                {title}
              </h2>
              <IconButton icon={X} label="Close" onClick={onClose} size={32} />
            </header>
            <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
            {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, width = 520, labelledBy }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; width?: number; labelledBy?: string }) {
  const ref = useFocusTrap(open, onClose);
  const id = useId();
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40">
          <motion.div className="absolute inset-0 bg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
          <motion.aside
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy ?? (title ? id : undefined)}
            tabIndex={-1}
            style={{ width: `min(${width}px, 100vw)` }}
            className="absolute inset-y-0 right-0 flex flex-col bg-ink-1 shadow-[var(--shadow-pop)] focus:outline-none"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0, transition: { duration: 0.14 } }}
            transition={{ duration: 0.26, ease: EASE }}
          >
            {title && (
              <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
                <h2 id={id} className="text-md font-bold">
                  {title}
                </h2>
                <IconButton icon={X} label="Close" onClick={onClose} size={32} />
              </header>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * Confirmation for anything that spends chakra or changes the account. The summary comes
 * from the server's dry run, so what is shown is what the guard will execute.
 */
export function ConfirmDialog({
  open,
  title,
  summary,
  cost,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  summary: string | null;
  cost: number | null;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} busy={busy} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {summary ? <p className="text-washi">{summary}</p> : <p className="text-muted">Checking with Kyara…</p>}
      {cost !== null && cost > 0 && (
        <p className="mt-3 flex items-center gap-2 text-sm text-warn">
          <AlertTriangle size={15} aria-hidden /> This spends up to <span className="num font-bold">{cost.toLocaleString('en-US')}</span> chakra.
        </p>
      )}
      {children}
    </Dialog>
  );
}

type ToastKind = 'success' | 'info' | 'warn' | 'error';
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

const toastIcon = { success: CheckCircle2, info: Info, warn: AlertTriangle, error: XCircle };
const toastTone = { success: 'text-ok', info: 'text-focus', warn: 'text-warn', error: 'text-bad' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = ++seq.current;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.kind === 'error' || t.kind === 'warn' ? 9000 : 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div aria-live="polite" aria-relevant="additions" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const I = toastIcon[t.kind];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, transition: { duration: 0.14 } }}
                transition={{ duration: 0.22, ease: EASE }}
                className="pointer-events-auto flex items-start gap-3 rounded-[var(--radius-panel)] bg-ink-2 p-3 pr-2 shadow-[var(--shadow-pop)]"
                role={t.kind === 'error' ? 'alert' : 'status'}
              >
                <I size={18} className={cx('mt-0.5 shrink-0', toastTone[t.kind])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-washi">{t.title}</p>
                  {t.detail && <p className="mt-0.5 text-sm text-muted">{t.detail}</p>}
                </div>
                <IconButton icon={X} label="Dismiss" size={28} onClick={() => dismiss(t.id)} />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
