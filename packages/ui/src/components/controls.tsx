import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { forwardRef, useId, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../utils.js';

/* -------------------------------------------------------------------------- */
/* Switch                                                                     */
/* -------------------------------------------------------------------------- */

export interface SwitchFieldProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Explains why the control is disabled instead of leaving it inert and unexplained. */
  disabledReason?: string;
  className?: string;
}

export function SwitchField({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  disabledReason,
  className,
}: SwitchFieldProps) {
  const id = useId();
  const descriptionId = `${id}-description`;

  return (
    <div className={cn('flex items-start justify-between gap-4 py-2', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-[var(--uxe-text)]">
          {label}
        </label>
        {(description || (disabled && disabledReason)) && (
          <p id={descriptionId} className="mt-0.5 text-[12px] text-[var(--uxe-text-secondary)]">
            {disabled && disabledReason ? disabledReason : description}
          </p>
        )}
      </div>
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description || disabledReason ? descriptionId : undefined}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full border-2 border-transparent',
          'transition-colors duration-[var(--uxe-duration)] ease-[var(--uxe-ease)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uxe-cobalt)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=unchecked]:bg-[var(--uxe-border-strong)]',
          'data-[state=checked]:[background-image:var(--uxe-gradient)]',
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'block h-5 w-5 rounded-full bg-white shadow-[var(--uxe-shadow-sm)]',
            'transition-transform duration-[var(--uxe-duration)] ease-[var(--uxe-ease)]',
            'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
          )}
        />
      </SwitchPrimitive.Root>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Checkbox                                                                   */
/* -------------------------------------------------------------------------- */

export interface CheckboxProps {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  label?: string;
  /** Required when no visible label is rendered, e.g. a row-selection checkbox. */
  ariaLabel?: string;
  /** Supplied when an outer <label htmlFor> owns the visible text. */
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  ariaLabel,
  id: providedId,
  disabled,
  className,
}: CheckboxProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border',
          'transition-colors duration-[var(--uxe-duration-fast)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uxe-cobalt)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=unchecked]:border-[var(--uxe-border-strong)] data-[state=unchecked]:bg-[var(--uxe-surface)]',
          'data-[state=checked]:border-[var(--uxe-cobalt)] data-[state=checked]:bg-[var(--uxe-cobalt)]',
          'data-[state=indeterminate]:border-[var(--uxe-cobalt)] data-[state=indeterminate]:bg-[var(--uxe-cobalt)]',
        )}
      >
        <CheckboxPrimitive.Indicator className="text-white">
          {checked === 'indeterminate' ? (
            <Minus className="h-3 w-3" strokeWidth={3} aria-hidden />
          ) : (
            <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label && (
        <label htmlFor={id} className="cursor-pointer text-[14px] text-[var(--uxe-text)]">
          {label}
        </label>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Select                                                                     */
/* -------------------------------------------------------------------------- */

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  ariaLabel,
  disabled,
  className,
  size = 'md',
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center justify-between gap-2 rounded-[var(--uxe-radius-control)]',
          'border border-[var(--uxe-border)] bg-[var(--uxe-surface)] text-[var(--uxe-text)]',
          'shadow-[var(--uxe-shadow-xs)] transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uxe-cobalt)]/30',
          'disabled:cursor-not-allowed disabled:opacity-60',
          size === 'sm' ? 'h-9 px-3 text-[13px]' : 'h-10 px-3.5 text-[14px]',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 text-[var(--uxe-text-secondary)]" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className={cn(
            'z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden',
            'rounded-[var(--uxe-radius-control-lg)] border border-[var(--uxe-border)]',
            'bg-[var(--uxe-surface-raised)] p-1.5 shadow-[var(--uxe-shadow-lg)]',
          )}
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-[var(--uxe-radius-control)] select-none',
                  'px-2.5 py-2 text-[13px] outline-none',
                  'data-[highlighted]:bg-[var(--uxe-surface-hover)]',
                  'data-[state=checked]:bg-[var(--uxe-surface-selected)] data-[state=checked]:text-[var(--uxe-cobalt)]',
                  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                )}
              >
                <SelectPrimitive.ItemIndicator className="mt-0.5">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                </SelectPrimitive.ItemIndicator>
                <span className={cn('min-w-0', !option.description && 'data-[state=checked]:ml-0')}>
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  {option.description && (
                    <span className="mt-0.5 block text-[12px] text-[var(--uxe-text-secondary)]">
                      {option.description}
                    </span>
                  )}
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Segmented control                                                          */
/* -------------------------------------------------------------------------- */

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Shown in a tooltip and as the accessible description. */
  hint?: string;
}

