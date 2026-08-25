import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Loader2 } from 'lucide-react';
import { avatarTint, cn, initials as initialsOf } from '../utils.js';

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold',
    'transition-[background-color,box-shadow,transform,color] duration-[var(--uxe-duration)]',
    'ease-[var(--uxe-ease)] disabled:pointer-events-none disabled:opacity-55',
    // 44px minimum touch target on coarse pointers, per WCAG 2.2 target size.
    'active:translate-y-px [@media(pointer:coarse)]:min-h-11',
  ),
  {
    variants: {
      variant: {
        primary:
          'text-[var(--uxe-text-on-brand)] shadow-[var(--uxe-shadow-brand)] [background-image:var(--uxe-gradient)] hover:brightness-[1.06]',
        secondary:
          'border border-[var(--uxe-border)] bg-[var(--uxe-surface)] text-[var(--uxe-text)] shadow-[var(--uxe-shadow-xs)] hover:bg-[var(--uxe-surface-hover)]',
        ghost: 'text-[var(--uxe-text-secondary)] hover:bg-[var(--uxe-surface-hover)] hover:text-[var(--uxe-text)]',
        danger: 'bg-[var(--uxe-danger)] text-white hover:brightness-105',
        success: 'bg-[var(--uxe-success)] text-white hover:brightness-105',
        outline:
          'border border-[var(--uxe-cobalt)] bg-transparent text-[var(--uxe-cobalt)] hover:bg-[var(--uxe-surface-selected)]',
        link: 'text-[var(--uxe-cobalt)] underline-offset-4 hover:underline',
      },
      size: {
        // Control text never drops below 13px.
        xs: 'h-8 rounded-[var(--uxe-radius-control)] px-2.5 text-[13px]',
        sm: 'h-9 rounded-[var(--uxe-radius-control)] px-3 text-[13px]',
        md: 'h-10 rounded-[var(--uxe-radius-control)] px-4 text-[14px]',
        lg: 'h-11 rounded-[var(--uxe-radius-control-lg)] px-5 text-[15px]',
        xl: 'h-12 rounded-[var(--uxe-radius-control-lg)] px-6 text-[15px]',
        icon: 'h-10 w-10 rounded-[var(--uxe-radius-control)]',
        'icon-sm': 'h-8 w-8 rounded-[var(--uxe-radius-control)]',
      },
      full: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', full: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  /** Announced to screen readers while `loading` is true. */
  loadingLabel?: string;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, full, asChild, loading, loadingLabel, iconLeft, iconRight, children, disabled, ...props },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size, full }), className);

  /**
   * `asChild` merges the button's styling onto the caller's own element, typically a
   * router Link. Radix's Slot requires EXACTLY ONE React element child, so the icon and
   * spinner slots are not rendered in this branch — they would become extra siblings and
   * crash the whole subtree at runtime. Callers using `asChild` put their own icons inside
   * the child element.
   */
  if (asChild) {
    return (
      <Slot ref={ref} className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 aria-hidden className="h-4 w-4 animate-[uxe-spin_0.8s_linear_infinite]" />
          <span className="sr-only">{loadingLabel ?? 'Working'}</span>
        </>
      ) : (
        iconLeft
      )}
      {children}
      {!loading && iconRight}
    </button>
  );
});

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { flush?: boolean }>(
  function Card({ className, flush, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)]',
          'bg-[var(--uxe-surface)] shadow-[var(--uxe-shadow-sm)]',
          !flush && 'p-5',
          className,
        )}
        {...props}
      />
    );
  },
);

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex items-start justify-between gap-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-[16px] font-semibold text-[var(--uxe-text)]', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-[13px] text-[var(--uxe-text-secondary)]', className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Field + Input                                                              */
/* -------------------------------------------------------------------------- */

