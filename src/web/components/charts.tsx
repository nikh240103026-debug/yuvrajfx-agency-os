import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import { cx } from '../lib/util.ts';

// Chart kit following the data-viz rules: thin marks with 4px rounded data-ends, 2px gaps,
// hairline grid, a legend for 2+ series, text in ink tokens (never the series colour),
// a hover/focus tooltip listing every series, and a table view for every chart.

export type Series = { key: string; label: string; color: string; values: number[] };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Path for a bar with 4px rounded top corners and a square base. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function Legend({ items }: { items: { label: string; color: string; shape?: 'rect' | 'line' }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className={i.shape === 'line' ? 'h-0.5 w-3 rounded' : 'size-2.5 rounded-[3px]'} style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export function ChartFrame({ title, description, legend, children, table, actions, className }: { title?: ReactNode; description?: ReactNode; legend?: ReactNode; children: ReactNode; table?: ReactNode; actions?: ReactNode; className?: string }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className={cx('min-w-0', className)}>
      {(title || legend || table || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="min-w-0">
            {title && <figcaption className="text-[14px] font-semibold text-ink">{title}</figcaption>}
            {description && <p className="text-[12.5px] text-ink-3 mt-0.5">{description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {actions}
            {legend}
            {table && (
              <button
                type="button"
                onClick={() => setShowTable((v) => !v)}
                className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink cursor-pointer"
                aria-pressed={showTable}
              >
                {showTable ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />}
                {showTable ? 'Chart' : 'Table'}
              </button>
            )}
          </div>
        </div>
      )}
      {showTable && table ? <div className="overflow-x-auto">{table}</div> : children}
    </figure>
  );
}

export function DataTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-left text-ink-3">
          {headers.map((h, i) => (
            <th key={h} className={cx('py-1.5 pr-4 font-medium', i > 0 && 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular">
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-line">
            {r.map((c, j) => (
              <td key={j} className={cx('py-1.5 pr-4', j > 0 ? 'text-right text-ink' : 'text-ink-2')}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Grouped column chart (e.g. collected vs invoiced vs expenses per month) in ONE currency. */
export function ColumnChart({ categories, series, format, formatAxis, height = 240, dim }: { categories: string[]; series: Series[]; format: (v: number) => string; formatAxis?: (v: number) => string; height?: number; dim?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const axisW = 52;
  const bottom = 24;
  const top = 8;
  const plotW = Math.max(0, width - axisW);
  const plotH = height - bottom - top;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const band = categories.length ? plotW / categories.length : 0;
  const gap = 2;
  const barW = Math.max(2, Math.min(24, (band * 0.62 - gap * (series.length - 1)) / Math.max(1, series.length)));
  const groupW = barW * series.length + gap * (series.length - 1);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const showEvery = band < 34 ? Math.ceil(34 / Math.max(1, band)) : 1;

  return (
    <div ref={ref} className={cx('relative w-full select-none transition-opacity', dim && 'opacity-50')} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Column chart: ${series.map((s) => s.label).join(', ')} by ${categories.length} periods`}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={axisW} x2={width} y1={y(t)} y2={y(t)} stroke={i === 0 ? 'rgb(255 255 255 / 0.16)' : 'rgb(255 255 255 / 0.06)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={axisW - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 tabular" fontSize={11}>
                {(formatAxis ?? format)(t)}
              </text>
            </g>
          ))}
          {categories.map((c, i) => {
            const gx = axisW + i * band + (band - groupW) / 2;
            return (
              <g key={c}>
                {hover === i && <rect x={axisW + i * band + 2} y={top} width={band - 4} height={plotH} rx={6} fill="rgb(255 255 255 / 0.035)" />}
                {series.map((s, si) => {
                  const v = s.values[i] ?? 0;
                  const h = Math.max(0, y(0) - y(v));
                  return <path key={s.key} d={barPath(gx + si * (barW + gap), y(v), barW, h)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />;
                })}
                {i % showEvery === 0 && (
                  <text x={axisW + i * band + band / 2} y={height - 6} textAnchor="middle" className="fill-ink-3" fontSize={11}>
                    {c}
                  </text>
                )}
                <rect
                  x={axisW + i * band}
                  y={top}
                  width={band}
                  height={plotH + bottom}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${c}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? 0)}`).join(', ')}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  style={{ outline: 'none', cursor: 'default' }}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg bg-surface-3 px-3 py-2 ring-1 ring-white/10 shadow-xl text-[12px] min-w-40"
          style={{ left: Math.min(Math.max(axisW + hover * band + band / 2 - 80, 0), Math.max(0, width - 170)), top: 0 }}
        >
          <div className="text-ink-3 mb-1">{categories[hover]}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2 py-0.5">
              <span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
              <span className="font-semibold text-ink tabular">{format(s.values[hover] ?? 0)}</span>
              <span className="text-ink-3">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for one measure across nominal categories (one hue, values labelled). */
export function BarList({ items, format, color = 'var(--color-series-1)', empty = 'Nothing to show yet.', max: maxOverride }: { items: { key: string | number; label: ReactNode; value: number; sub?: ReactNode; href?: string }[]; format: (v: number) => string; color?: string; empty?: ReactNode; max?: number }) {
  const max = maxOverride ?? Math.max(0, ...items.map((i) => i.value));
  if (items.length === 0) return <p className="text-[13px] text-ink-3 py-4">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 items-center">
          <div className="min-w-0 text-[13px] text-ink-2 truncate">{i.label}</div>
          <div className="text-[13px] font-semibold text-ink tabular text-right">{format(i.value)}</div>
          <div className="col-span-2 h-1.5 rounded-full bg-white/[0.05] overflow-hidden" aria-hidden>
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${max > 0 ? Math.max(1.5, (i.value / max) * 100) : 0}%`, background: color }} />
          </div>
          {i.sub && <div className="col-span-2 text-[11.5px] text-ink-3 -mt-0.5">{i.sub}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Part-to-whole across ordered stages: one bar split into segments with 2px gaps, plus a legend list. */
export function StageBar({ segments, onSelect }: { segments: { key: string; label: string; count: number; color: string }[]; onSelect?: (key: string) => void }) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  const [hover, setHover] = useState<string | null>(null);
  const visible = segments.filter((s) => s.count > 0);
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] rounded-full overflow-hidden bg-white/[0.04]" role="img" aria-label={segments.map((s) => `${s.label} ${s.count}`).join(', ')}>
        {visible.map((s) => (
          <div
            key={s.key}
            className="h-full transition-opacity first:rounded-l-full last:rounded-r-full"
            title={`${s.label}: ${s.count} (${Math.round((s.count / total) * 100)}%)`}
            style={{ width: `${(s.count / total) * 100}%`, background: s.color, opacity: hover && hover !== s.key ? 0.45 : 1 }}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2">
        {segments.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={!onSelect}
              onClick={() => onSelect?.(s.key)}
              onPointerEnter={() => setHover(s.key)}
              onPointerLeave={() => setHover(null)}
              className={cx('flex w-full items-center gap-2 text-left text-[12.5px] rounded-md', onSelect && 'cursor-pointer hover:text-ink')}
            >
              <span className="size-2.5 rounded-[3px] shrink-0" style={{ background: s.color }} aria-hidden />
              <span className="text-ink-2 truncate flex-1">{s.label}</span>
              <span className="tabular font-semibold text-ink">{s.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Funnel: how many prospects reached each stage, with step conversion between stages. */
export function Funnel({ steps }: { steps: { key: string; label: string; value: number; rate?: number | null }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((s, i) => (
        <li key={s.key} className="grid grid-cols-[120px_minmax(0,1fr)_56px] items-center gap-3 text-[12.5px]">
          <span className="text-ink-2 truncate">{s.label}</span>
          <div className="h-6 rounded-md bg-white/[0.04] overflow-hidden">
            <div className="h-full rounded-md" style={{ width: `${Math.max(2, (s.value / max) * 100)}%`, background: `var(--color-stage-${Math.min(7, i + 1)})` }} />
          </div>
          <span className="text-right tabular">
            <span className="font-semibold text-ink">{s.value}</span>
            {s.rate !== undefined && <span className="block text-[11px] text-ink-3">{s.rate === null ? '—' : `${Math.round(s.rate * 100)}%`}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function useChartCurrency(currencies: string[], preferred: string) {
  const [cur, setCur] = useState<string | null>(null);
  const value = useMemo(() => (cur && currencies.includes(cur) ? cur : currencies.includes(preferred) ? preferred : currencies[0] ?? preferred), [cur, currencies, preferred]);
  return [value, setCur] as const;
}
