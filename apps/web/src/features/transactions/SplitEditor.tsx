import {
  parseMoneyInput,
  splitEvenly,
  validateSplits,
  type Category,
  type Split,
  type TransactionWithSplits,
} from '@budget/core';
import { Plus, Trash } from 'lucide-react';
import * as React from 'react';

import { CategorySelect } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { StatusNote } from '@/components/ui/misc';
import { cn, money } from '@/lib/utils';

interface Draft {
  key: number;
  categoryId: string | null;
  amount: string;
}

let nextKey = 1;
const toInput = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/**
 * Edit a transaction's split. Parts are entered as positive amounts; the sign
 * follows the transaction. Save is only possible when parts sum exactly.
 */
export function SplitEditor({
  tx,
  categories,
  onSave,
  onCancel,
  saving,
}: {
  tx: TransactionWithSplits;
  categories: Category[];
  onSave: (splits: Split[]) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const sign = tx.amountCents < 0 ? -1 : 1;
  const [rows, setRows] = React.useState<Draft[]>(() =>
    tx.splits.length
      ? tx.splits.map((s) => ({ key: nextKey++, categoryId: s.categoryId, amount: toInput(s.amountCents) }))
      : [
          { key: nextKey++, categoryId: tx.categoryId, amount: toInput(tx.amountCents) },
          { key: nextKey++, categoryId: null, amount: '' },
        ],
  );

  const parsed: Split[] = rows.map((r) => ({
    categoryId: r.categoryId ?? '',
    amountCents: sign * Math.abs(parseMoneyInput(r.amount) ?? 0),
  }));
  const validation = validateSplits(tx.amountCents, parsed);
  const remaining = validation.remainingCents;

  const update = (key: number, patch: Partial<Draft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <li key={r.key} className="grid grid-cols-[1fr_7rem_auto] items-center gap-2">
            <CategorySelect
              aria-label={`Part ${i + 1} category`}
              categories={categories}
              value={r.categoryId}
              onChange={(v) => update(r.key, { categoryId: v })}
              noneLabel="Choose category"
            />
            <Input
              aria-label={`Part ${i + 1} amount`}
              inputMode="decimal"
              className="num text-right"
              placeholder="0.00"
              value={r.amount}
              onChange={(e) => update(r.key, { amount: e.target.value })}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove part ${i + 1}`}
              disabled={rows.length <= 2}
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
            >
              <Trash />
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setRows((rs) => [
                ...rs,
                { key: nextKey++, categoryId: null, amount: remaining ? toInput(remaining) : '' },
              ])
            }
          >
            <Plus /> Add part
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const parts = splitEvenly(Math.abs(tx.amountCents), rows.length);
              setRows((rs) => rs.map((r, i) => ({ ...r, amount: toInput(parts[i]!) })));
            }}
          >
            Split evenly
          </Button>
        </div>
        <span className={cn('num', remaining === 0 ? 'text-good-ink' : 'text-ink-2')}>
          {remaining === 0
            ? 'Fully allocated'
            : `${money(Math.abs(remaining))} ${Math.sign(remaining) === sign ? 'left' : 'over'}`}
        </span>
      </div>

      {!validation.ok && rows.some((r) => r.amount) && remaining === 0 && (
        <StatusNote tone="warn">{validation.errors[0]}</StatusNote>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!validation.ok} loading={saving} onClick={() => onSave(parsed)}>
          Save split
        </Button>
      </div>
    </div>
  );
}
