import { parseMoneyInput, todayISO, type Account, type Category } from '@budget/core';
import * as React from 'react';

import { AccountSelect, CategorySelect } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Segmented, Textarea } from '@/components/ui/form';
import { StatusNote } from '@/components/ui/misc';
import { useFinancialMutation } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';

export function AddTransactionDialog({
  open,
  onOpenChange,
  categories,
  accounts,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  categories: Category[];
  accounts: Account[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add transaction" description="For cash or anything your bank didn’t import.">
        {/* Content unmounts when closed, so every open starts with a fresh form. */}
        <AddTransactionForm categories={categories} accounts={accounts} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddTransactionForm({
  categories,
  accounts,
  onDone,
}: {
  categories: Category[];
  accounts: Account[];
  onDone: () => void;
}) {
  const [direction, setDirection] = React.useState<'out' | 'in'>('out');
  const [name, setName] = React.useState('');
  const [date, setDate] = React.useState(todayISO());
  const [amount, setAmount] = React.useState('');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [categoryId, setCategoryId] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const create = useFinancialMutation(api.transactions.createManual);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = parseMoneyInput(amount);
    if (!name.trim()) return setError('Enter a name.');
    if (cents === null || cents === 0) return setError('Enter an amount like 12.50.');
    create.mutate(
      {
        name,
        date,
        amountCents: (direction === 'out' ? -1 : 1) * Math.abs(cents),
        accountId,
        categoryId,
        notes,
      },
      { onSuccess: onDone, onError: (err) => setError(errorMessage(err)) },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Segmented
        label="Direction"
        value={direction}
        onChange={setDirection}
        options={[
          { value: 'out', label: 'Money out' },
          { value: 'in', label: 'Money in' },
        ]}
      />
      <Field label="Name" htmlFor="add-name">
        <Input
          id="add-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Farmers market"
          required
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" htmlFor="add-amount">
          <Input
            id="add-amount"
            inputMode="decimal"
            className="num"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
          />
        </Field>
        <Field label="Date" htmlFor="add-date">
          <Input id="add-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
      </div>
      <Field label="Account" htmlFor="add-account">
        <AccountSelect
          id="add-account"
          accounts={accounts}
          value={accountId}
          onChange={setAccountId}
          noneLabel="Cash / no account"
        />
      </Field>
      <Field label="Category" htmlFor="add-category">
        <CategorySelect id="add-category" categories={categories} value={categoryId} onChange={setCategoryId} />
      </Field>
      <Field label="Notes" htmlFor="add-notes">
        <Textarea id="add-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {error && <StatusNote tone="bad">{error}</StatusNote>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Add transaction
        </Button>
      </div>
    </form>
  );
}
