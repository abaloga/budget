import {
  parseMoneyInput,
  type Account,
  type CategorizationRule,
  type Category,
  type TransactionKind,
} from '@budget/core';
import type { RuleInput } from '@budget/api';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { AccountSelect, CategorySelect } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { StatusNote, Switch } from '@/components/ui/misc';
import { invalidateFinancialData, keys } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';

const EMPTY: RuleInput = {
  isEnabled: true,
  priority: 100,
  nameOperator: 'contains',
  nameValue: '',
  accountId: null,
  direction: null,
  amountMinCents: null,
  amountMaxCents: null,
  setCategoryId: null,
  setKind: null,
};

const centsToInput = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));

export function RuleDialog({
  open,
  onOpenChange,
  rule,
  initial,
  categories,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: CategorizationRule | null;
  initial?: Partial<RuleInput>;
  categories: Category[];
  accounts: Account[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={rule ? 'Edit rule' : 'New rule'}
        description="Rules run on new transactions before anything else. Your manual choices are never overwritten."
      >
        <RuleForm
          rule={rule}
          initial={initial}
          categories={categories}
          accounts={accounts}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function RuleForm({
  rule,
  initial,
  categories,
  accounts,
  onClose,
}: {
  rule?: CategorizationRule | null;
  initial?: Partial<RuleInput>;
  categories: Category[];
  accounts: Account[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const base: RuleInput = rule ? { ...rule } : { ...EMPTY, ...initial };
  const [form, setForm] = React.useState<RuleInput>(base);
  const [minText, setMinText] = React.useState(centsToInput(base.amountMinCents));
  const [maxText, setMaxText] = React.useState(centsToInput(base.amountMaxCents));
  const [applyExisting, setApplyExisting] = React.useState(!rule);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  const set = <K extends keyof RuleInput>(k: K, v: RuleInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const min = minText.trim() ? parseMoneyInput(minText) : null;
    const max = maxText.trim() ? parseMoneyInput(maxText) : null;
    if ((minText.trim() && min == null) || (maxText.trim() && max == null))
      return setError('Enter amounts like 12.50.');
    const input: RuleInput = {
      ...form,
      amountMinCents: min == null ? null : Math.abs(min),
      amountMaxCents: max == null ? null : Math.abs(max),
    };
    if (
      !input.nameValue?.trim() &&
      !input.accountId &&
      !input.direction &&
      input.amountMinCents == null &&
      input.amountMaxCents == null
    ) {
      return setError('Add at least one condition.');
    }
    if (!input.setCategoryId && !input.setKind) return setError('Choose a category or a type to set.');

    setBusy(true);
    setError(null);
    try {
      const saved = rule ? await api.rules.update(rule.id, input) : await api.rules.create(input);
      void qc.invalidateQueries({ queryKey: keys.rules });
      if (applyExisting) {
        const n = await api.transactions.applyRuleRetroactively(saved);
        invalidateFinancialData(qc);
        setResult(
          n === 0
            ? 'Rule saved. No existing transactions needed changes.'
            : `Rule saved and applied to ${n} transaction${n === 1 ? '' : 's'}.`,
        );
      } else {
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {result ? (
        <div className="flex flex-col gap-4">
          <StatusNote tone="good">{result}</StatusNote>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">
              When a transaction…
            </legend>
            <div className="grid grid-cols-[9rem_1fr] gap-2">
              <Select
                aria-label="Name match"
                value={form.nameOperator ?? 'contains'}
                onChange={(e) => set('nameOperator', e.target.value as RuleInput['nameOperator'])}
              >
                <option value="contains">name contains</option>
                <option value="equals">name equals</option>
                <option value="starts_with">name starts with</option>
              </Select>
              <Input
                aria-label="Name text"
                placeholder="e.g. Netflix"
                value={form.nameValue ?? ''}
                onChange={(e) => set('nameValue', e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Account" htmlFor="rule-account">
                <AccountSelect
                  id="rule-account"
                  accounts={accounts}
                  value={form.accountId}
                  onChange={(v) => set('accountId', v)}
                  noneLabel="Any account"
                />
              </Field>
              <Field label="Direction" htmlFor="rule-direction">
                <Select
                  id="rule-direction"
                  value={form.direction ?? ''}
                  onChange={(e) => set('direction', (e.target.value || null) as RuleInput['direction'])}
                >
                  <option value="">Money in or out</option>
                  <option value="outflow">Money out</option>
                  <option value="inflow">Money in</option>
                </Select>
              </Field>
              <Field label="Amount at least" htmlFor="rule-min">
                <Input
                  id="rule-min"
                  inputMode="decimal"
                  placeholder="Optional"
                  value={minText}
                  onChange={(e) => setMinText(e.target.value)}
                />
              </Field>
              <Field label="Amount at most" htmlFor="rule-max">
                <Input
                  id="rule-max"
                  inputMode="decimal"
                  placeholder="Optional"
                  value={maxText}
                  onChange={(e) => setMaxText(e.target.value)}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">Then…</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Set category" htmlFor="rule-category">
                <CategorySelect
                  id="rule-category"
                  categories={categories}
                  value={form.setCategoryId}
                  onChange={(v) => set('setCategoryId', v)}
                  noneLabel="Don’t change"
                />
              </Field>
              <Field label="Set type" htmlFor="rule-kind">
                <Select
                  id="rule-kind"
                  value={form.setKind ?? ''}
                  onChange={(e) => set('setKind', (e.target.value || null) as TransactionKind | null)}
                >
                  <option value="">Don’t change</option>
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                  <option value="transfer">Transfer (not spending)</option>
                </Select>
              </Field>
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Priority" htmlFor="rule-priority" hint="Lower runs first; first match wins.">
              <Input
                id="rule-priority"
                type="number"
                min={0}
                max={10000}
                value={form.priority}
                onChange={(e) => set('priority', Number(e.target.value) || 0)}
              />
            </Field>
            <label className="flex items-center gap-2.5 self-center text-sm text-ink">
              <Switch checked={form.isEnabled} onCheckedChange={(v) => set('isEnabled', v)} aria-label="Enabled" />
              Enabled
            </label>
          </div>

          <label className="flex items-start gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={applyExisting}
              onChange={(e) => setApplyExisting(e.target.checked)}
            />
            <span>
              Also apply to existing transactions
              <span className="block text-xs text-ink-3">Transactions you categorized yourself are left alone.</span>
            </span>
          </label>

          {error && <StatusNote tone="bad">{error}</StatusNote>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              Save rule
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
