import { formatMoney, type Cents, type TransactionKind } from '@budget/core';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export const money = (cents: Cents, opts?: Parameters<typeof formatMoney>[1]) => formatMoney(cents, opts);

/** Compact money for tiles/axes: $1.2K, $15K, $1.3M */
export function compactMoney(cents: Cents): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  if (abs < 1000) return formatMoney(cents, { whole: true });
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: abs < 10_000 ? 1 : 0,
  }).format(dollars);
}

export function percent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export const KIND_LABELS: Record<TransactionKind, string> = {
  expense: 'Expense',
  income: 'Income',
  transfer: 'Transfer',
};

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
