import { formatShortDate, type UpcomingBill } from '@budget/core';
import { CircleAlert } from 'lucide-react';

import { CategoryDot, type useCategoryLookup } from '@/components/pickers';
import { Badge } from '@/components/ui/misc';
import { cn, money } from '@/lib/utils';

/** Upcoming bill occurrences; soon/overdue rows are highlighted with a label, not color alone. */
export function UpcomingList({
  bills,
  lookup,
  accountName,
  limit,
}: {
  bills: UpcomingBill[];
  lookup: ReturnType<typeof useCategoryLookup>;
  accountName: (id: string | null) => string | null;
  limit?: number;
}) {
  const year = new Date().getFullYear();
  return (
    <ul className="divide-y divide-line">
      {bills.slice(0, limit).map((b) => {
        const range =
          b.amountMinCents != null && b.amountMaxCents != null && b.amountMinCents !== b.amountMaxCents
            ? `${money(b.amountMinCents)}–${money(b.amountMaxCents)}`
            : null;
        return (
          <li
            key={`${b.seriesId}-${b.date}`}
            className={cn(
              'flex items-center gap-3 px-5 py-3',
              b.urgency === 'soon' && 'bg-warn/6',
              b.urgency === 'overdue' && 'bg-bad/5',
            )}
          >
            <div className="flex w-12 shrink-0 flex-col items-center rounded-control border border-line bg-surface py-1 text-center leading-tight">
              <span className="text-[10px] font-medium text-ink-3 uppercase">
                {formatShortDate(b.date).split(' ')[0]}
              </span>
              <span className="text-base font-semibold">{Number(b.date.slice(8))}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-sm font-medium text-ink">
                {b.name}
                {b.urgency === 'overdue' && (
                  <Badge tone="bad">
                    <CircleAlert className="size-3" /> Expected {formatShortDate(b.date, year)}
                  </Badge>
                )}
                {b.urgency === 'soon' && (
                  <Badge tone="warn">
                    {b.daysUntil === 0 ? 'Today' : b.daysUntil === 1 ? 'Tomorrow' : `In ${b.daysUntil} days`}
                  </Badge>
                )}
              </p>
              <p className="flex items-center gap-1.5 truncate text-xs text-ink-3">
                {lookup.label(b.categoryId) && (
                  <>
                    <CategoryDot color={lookup.color(b.categoryId)} className="size-2" /> {lookup.label(b.categoryId)}
                  </>
                )}
                {accountName(b.accountId) && <span>· {accountName(b.accountId)}</span>}
              </p>
            </div>
            <div className="text-right">
              <p className="num text-sm font-medium">{money(b.amountCents)}</p>
              {range && <p className="num text-xs text-ink-3">{range}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
