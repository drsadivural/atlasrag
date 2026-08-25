import type { ReactNode } from 'react';
import { cn } from '@uxe/ui';

/** Consistent page title block: icon, title, subtitle, and a slot for page actions. */
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span
            aria-hidden
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--uxe-radius-card)] bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-[26px] leading-tight font-bold text-[var(--uxe-text)] sm:text-[30px]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 text-[14px] text-[var(--uxe-text-secondary)]">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