export interface FieldProps {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  hint?: string | undefined;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Label, control, hint and error as one unit.
 *
 * The error is rendered in an `aria-live` region and linked through `aria-describedby` by
 * the input itself, so a validation failure is announced rather than only being visible.
 */
export function Field({ label, htmlFor, error, hint, required, children, className }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="text-[13px] font-medium text-[var(--uxe-text)]"
      >
        {label}
        {required && (
          <span className="ml-0.5 text-[var(--uxe-danger)]" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p className="text-[12px] text-[var(--uxe-text-secondary)]">{hint}</p>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1 text-[12px] font-medium text-[var(--uxe-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, iconLeft, iconRight, ...props },
  ref,
) {
  return (
    <div className="relative flex items-center">
      {iconLeft && (
        <span aria-hidden className="pointer-events-none absolute left-3 flex text-[var(--uxe-text-tertiary)]">
          {iconLeft}
        </span>
      )}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-11 w-full rounded-[var(--uxe-radius-control)] border bg-[var(--uxe-surface)]',
          'text-[14px] text-[var(--uxe-text)] shadow-[var(--uxe-shadow-xs)]',
          'placeholder:text-[var(--uxe-text-tertiary)]',
          'transition-[border-color,box-shadow] duration-[var(--uxe-duration-fast)]',
          'focus:border-[var(--uxe-border-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--uxe-cobalt)]/25',
          'disabled:cursor-not-allowed disabled:bg-[var(--uxe-surface-sunken)] disabled:opacity-70',
          // Longhand on both sides rather than `px-3` plus an override: Tailwind emits the
          // shorthand after the longhand, so `px-3` would win and the icon would sit on
          // top of the text.
          iconLeft ? 'pl-10' : 'pl-3',
          iconRight ? 'pr-10' : 'pr-3',
          invalid
            ? 'border-[var(--uxe-danger)] focus:border-[var(--uxe-danger)] focus:ring-[var(--uxe-danger)]/25'
            : 'border-[var(--uxe-border)]',
          className,
        )}
        {...props}
      />
      {iconRight && <span className="absolute right-2 flex items-center">{iconRight}</span>}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className, invalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'w-full rounded-[var(--uxe-radius-control)] border bg-[var(--uxe-surface)] p-3',
          'text-[14px] leading-relaxed text-[var(--uxe-text)] shadow-[var(--uxe-shadow-xs)]',
          'placeholder:text-[var(--uxe-text-tertiary)]',
          'focus:border-[var(--uxe-border-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--uxe-cobalt)]/25',
          invalid ? 'border-[var(--uxe-danger)]' : 'border-[var(--uxe-border)]',
          className,
        )}
        {...props}
      />
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-[var(--uxe-radius-pill)] font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-[var(--uxe-neutral-bg)] text-[var(--uxe-text-secondary)]',
        brand: 'bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]',
        success: 'bg-[var(--uxe-success-bg)] text-[var(--uxe-success)]',
        warning: 'bg-[var(--uxe-warning-bg)] text-[var(--uxe-warning)]',
        danger: 'bg-[var(--uxe-danger-bg)] text-[var(--uxe-danger)]',
        info: 'bg-[var(--uxe-info-bg)] text-[var(--uxe-info)]',
        teal: 'bg-[var(--uxe-teal-bg)] text-[var(--uxe-teal)]',
      },
      size: {
        sm: 'px-2 py-0.5 text-[11px]',
        md: 'px-2.5 py-1 text-[12px]',
        lg: 'px-3 py-1.5 text-[13px]',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /**
   * Icon shown alongside the label. Status is never conveyed by colour alone, so every
   * status badge in the app passes one.
   */
  icon?: ReactNode;
}

export function Badge({ className, tone, size, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {icon && <span aria-hidden className="flex shrink-0">{icon}</span>}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-[var(--uxe-radius-control)]',
        'bg-[linear-gradient(90deg,var(--uxe-surface-sunken)_25%,var(--uxe-surface-hover)_50%,var(--uxe-surface-sunken)_75%)]',
        'bg-[length:200%_100%] animate-[uxe-shimmer_1.6s_ease-in-out_infinite]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Wraps a loading region so assistive technology is told content is arriving, rather than
 * encountering a silent block of shimmering rectangles.
 */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty / error states                                                       */
/* -------------------------------------------------------------------------- */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, secondaryAction, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div
          aria-hidden
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-[var(--uxe-radius-card)] bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]"
        >
          {icon}
        </div>
      )}
      <h3 className="text-[16px] font-semibold text-[var(--uxe-text)]">{title}</h3>
      <p className="mt-1.5 max-w-md text-[14px] text-[var(--uxe-text-secondary)]">{description}</p>
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  traceId?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

