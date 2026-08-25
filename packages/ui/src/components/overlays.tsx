import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../utils.js';
import { Button } from './primitives.js';

/* -------------------------------------------------------------------------- */
/* Dialog                                                                     */
/* -------------------------------------------------------------------------- */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** On mobile a slide-over reads better than a centred box for long content. */
  variant?: 'center' | 'sheet';
}

const DIALOG_WIDTHS = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[calc(100vw-2rem)]',
} as const;

/**
 * Modal dialog.
 *
 * Radix owns focus trapping, restore-on-close, Escape handling and the `aria-modal`
 * semantics, so those are correct rather than approximated. What is added here is the
 * product's own shape: a visible title bound with `aria-labelledby`, and a full-screen
 * sheet on small viewports where a centred box would be unusable.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  variant = 'center',
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-[rgba(16,22,47,0.45)] backdrop-blur-[2px]',
            'data-[state=open]:animate-[uxe-fade-in_var(--uxe-duration)_var(--uxe-ease)]',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed z-50 flex flex-col border border-[var(--uxe-border)] bg-[var(--uxe-surface)]',
            'shadow-[var(--uxe-shadow-xl)] focus:outline-none',
            'data-[state=open]:animate-[uxe-fade-in_var(--uxe-duration)_var(--uxe-ease)]',
            variant === 'sheet'
              ? 'inset-x-0 top-auto bottom-0 max-h-[92vh] rounded-t-[var(--uxe-radius-card-lg)] sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[85vh] sm:w-full sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--uxe-radius-card-lg)]'
              : 'inset-x-4 top-1/2 max-h-[85vh] -translate-y-1/2 rounded-[var(--uxe-radius-card-lg)] sm:right-auto sm:left-1/2 sm:w-full sm:-translate-x-1/2',
            variant === 'center' && 'sm:mx-0',
            DIALOG_WIDTHS[size],
            size !== 'full' && 'sm:mx-auto',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--uxe-border)] p-5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[17px] font-semibold text-[var(--uxe-text)]">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-[13px] text-[var(--uxe-text-secondary)]">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close dialog">
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>

          {footer && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--uxe-border)] p-4">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  /** Typing this exact word is required before a destructive action can proceed. */
  confirmWord?: string;
  onConfirm: () => void;
}

/**
 * Confirmation for irreversible actions.
 *
 * When `confirmWord` is set the confirm button stays disabled until the user types it,
 * which prevents a bulk delete from being one stray Enter key away.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  loading,
  confirmWord,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const canConfirm = !confirmWord || typed.trim().toUpperCase() === confirmWord.toUpperCase();

  // Clear the typed confirmation as the dialog closes, during render rather than in an
  // effect: the word must never survive into the next thing the user is asked to confirm.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setTyped('');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={!canConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmWord && (
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[var(--uxe-text)]">
          Type <span className="font-[family-name:var(--uxe-font-mono)]">{confirmWord}</span> to
          confirm
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-10 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)] bg-[var(--uxe-surface)] px-3 text-[14px]"
            aria-label={`Type ${confirmWord} to confirm`}
          />
        </label>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Slide-over panel                                                           */
/* -------------------------------------------------------------------------- */

export function SlideOver({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
}: Omit<DialogProps, 'size' | 'variant'> & { width?: 'sm' | 'md' | 'lg' }) {
  const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-2xl' } as const;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgba(16,22,47,0.45)] backdrop-blur-[2px] data-[state=open]:animate-[uxe-fade-in_var(--uxe-duration)_var(--uxe-ease)]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-[var(--uxe-border)]',
            'bg-[var(--uxe-surface)] shadow-[var(--uxe-shadow-xl)] focus:outline-none',
            'data-[state=open]:animate-[uxe-slide-in-right_var(--uxe-duration-slow)_var(--uxe-ease)]',
            widths[width],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--uxe-border)] p-5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-[16px] font-semibold text-[var(--uxe-text)]">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-[13px] text-[var(--uxe-text-secondary)]">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close panel">
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-[var(--uxe-border)] p-4">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                    */
/* -------------------------------------------------------------------------- */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={200}>{children}</TooltipPrimitive.Provider>;
}

