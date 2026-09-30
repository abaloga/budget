import { formatShortDate, type TransactionWithSplits } from '@budget/core';
import { ArrowLeftRight, Link2, Split, StickyNote } from 'lucide-react';

import { Amount } from '@/components/Amount';
import { CategoryDot } from '@/components/pickers';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

export function TransactionRow({
  tx,
  categoryName,
  categoryColor,
  accountName,
  onOpen,
  compact,
}: {
  tx: TransactionWithSplits;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string;
  onOpen: () => void;
  compact?: boolean;
}) {
  const year = new Date().getFullYear();
  const category =
    tx.kind === 'transfer' ? (
      <span className="flex items-center gap-1.5 text-ink-3">
        {tx.transferPairId ? <Link2 className="size-3.5" /> : <ArrowLeftRight className="size-3.5" />} Transfer
      </span>
    ) : tx.splits.length ? (
      <span className="flex items-center gap-1.5 text-ink-2">
        <Split className="size-3.5" /> Split · {tx.splits.length}
      </span>
    ) : categoryName ? (
      <span className="flex min-w-0 items-center gap-2 text-ink-2">
        <CategoryDot color={categoryColor} />
        <span className="truncate">{categoryName}</span>
      </span>
    ) : (
      <span className="text-warn-ink">Uncategorized</span>
    );

  return (
    <li className="border-b border-line last:border-0">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'grid w-full items-center gap-x-4 px-5 py-3 text-left text-sm transition-colors hover:bg-surface-2',
          compact
            ? 'grid-cols-[minmax(0,1fr)_auto]'
            : 'grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[6rem_minmax(0,1fr)_12rem_10rem_8rem]',
        )}
      >
        {!compact && <span className="hidden text-ink-3 md:block">{formatShortDate(tx.date, year)}</span>}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-ink">{tx.name}</span>
            {tx.pending && <Badge tone="warn">Pending</Badge>}
            {tx.notes && <StickyNote className="size-3.5 shrink-0 text-ink-3" aria-label="Has notes" />}
          </span>
          <span className={cn('flex min-w-0 items-center gap-2 text-xs text-ink-3', !compact && 'md:hidden')}>
            <span className="shrink-0">{formatShortDate(tx.date, year)}</span>
            <span className="min-w-0 truncate">{category}</span>
          </span>
        </span>
        {!compact && <span className="hidden min-w-0 md:block">{category}</span>}
        {!compact && <span className="hidden truncate text-ink-3 md:block">{accountName}</span>}
        <Amount cents={tx.amountCents} kind={tx.kind} className="text-right font-medium" />
      </button>
    </li>
  );
}
