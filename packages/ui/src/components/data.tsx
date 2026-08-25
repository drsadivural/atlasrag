import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { cn } from '../utils.js';
import { Button, LoadingRegion, Skeleton } from './primitives.js';

/* -------------------------------------------------------------------------- */
/* Responsive table                                                           */
/* -------------------------------------------------------------------------- */

export interface Column<T> {
  key: string;
  header: string;
  /** Rendered on desktop and, unless `hideOnMobile`, inside the mobile card. */
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  /** Column shown as the card title on mobile. Exactly one column should set this. */
  primary?: boolean;
  hideOnMobile?: boolean;
  /** Pinned columns stay visible while the table scrolls horizontally. */
  sticky?: boolean;
  /**
   * The cell already renders its own link or button, so no activator is added around it.
   * Wrapping one would nest interactive controls and shrink the real target.
   */
  selfActivating?: boolean;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  onRowClick?: (row: T) => void;
  selection?: {
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: () => void;
    renderCheckbox: (checked: boolean, onChange: () => void, label: string) => ReactNode;
    /** Names the row in its checkbox label, so the choices are distinguishable by ear. */
    rowLabel?: (row: T) => string;
  };
  empty?: ReactNode;
  loading?: boolean;
  className?: string;
}

/**
 * Table that becomes a card list below the `md` breakpoint.
 *
 * The brief forbids horizontal page scrolling, so on small screens each row is re-laid out
 * as a labelled card rather than being squeezed or clipped. On desktop the table scrolls
 * inside its own container and pinned columns stay put, so the page itself never scrolls
 * sideways either.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  selection,
  empty,
  loading,
  className,
}: DataTableProps<T>) {
  const allSelected = selection
    ? rows.length > 0 && rows.every((r) => selection.selected.has(rowKey(r)))
    : false;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  /**
   * `table-fixed` makes the declared widths authoritative. Applied only when a column
   * actually declares one: with no widths, fixed layout would divide the row equally and
   * squeeze a title column down to the same size as a two-character type column.
   */
  const fixedLayout = columns.some((c) => c.width !== undefined);

  if (!loading && rows.length === 0 && empty) {
    return <div className={className}>{empty}</div>;
  }

  if (loading && rows.length === 0) {
    // Headers over an empty body read as "no results". A skeleton of the shape that is
    // coming, announced politely, reads as "not yet".
    return (
      <LoadingRegion label={`Loading ${caption}`}>
        <div className={cn('flex flex-col gap-2', className)}>
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      </LoadingRegion>
    );
  }

  return (
    <div className={className}>
      {/* Desktop */}
      <div className="hidden overflow-x-auto md:block">
        <table className={cn('w-full border-collapse text-left', fixedLayout && 'table-fixed')}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-[var(--uxe-border)]">
              {selection && (
                <th scope="col" className="w-11 px-3 py-2.5">
                  {selection.renderCheckbox(allSelected, selection.onToggleAll, 'Select all rows')}
                </th>
              )}
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  className={cn(
                    'px-3 py-2.5 text-[12px] font-semibold tracking-wide text-[var(--uxe-text-secondary)] uppercase',
                    column.align === 'right' && 'text-right',
                    column.align === 'center' && 'text-center',
                    column.sticky && 'sticky left-0 z-10 bg-[var(--uxe-surface)]',
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const id = rowKey(row);
              const isSelected = selection?.selected.has(id) ?? false;
              return (
                <tr
                  key={id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-[var(--uxe-border)] transition-colors duration-[var(--uxe-duration-fast)]',
                    'last:border-b-0 hover:bg-[var(--uxe-surface-hover)]',
                    isSelected && 'bg-[var(--uxe-surface-selected)]',
                    onRowClick && 'cursor-pointer',
                  )}
                >
                  {selection && (
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      {selection.renderCheckbox(
                        isSelected,
                        () => selection.onToggle(id),
                        selection.rowLabel
                          ? `Select ${selection.rowLabel(row)}`
                          : `Select ${caption} row`,
                      )}
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-3 py-3 text-[14px] text-[var(--uxe-text)]',
                        fixedLayout && 'overflow-hidden text-ellipsis',
                        column.align === 'right' && 'text-right',
                        column.align === 'center' && 'text-center',
                        column.sticky && 'sticky left-0 z-10 bg-inherit',
                      )}
                    >
                      {onRowClick && column === primary && !column.selfActivating ? (
                        // A row that only responds to a click is unreachable by keyboard.
                        // The primary cell carries a real control, so the row has one
                        // focusable, named activator without breaking table semantics.
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRowClick(row);
                          }}
                          className={cn(
                            'w-full min-w-0 text-left',
                            'focus-visible:outline-2 focus-visible:outline-offset-2',
                            'rounded-[var(--uxe-radius-control)] focus-visible:outline-[var(--uxe-cobalt)]',
                          )}
                        >
                          {column.render(row)}
                        </button>
                      ) : (
                        column.render(row)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per row, every value carries its column label. */}
      <ul className="flex flex-col gap-2.5 md:hidden" aria-label={caption}>
        {rows.map((row) => {
          const id = rowKey(row);
          const isSelected = selection?.selected.has(id) ?? false;
          return (
            <li key={id}>
              {/*
                No card-level click handler: the title is a real button, so activation is
                keyboard-reachable and the card does not need to fake interactivity.
              */}
              <div
                className={cn(
                  'rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)]',
                  'bg-[var(--uxe-surface)] p-3.5 shadow-[var(--uxe-shadow-xs)]',
                  isSelected && 'border-[var(--uxe-cobalt)] bg-[var(--uxe-surface-selected)]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 text-[15px] font-medium text-[var(--uxe-text)]">
                    {onRowClick && primary && !primary.selfActivating ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRowClick(row);
                        }}
                        className="w-full min-w-0 text-left"
                      >
                        {primary.render(row)}
                      </button>
                    ) : (
                      primary?.render(row)
                    )}
                  </div>
                  {selection && (
                    <div>
                      {selection.renderCheckbox(
                        isSelected,
                        () => selection.onToggle(id),
                        selection.rowLabel ? `Select ${selection.rowLabel(row)}` : 'Select row',
                      )}
                    </div>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                  {columns
                    .filter((c) => c !== primary && !c.hideOnMobile)
                    .map((column) => (
                      <Fragment key={column.key}>
                        <dt className="text-[11px] font-semibold tracking-wide text-[var(--uxe-text-secondary)] uppercase">
                          {column.header}
                        </dt>
                        <dd className="text-right text-[13px] text-[var(--uxe-text)]">
                          {column.render(row)}
                        </dd>
                      </Fragment>
                    ))}
                </dl>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // Show a window around the current page rather than every page number, so a 200-page
  // result set does not produce an unusable strip of controls.
  const pages: Array<number | 'gap'> = [];
  const window = 1;
  for (let i = 1; i <= totalPages; i += 1) {
    if (i === 1 || i === totalPages || Math.abs(i - page) <= window) pages.push(i);
    else if (pages.at(-1) !== 'gap') pages.push('gap');
  }

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--uxe-border)] px-1 pt-3"
    >
      <p className="text-[13px] text-[var(--uxe-text-secondary)]">
        Showing {from}–{to} of {total}
      </p>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        {pages.map((entry, index) =>
          entry === 'gap' ? (
            <span
              key={`gap-${index}`}
              aria-hidden
              className="px-1.5 text-[13px] text-[var(--uxe-text-tertiary)]"
            >
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              onClick={() => onPageChange(entry)}
              aria-current={entry === page ? 'page' : undefined}
              aria-label={`Page ${entry}`}
              className={cn(
                'h-8 min-w-8 rounded-[var(--uxe-radius-control)] px-2 text-[13px] font-medium transition-colors',
                entry === page
                  ? 'bg-[var(--uxe-cobalt)] text-white'
                  : 'text-[var(--uxe-text-secondary)] hover:bg-[var(--uxe-surface-hover)]',
              )}
            >
              {entry}
            </button>
          ),
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>

        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Rows per page"
            className="ml-2 h-8 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)] bg-[var(--uxe-surface)] px-2 text-[13px]"
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
        )}
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Charts                                                                     */
/* -------------------------------------------------------------------------- */

export interface AreaPoint {
  label: string;
  value: number;
}

/**
 * Area chart with a table alternative.
 *
 * Drawn as inline SVG rather than pulled from a chart library so it inherits the theme
 * tokens directly and adds no runtime weight. The `<table>` beneath it is the accessible
 * equivalent the brief requires: it is visually hidden but fully readable by assistive
 * technology, and can be revealed by the caller.
 */
export function AreaChart({
  points,
  height = 220,
  ariaLabel,
  valueLabel = 'Value',
  showTable = false,
}: {
  points: AreaPoint[];
  height?: number;
  ariaLabel: string;
  valueLabel?: string;
  showTable?: boolean;
}) {
  const width = 720;
  const padding = { top: 16, right: 8, bottom: 26, left: 34 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const max = Math.max(1, ...points.map((p) => p.value));
  // Round the axis up to a friendly number so gridlines land on readable values.
  const axisMax = niceCeil(max);
  const step = points.length > 1 ? innerWidth / (points.length - 1) : innerWidth;

  const coords = points.map((point, index) => ({
    x: padding.left + index * step,
    y: padding.top + innerHeight - (point.value / axisMax) * innerHeight,
    ...point,
  }));

  const line = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${(coords.at(-1)?.x ?? padding.left).toFixed(1)},${padding.top + innerHeight} L${padding.left},${padding.top + innerHeight} Z`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(axisMax * f));
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <linearGradient id="uxe-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--uxe-cobalt)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--uxe-cobalt)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => {
          const y = padding.top + innerHeight - (tick / axisMax) * innerHeight;
          return (
            <g key={tick}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="var(--uxe-border)"
                strokeWidth="1"
                strokeDasharray={tick === 0 ? undefined : '3 4'}
              />
              <text
                x={padding.left - 8}
                y={y + 4}
                textAnchor="end"
                fontSize="10"
                fill="var(--uxe-text-tertiary)"
              >
                {tick}
              </text>
            </g>
          );
        })}

        <path d={area} fill="url(#uxe-area-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--uxe-cobalt)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {coords.map((c, index) =>
          index % labelEvery === 0 || index === coords.length - 1 ? (
            <circle
              key={c.label}
              cx={c.x}
              cy={c.y}
              r="3.5"
              fill="var(--uxe-surface)"
              stroke="var(--uxe-cobalt)"
              strokeWidth="2"
            />
          ) : null,
        )}

        {coords.map((c, index) =>
          index % labelEvery === 0 || index === coords.length - 1 ? (
            <text
              key={`label-${c.label}`}
              x={c.x}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="var(--uxe-text-tertiary)"
            >
              {c.label}
            </text>
          ) : null,
        )}
      </svg>

      <figcaption className={showTable ? 'mt-4' : 'sr-only'}>
        <table className="w-full border-collapse text-left text-[13px]">
          <caption className="sr-only">{ariaLabel} — data table</caption>
          <thead>
            <tr className="border-b border-[var(--uxe-border)]">
              <th
                scope="col"
                className="py-1.5 pr-3 font-semibold text-[var(--uxe-text-secondary)]"
              >
                Date
              </th>
              <th
                scope="col"
                className="py-1.5 text-right font-semibold text-[var(--uxe-text-secondary)]"
              >
                {valueLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.label} className="border-b border-[var(--uxe-border)] last:border-0">
                <td className="py-1.5 pr-3">{point.label}</td>
                <td className="py-1.5 text-right tabular-nums">{point.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

/** Donut chart with a legend that always shows the value, never colour alone. */
export function DonutChart({
  segments,
  total,
  centerLabel,
  ariaLabel,
  size = 168,
}: {
  segments: DonutSegment[];
  total: number;
  centerLabel?: string;
  ariaLabel: string;
  size?: number;
}) {
  const strokeWidth = 24;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const safeTotal = total || 1;

  // Each arc starts where the preceding ones ended. Computed from the segments rather than
  // by mutating a running total during render.
  const arcs = segments.map((segment, index) => {
    const fraction = segment.value / safeTotal;
    const priorFraction =
      segments.slice(0, index).reduce((sum, previous) => sum + previous.value, 0) / safeTotal;
    return {
      ...segment,
      dash: fraction * circumference,
      offset: -priorFraction * circumference,
      percent: fraction * 100,
    };
  });

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" role="img" aria-label={ariaLabel}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--uxe-surface-sunken)"
            strokeWidth={strokeWidth}
          />
          {arcs.map((arc) => (
            <circle
              key={arc.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
              strokeDashoffset={arc.offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[24px] leading-none font-bold text-[var(--uxe-text)]">{total}</span>
          {centerLabel && (
            <span className="mt-1 text-[12px] text-[var(--uxe-text-secondary)]">{centerLabel}</span>
          )}
        </div>
      </div>

      <ul className="flex min-w-0 flex-1 flex-col gap-2.5">
        {segments.map((segment) => (
          <li key={segment.label} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: segment.color }}
              />
              <span className="truncate text-[var(--uxe-text)]">{segment.label}</span>
            </span>
            <span className="shrink-0 text-[var(--uxe-text-secondary)] tabular-nums">
              {segment.value} ({Math.round((segment.value / safeTotal) * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function niceCeil(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}
