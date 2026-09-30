import type { Cents, TransactionKind } from '@budget/core';

import { cn, money } from '@/lib/utils';

/**
 * A signed transaction amount. Money in is marked with "+" and a green tint;
 * transfers are muted because they don't affect spending or income.
 */
export function Amount({ cents, kind, className }: { cents: Cents; kind?: TransactionKind; className?: string }) {
  return (
    <span
      className={cn(
        'num whitespace-nowrap',
        kind === 'transfer' ? 'text-ink-3' : cents > 0 ? 'text-good-ink' : 'text-ink',
        className,
      )}
    >
      {money(cents, { sign: cents > 0 ? 'always' : 'auto' })}
    </span>
  );
}