/**
 * Single-select segmented control, used for the answer-style switch and mobile result modes.
 *
 * Built on a radio-style toggle group so arrow keys move between options and the selected
 * value is announced — a row of buttons would give neither.
 */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  ariaLabel,
  size = 'md',
  full,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentedOption[];
  ariaLabel: string;
  size?: 'sm' | 'md';
  full?: boolean;
  className?: string;
}) {
  // The group renders as a radiogroup, and in a radiogroup an arrow key is expected to
  // move the selection, not only the focus. Radix moves focus; this moves the value with
  // it, so the two never drift apart.
  const step = (delta: number) => {
    const index = options.findIndex((option) => option.value === value);
    if (index === -1) return;
    const next = options[(index + delta + options.length) % options.length];
    if (next && next.value !== value) onValueChange(next.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        step(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        step(-1);
        break;
      case 'Home':
        if (options[0]) onValueChange(options[0].value);
        break;
      case 'End': {
        const last = options.at(-1);
        if (last) onValueChange(last.value);
        break;
      }
      default:
        break;
    }
  };

  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      // Radix emits '' when the active item is re-clicked; ignoring that keeps one option
      // always selected, which is what a segmented control means.
      onValueChange={(next) => next && onValueChange(next)}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--uxe-radius-control-lg)]',
        'border border-[var(--uxe-border)] bg-[var(--uxe-surface-sunken)] p-1',
        full && 'w-full',
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          title={option.hint}
          className={cn(
            // `min-w-0` lets a segment shrink below its content width; the label itself
            // carries the truncation, because `truncate` on a flex container has no
            // effect on a child element's text.
            'inline-flex min-w-0 items-center justify-center gap-1.5',
            // Equal widths only when the control fills its container. On an inline
            // control, `flex-1` sizes every segment to the narrowest one and truncates
            // the longest label even with the whole row to spare.
            full && 'flex-1',
            'rounded-[var(--uxe-radius-control)] font-semibold transition-all',
            'duration-[var(--uxe-duration)] ease-[var(--uxe-ease)]',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--uxe-cobalt)]',
            size === 'sm' ? 'h-8 px-2 text-[12.5px]' : 'h-9 px-3.5 text-[13px]',
            'data-[state=off]:text-[var(--uxe-text-secondary)] data-[state=off]:hover:bg-[var(--uxe-surface-hover)]',
            'data-[state=on]:bg-[var(--uxe-cobalt)] data-[state=on]:text-white data-[state=on]:shadow-[var(--uxe-shadow-sm)]',
          )}
        >
          {option.icon && (
            <span aria-hidden className="flex shrink-0">
              {option.icon}
            </span>
          )}
          <span className="truncate">{option.label}</span>
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className}>
      {children}
    </TabsPrimitive.Root>
  );
}

export function TabList({
  children,
  ariaLabel,
  className,
}: {
  children: ReactNode;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <TabsPrimitive.List
      aria-label={ariaLabel}
      className={cn(
        'flex items-center gap-1 overflow-x-auto border-b border-[var(--uxe-border)]',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

export function Tab({
  value,
  children,
  count,
}: {
  value: string;
  children: ReactNode;
  count?: number;
}) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        'relative flex shrink-0 items-center gap-2 px-3.5 py-2.5 whitespace-nowrap',
        'text-[13px] font-semibold transition-colors duration-[var(--uxe-duration-fast)]',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--uxe-cobalt)]',
        'data-[state=inactive]:text-[var(--uxe-text-secondary)] data-[state=inactive]:hover:text-[var(--uxe-text)]',
        'data-[state=active]:text-[var(--uxe-cobalt)]',
        'after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:rounded-full',
        'data-[state=active]:after:bg-[var(--uxe-cobalt)]',
      )}
    >
      {children}
      {count !== undefined && (
        <span className="rounded-[var(--uxe-radius-pill)] bg-[var(--uxe-neutral-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--uxe-text-secondary)]">
          {count}
        </span>
      )}
    </TabsPrimitive.Trigger>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Content
      value={value}
      className={cn('focus-visible:outline-2 focus-visible:outline-[var(--uxe-cobalt)]', className)}
    >
      {children}
    </TabsPrimitive.Content>
  );
}

/* -------------------------------------------------------------------------- */
/* Filter chips                                                               */
/* -------------------------------------------------------------------------- */

export interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  /** Small coloured dot; paired with the label so status is never colour-only. */
  dotColor?: string;
}

export const FilterChip = forwardRef<HTMLButtonElement, FilterChipProps>(function FilterChip(
  { active, onClick, label, count, dotColor },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-[var(--uxe-radius-control)] border px-3 py-1.5',
        'text-[13px] font-medium transition-colors duration-[var(--uxe-duration-fast)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uxe-cobalt)]',
        active
          ? 'border-[var(--uxe-cobalt)] bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]'
          : 'border-[var(--uxe-border)] bg-[var(--uxe-surface)] text-[var(--uxe-text-secondary)] hover:bg-[var(--uxe-surface-hover)]',
      )}
    >
      {dotColor && (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: dotColor }}
        />
      )}
      {label}
      {count !== undefined && (
        <span
          className={cn(
            'rounded-[var(--uxe-radius-pill)] px-1.5 py-0.5 text-[11px] font-semibold',
            active ? 'bg-[var(--uxe-cobalt)] text-white' : 'bg-[var(--uxe-neutral-bg)]',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
});