/**
 * The single failure surface.
 *
 * Always shows a Retry when the caller supplies one, and always shows the trace reference
 * when there is one — a user reporting a problem can then quote something the operator can
 * actually look up.
 */
export function ErrorState({ title, message, traceId, onRetry, retrying, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--uxe-radius-card)]',
        'border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] px-6 py-10 text-center',
        className,
      )}
    >
      <h3 className="text-[15px] font-semibold text-[var(--uxe-danger)]">
        {title ?? 'Something went wrong'}
      </h3>
      <p className="mt-1.5 max-w-lg text-[14px] text-[var(--uxe-text)]">{message}</p>
      {traceId && (
        <p className="mt-2 font-[family-name:var(--uxe-font-mono)] text-[11px] text-[var(--uxe-text-secondary)]">
          Reference: {traceId}
        </p>
      )}
      {onRetry && (
        <Button className="mt-4" variant="secondary" size="sm" onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

export function ProgressBar({
  value,
  label,
  tone = 'brand',
  className,
}: {
  value: number;
  label?: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const fill = {
    brand: '[background-image:var(--uxe-gradient)]',
    success: 'bg-[var(--uxe-success)]',
    warning: 'bg-[var(--uxe-warning)]',
    danger: 'bg-[var(--uxe-danger)]',
  }[tone];

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-[var(--uxe-surface-sunken)]', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-[var(--uxe-duration-slow)] ease-[var(--uxe-ease)]', fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/**
 * Circular gauge used for evidence coverage and knowledge health.
 *
 * The numeric value is rendered as text inside the ring, so the figure is readable without
 * interpreting the arc, and the whole component carries an accessible label.
 */
export function Gauge({
  value,
  size = 96,
  strokeWidth = 10,
  label,
  tone = 'brand',
  children,
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  label: string;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  children?: ReactNode;
}) {
  const gradientId = useId();
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  const stroke =
    tone === 'brand'
      ? `url(#${gradientId})`
      : tone === 'success'
        ? 'var(--uxe-success)'
        : tone === 'warning'
          ? 'var(--uxe-warning)'
          : 'var(--uxe-danger)';

  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label}: ${Math.round(clamped)}%`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--uxe-cobalt)" />
            <stop offset="100%" stopColor="var(--uxe-violet)" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--uxe-surface-sunken)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-[var(--uxe-duration-slow)] ease-[var(--uxe-ease)]"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children ?? (
          <span className="text-[18px] font-bold text-[var(--uxe-text)]">{Math.round(clamped)}%</span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Avatar                                                                     */
/* -------------------------------------------------------------------------- */

export function Avatar({
  name,
  src,
  size = 32,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  return src ? (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className={cn('shrink-0 rounded-full object-cover', className)}
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, background: avatarTint(name), fontSize: size * 0.38 }}
    >
      {initialsOf(name)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

export function Divider({ className, ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr className={cn('border-0 border-t border-[var(--uxe-border)]', className)} {...props} />;
}

/** Visually hidden but reachable by screen readers and keyboard focus. */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

/** Skip link: the first tab stop on every page, per WCAG 2.4.1. */
export function SkipLink({ href = '#main', children }: { href?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={cn(
        'sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100]',
        'focus:rounded-[var(--uxe-radius-control)] focus:bg-[var(--uxe-surface)] focus:px-4 focus:py-2',
        'focus:text-[14px] focus:font-semibold focus:shadow-[var(--uxe-shadow-lg)]',
      )}
    >
      {children}
    </a>
  );
}

export { buttonVariants, badgeVariants };
