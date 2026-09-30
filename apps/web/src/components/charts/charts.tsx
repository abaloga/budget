/**
 * Chart components.
 *
 * Conventions (see README "Charts"): thin marks (bars <= 24px, 4px rounded
 * data-end, 2px lines), one y-axis only, hairline solid grid, a legend for 2+
 * series, value-first tooltips, text in ink tokens (never series colors), and a
 * table view for every chart. Series colors are a validated categorical order
 * assigned by entity, never by rank.
 */
import { formatMonth, type Cents } from '@budget/core';
import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';

import { CategoryDot } from '@/components/pickers';
import { cn, compactMoney, money, percent } from '@/lib/utils';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

type Row = { month: string } & Record<string, number | string>;

const axisTick = { fill: 'var(--chart-axis)', fontSize: 11 };

function monthTick(m: string) {
  return formatMonth(m, 'short').replace(/ \d{4}$/, '');
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: TooltipContentProps<number, string> & { series: SeriesDef[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-40 rounded-control border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 text-ink-3">{formatMonth(String(label))}</p>
      <ul className="flex flex-col gap-1">
        {series.map((s) => {
          const item = payload.find((p) => p.dataKey === s.key);
          if (!item) return null;
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
              <span className="num font-semibold text-ink">{money(Number(item.value ?? 0))}</span>
              <span className="text-ink-3">{s.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Legend({ series, shape = 'rect' }: { series: SeriesDef[]; shape?: 'rect' | 'line' }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={shape === 'rect' ? 'size-2.5 rounded-[3px]' : 'h-0.5 w-3.5 rounded-full'}
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Monthly columns: one or two series of positive amounts (e.g. income vs spending). */
export function MonthlyColumns({ data, series, height = 220 }: { data: Row[]; series: SeriesDef[]; height?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <Legend series={series} />
      <div style={{ height }} className="-ml-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2} barCategoryGap="28%" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
            <XAxis
              dataKey="month"
              tickFormatter={monthTick}
              tick={axisTick}
              axisLine={{ stroke: 'var(--line-strong)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => compactMoney(v)}
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={(props) => <ChartTooltip {...(props as TooltipContentProps<number, string>)} series={series} />}
            />
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Lines over months (trends). Up to five series; always with a legend when 2+. */
export function TrendLines({ data, series, height = 260 }: { data: Row[]; series: SeriesDef[]; height?: number }) {
  return (
    <div className="flex flex-col gap-3">
      <Legend series={series} shape="line" />
      <div style={{ height }} className="-ml-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
            <XAxis
              dataKey="month"
              tickFormatter={monthTick}
              tick={axisTick}
              axisLine={{ stroke: 'var(--line-strong)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => compactMoney(v)}
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }}
              content={(props) => <ChartTooltip {...(props as TooltipContentProps<number, string>)} series={series} />}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, fill: s.color, stroke: 'var(--surface)', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export interface BarListItem {
  id: string;
  label: string;
  value: Cents;
  color?: string | null;
  sublabel?: string;
  href?: string;
}

/**
 * Ranked horizontal bars as plain HTML: every value is printed, so nothing is
 * hover-gated. Bars share one hue; identity comes from the label (+ dot).
 */
export function BarList({
  items,
  total,
  onSelect,
  emptyLabel = 'Nothing here yet',
}: {
  items: BarListItem[];
  total?: Cents;
  onSelect?: (item: BarListItem) => void;
  emptyLabel?: string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  if (!items.length) return <p className="py-6 text-center text-sm text-ink-3">{emptyLabel}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const content = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                {item.color !== undefined && <CategoryDot color={item.color} />}
                <span className="truncate text-ink">{item.label}</span>
                {item.sublabel && <span className="shrink-0 text-xs text-ink-3">{item.sublabel}</span>}
              </span>
              <span className="num shrink-0 font-medium text-ink">
                {money(item.value)}
                {total ? (
                  <span className="ml-1.5 text-xs font-normal text-ink-3">{percent(item.value / total)}</span>
                ) : null}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-[var(--series-1)]"
                style={{ width: `${Math.max((item.value / max) * 100, 1)}%` }}
              />
            </div>
          </>
        );
        return (
          <li key={item.id}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(item)}
                className="-mx-2 block w-[calc(100%+1rem)] rounded-control px-2 py-1 text-left hover:bg-surface-2"
              >
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A plain table alternative for any monthly chart. */
export function MonthTable({
  data,
  series,
  extra,
}: {
  data: Row[];
  series: SeriesDef[];
  extra?: { key: string; label: string }[];
}) {
  const cols = [...series.map((s) => ({ key: s.key, label: s.label })), ...(extra ?? [])];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            <th className="py-2 pr-4 font-medium">Month</th>
            {cols.map((c) => (
              <th key={c.key} className="py-2 pl-4 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.month} className="border-b border-line last:border-0">
              <td className="py-2 pr-4 text-ink-2">{formatMonth(row.month)}</td>
              {cols.map((c) => (
                <td key={c.key} className="num py-2 pl-4 text-right text-ink">
                  {money(Number(row[c.key] ?? 0))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartOrTable({
  chart,
  table,
  className,
}: {
  chart: React.ReactNode;
  table: React.ReactNode;
  className?: string;
}) {
  const [showTable, setShowTable] = React.useState(false);
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex justify-end">
        <button
          type="button"
          className="text-xs text-ink-3 hover:text-ink"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {showTable ? table : chart}
    </div>
  );
}

/** Stat tile: label, value, optional context line. */
export function StatTile({
  label,
  value,
  detail,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: 'good' | 'bad';
  className?: string;
}) {
  return (
    <div className={cn('rounded-card border border-line bg-surface px-4 py-3.5 shadow-card', className)}>
      <p className="text-xs font-medium text-ink-3">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tracking-tight', tone === 'bad' ? 'text-bad-ink' : 'text-ink')}>
        {value}
      </p>
      {detail && <div className="mt-1 text-xs text-ink-3">{detail}</div>}
    </div>
  );
}
