import type { RuleInput } from '@budget/api';
import {
  FREQUENCY_LABELS,
  accountDisplayName,
  formatShortDate,
  parseMoneyInput,
  type Account,
  type Category,
  type RecurringFrequency,
  type Split,
  type TransactionKind,
  type TransactionWithSplits,
} from '@budget/core';
import { useQuery } from '@tanstack/react-query';
import { Link2, Repeat, Split as SplitIcon, Trash, WandSparkles } from 'lucide-react';
import * as React from 'react';

import { Amount } from '@/components/Amount';
import { CategorySelect } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Segmented, Select, Textarea } from '@/components/ui/form';
import { Badge, ErrorState, PageLoader, StatusNote } from '@/components/ui/misc';
import { keys, useFinancialMutation, useTransaction } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';

import { RuleDialog } from '../settings/RuleDialog';
import { SplitEditor } from './SplitEditor';

const SOURCE_LABELS: Record<string, string> = {
  user: 'Set by you',
  rule: 'Set by a rule',
  history: 'Learned from your past choices',
  provider: 'Suggested by your bank',
  none: 'Not categorized',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line py-4 first:border-0 first:pt-0">
      <h3 className="text-xs font-semibold tracking-wide text-ink-3 uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function TransactionDetail({
  id,
  onClose,
  categories,
  accounts,
}: {
  id: string | null;
  onClose: () => void;
  categories: Category[];
  accounts: Account[];
}) {
  const { data: tx, isLoading, error, refetch } = useTransaction(id);
  return (
    <Dialog open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent variant="side" title="Transaction">
        {isLoading && <PageLoader />}
        {error && <ErrorState error={error} onRetry={() => void refetch()} />}
        {tx && (
          <DetailBody
            key={tx.id + tx.updatedAt}
            tx={tx}
            categories={categories}
            accounts={accounts}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailBody({
  tx,
  categories,
  accounts,
  onClose,
}: {
  tx: TransactionWithSplits;
  categories: Category[];
  accounts: Account[];
  onClose: () => void;
}) {
  const account = accounts.find((a) => a.id === tx.accountId);
  const manual = tx.source === 'manual';
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState(manual ? tx.originalName : (tx.nameOverride ?? ''));
  const [date, setDate] = React.useState(manual ? tx.originalDate : (tx.dateOverride ?? ''));
  const [notes, setNotes] = React.useState(tx.notes ?? '');
  const [amount, setAmount] = React.useState((Math.abs(tx.amountCents) / 100).toFixed(2));
  const [splitting, setSplitting] = React.useState(false);
  const [ruleOpen, setRuleOpen] = React.useState(false);
  const [frequency, setFrequency] = React.useState<RecurringFrequency>('monthly');

  const run = useFinancialMutation(async (fn: () => Promise<unknown>) => fn(), [keys.recurring]);
  const act = (fn: () => Promise<unknown>) =>
    run.mutate(fn, { onError: (e) => setError(errorMessage(e)), onSuccess: () => setError(null) });

  const dirty =
    notes !== (tx.notes ?? '') ||
    (manual
      ? name !== tx.originalName || date !== tx.originalDate || parseMoneyInput(amount) !== Math.abs(tx.amountCents)
      : name !== (tx.nameOverride ?? '') || date !== (tx.dateOverride ?? ''));

  function saveDetails() {
    act(async () => {
      await api.transactions.edit(tx, { name: name || null, date: date || null, notes });
      if (manual) {
        const cents = parseMoneyInput(amount);
        if (cents === null || cents === 0) throw new Error('Enter a valid amount.');
        const signed = Math.sign(tx.amountCents || -1) * Math.abs(cents);
        if (signed !== tx.amountCents) await api.transactions.setManualAmount(tx, signed);
      }
    });
  }

  const pair = useQuery({
    queryKey: ['transaction', tx.transferPairId ?? 'none'],
    queryFn: () => api.transactions.get(tx.transferPairId!),
    enabled: Boolean(tx.transferPairId),
  });
  const candidates = useQuery({
    queryKey: ['transferCandidates', tx.id],
    queryFn: () => api.transactions.transferCandidates(tx),
    enabled: tx.kind === 'transfer' && !tx.transferPairId,
  });

  const ruleInitial = React.useMemo<Partial<RuleInput>>(
    () => ({
      nameOperator: 'contains',
      nameValue: tx.originalMerchantName ?? tx.name,
      setCategoryId: tx.categoryId,
      setKind: tx.kind === 'transfer' ? 'transfer' : null,
    }),
    [tx],
  );

  return (
    <div className="flex flex-col">
      <div className="mb-4 flex flex-col gap-1">
        <Amount cents={tx.amountCents} kind={tx.kind} className="text-3xl font-semibold tracking-tight" />
        <p className="text-base font-medium text-ink">{tx.name}</p>
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink-3">
          <span>{formatShortDate(tx.date, new Date().getFullYear())}</span>
          {account && <span>· {accountDisplayName(account)}</span>}
          {tx.pending && <Badge tone="warn">Pending</Badge>}
          {manual && <Badge tone="outline">Added manually</Badge>}
        </div>
      </div>

      {error && (
        <StatusNote tone="bad" className="mb-3">
          {error}
        </StatusNote>
      )}

      <Section title="Details">
        <Field
          label="Name"
          htmlFor="tx-name"
          hint={manual ? undefined : `From your bank: ${tx.originalMerchantName ?? tx.originalName}`}
        >
          <Input
            id="tx-name"
            value={name}
            placeholder={tx.originalMerchantName ?? tx.originalName}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="tx-date">
            <Input
              id="tx-date"
              type="date"
              value={date || (manual ? '' : tx.originalDate)}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          {manual && (
            <Field label="Amount" htmlFor="tx-amount">
              <Input
                id="tx-amount"
                inputMode="decimal"
                className="num"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          )}
        </div>
        <Field label="Notes" htmlFor="tx-notes">
          <Textarea id="tx-notes" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {dirty && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" loading={run.isPending} onClick={saveDetails}>
              Save changes
            </Button>
          </div>
        )}
      </Section>

      <Section title="Type">
        <Segmented<TransactionKind>
          label="Transaction type"
          value={tx.kind}
          onChange={(k) => act(() => api.transactions.setKind(tx.id, k))}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
            { value: 'transfer', label: 'Transfer' },
          ]}
        />
        {tx.kind === 'transfer' && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-ink-3">Transfers between your accounts don’t count as income or spending.</p>
            {tx.transferPairId && pair.data ? (
              <div className="flex items-center justify-between gap-2 rounded-control border border-line px-3 py-2">
                <span className="min-w-0 truncate">
                  <Link2 className="mr-1.5 inline size-4 text-ink-3" />
                  Linked to {pair.data.name} · {formatShortDate(pair.data.date)}
                </span>
                <Amount cents={pair.data.amountCents} kind="transfer" />
              </div>
            ) : candidates.data?.length ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-ink-3">Possible other side:</p>
                {candidates.data.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => act(() => api.transactions.linkTransfer(tx.id, c.id))}
                    className="flex items-center justify-between gap-2 rounded-control border border-line px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <span className="min-w-0 truncate">
                      {c.name} · {formatShortDate(c.date)}
                    </span>
                    <span className="flex items-center gap-2">
                      <Amount cents={c.amountCents} />
                      <Link2 className="size-4 text-ink-3" />
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </Section>

      {tx.kind !== 'transfer' && (
        <Section title="Category">
          {splitting ? (
            <SplitEditor
              tx={tx}
              categories={categories}
              saving={run.isPending}
              onCancel={() => setSplitting(false)}
              onSave={(splits: Split[]) =>
                act(async () => {
                  await api.transactions.setSplits(tx.id, splits);
                  setSplitting(false);
                })
              }
            />
          ) : tx.splits.length ? (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
                {tx.splits.map((s) => (
                  <li key={s.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{categories.find((c) => c.id === s.categoryId)?.name ?? 'Unknown'}</span>
                    <Amount cents={s.amountCents} />
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setSplitting(true)}>
                  Edit split
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act(() => api.transactions.setSplits(tx.id, []))}>
                  Remove split
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <CategorySelect
                aria-label="Category"
                categories={categories}
                value={tx.categoryId}
                onChange={(id) =>
                  act(() => api.transactions.setCategory(tx, categories.find((c) => c.id === id) ?? null))
                }
              />
              <p className="text-xs text-ink-3">{SOURCE_LABELS[tx.categorySource]}</p>
              <div>
                <Button size="sm" variant="ghost" onClick={() => setSplitting(true)}>
                  <SplitIcon /> Split across categories
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}

      <Section title="Automate">
        <div className="flex flex-col gap-2">
          <Button size="sm" className="self-start" onClick={() => setRuleOpen(true)}>
            <WandSparkles /> Create a rule from this
          </Button>
          {tx.recurringId ? (
            <p className="flex items-center gap-1.5 text-sm text-ink-3">
              <Repeat className="size-4" /> Part of a recurring series
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Frequency"
                className="w-40"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
              >
                {Object.entries(FREQUENCY_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={() => act(() => api.recurring.markTransaction(tx, frequency))}>
                <Repeat /> Mark as recurring
              </Button>
            </div>
          )}
        </div>
      </Section>

      {!manual && (
        <Section title="From your bank">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-ink-3">Description</dt>
            <dd className="break-words text-ink-2">{tx.originalName}</dd>
            {tx.originalMerchantName && (
              <>
                <dt className="text-ink-3">Merchant</dt>
                <dd className="text-ink-2">{tx.originalMerchantName}</dd>
              </>
            )}
            <dt className="text-ink-3">Date</dt>
            <dd className="text-ink-2">{tx.originalDate}</dd>
            {tx.providerCategoryDetailed && (
              <>
                <dt className="text-ink-3">Bank category</dt>
                <dd className="text-ink-2">{tx.providerCategoryDetailed.replaceAll('_', ' ').toLowerCase()}</dd>
              </>
            )}
          </dl>
          <p className="text-xs text-ink-3">Your edits are stored separately, so bank updates never undo them.</p>
        </Section>
      )}

      {manual && (
        <Section title="Danger zone">
          <Button
            variant="danger"
            size="sm"
            className="self-start"
            onClick={() => {
              if (!window.confirm('Delete this transaction? This can’t be undone.')) return;
              run.mutate(() => api.transactions.deleteManual(tx.id), {
                onSuccess: onClose,
                onError: (e) => setError(errorMessage(e)),
              });
            }}
          >
            <Trash /> Delete transaction
          </Button>
        </Section>
      )}

      <RuleDialog
        open={ruleOpen}
        onOpenChange={setRuleOpen}
        initial={ruleInitial}
        categories={categories}
        accounts={accounts}
      />
    </div>
  );
}