/**
 * Tooltip.
 *
 * Radix opens it on focus as well as hover, so the content is reachable by keyboard. It is
 * never the only place information lives: anything essential also appears in the DOM.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-50 max-w-xs rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)]',
            'bg-[var(--uxe-surface-raised)] px-3 py-2 text-[12px] leading-relaxed text-[var(--uxe-text)]',
            'shadow-[var(--uxe-shadow-lg)]',
            'data-[state=delayed-open]:animate-[uxe-fade-in_var(--uxe-duration-fast)_var(--uxe-ease)]',
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-[var(--uxe-surface-raised)]" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Dropdown menu                                                              */
/* -------------------------------------------------------------------------- */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Shown as the reason when disabled, so a dead-looking control explains itself. */
  disabledReason?: string;
  separatorBefore?: boolean;
}

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  label,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
  label: string;
}) {
  return (
    <DropdownPrimitive.Root>
      {/*
        The label names the MENU, not the trigger. Putting it on the trigger would override
        the name the trigger already has from its own content — the workspace switcher
        would announce "Workspace" instead of the workspace the user is actually in.
      */}
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content
          aria-label={label}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-50 min-w-52 overflow-hidden rounded-[var(--uxe-radius-control-lg)]',
            'border border-[var(--uxe-border)] bg-[var(--uxe-surface-raised)] p-1.5',
            'shadow-[var(--uxe-shadow-lg)]',
            'data-[state=open]:animate-[uxe-fade-in_var(--uxe-duration-fast)_var(--uxe-ease)]',
          )}
        >
          {items.map((item, index) => (
            <div key={`${item.label}-${index}`}>
              {item.separatorBefore && (
                <DropdownPrimitive.Separator className="my-1.5 h-px bg-[var(--uxe-border)]" />
              )}
              <DropdownPrimitive.Item
                disabled={item.disabled}
                onSelect={item.onSelect}
                title={item.disabled ? item.disabledReason : undefined}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-[var(--uxe-radius-control)] px-2.5 py-2',
                  'text-[13px] font-medium outline-none',
                  'data-[highlighted]:bg-[var(--uxe-surface-hover)]',
                  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  item.destructive
                    ? 'text-[var(--uxe-danger-text)] data-[highlighted]:bg-[var(--uxe-danger-bg)]'
                    : 'text-[var(--uxe-text)]',
                )}
              >
                {item.icon && (
                  <span aria-hidden className="flex shrink-0">
                    {item.icon}
                  </span>
                )}
                {item.label}
              </DropdownPrimitive.Item>
            </div>
          ))}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

export interface Toast {
  id: string;
  tone: 'success' | 'error' | 'info' | 'warning';
  title: string;
  description?: string;
  /** Rendered inside the toast, e.g. an inline "Retry" or "Undo". */
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);

      // Errors persist until dismissed: auto-hiding a failure the user has not read is how
      // problems get missed.
      const duration = toast.durationMs ?? (toast.tone === 'error' ? 0 : 5000);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}

const TOAST_TONES = {
  success:
    'border-[var(--uxe-success-border)] bg-[var(--uxe-success-bg)] text-[var(--uxe-success-text)]',
  error:
    'border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] text-[var(--uxe-danger-text)]',
  info: 'border-[var(--uxe-info-border)] bg-[var(--uxe-info-bg)] text-[var(--uxe-info-text)]',
  warning:
    'border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)] text-[var(--uxe-warning-text)]',
} as const;

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      // `assertive` so an error interrupts; the container sits above the mobile bottom nav.
      aria-live="assertive"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--uxe-bottom-nav-height)+1rem)] z-[60] flex flex-col items-center gap-2 px-4 sm:right-6 sm:bottom-6 sm:left-auto sm:items-end"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[var(--uxe-radius-card)] border p-3.5',
            'animate-[uxe-fade-in_var(--uxe-duration)_var(--uxe-ease)] shadow-[var(--uxe-shadow-lg)]',
            TOAST_TONES[toast.tone],
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold">{toast.title}</p>
            {toast.description && (
              <p className="mt-0.5 text-[13px] text-[var(--uxe-text)]">{toast.description}</p>
            )}
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action?.onClick();
                  onDismiss(toast.id);
                }}
                className="mt-2 text-[13px] font-semibold underline underline-offset-2"
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label={`Dismiss: ${toast.title}`}
            className="rounded p-0.5 text-[var(--uxe-text-secondary)] hover:text-[var(--uxe-text)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

export { DialogPrimitive };
