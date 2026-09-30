import {
  accountDisplayName,
  formatShortDate,
  goalProgress,
  parseMoneyInput,
  todayISO,
  type Account,
  type SavingsGoal,
} from '@budget/core';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Plus, Target, Trash } from 'lucide-react';
import * as React from 'react';

import { AccountSelect } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { ActionMenu } from '@/components/ui/menu';
import { Badge, EmptyState, ErrorState, Meter, PageHeader, PageLoader, StatusNote } from '@/components/ui/misc';
import { keys, useAccounts, useGoals } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { errorMessage, money, percent } from '@/lib/utils';

export default function GoalsPage() {
  const qc = useQueryClient();
  const goals = useGoals();
  const accounts = useAccounts();
  const [editing, setEditing] = React.useState<SavingsGoal | 'new' | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const list = (goals.data ?? []).filter((g) => g.isArchived === showArchived);
  const archivedCount = (goals.data ?? []).filter((g) => g.isArchived).length;

  async function act(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
      void qc.invalidateQueries({ queryKey: keys.goals });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Goals"
        description="Save toward the things that matter."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus /> New goal
          </Button>
        }
      />
      {error && (
        <StatusNote tone="bad" className="mb-4">
          {error}
        </StatusNote>
      )}
      {goals.error && <ErrorState error={goals.error} onRetry={() => void goals.refetch()} />}
      {goals.isLoading ? (
        <PageLoader />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Target />}
            title={showArchived ? 'No archived goals' : 'No goals yet'}
            description={showArchived ? undefined : 'Try an emergency fund, a vacation, or a down payment.'}
            action={
              !showArchived && (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Create a goal
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              account={accounts.data?.find((a) => a.id === g.accountId)}
              actions={[
                { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(g) },
                g.isArchived
                  ? {
                      label: 'Restore',
                      icon: <ArchiveRestore />,
                      onSelect: () => void act(() => api.goals.update(g.id, { isArchived: false })),
                    }
                  : {
                      label: 'Archive',
                      icon: <Archive />,
                      onSelect: () => void act(() => api.goals.update(g.id, { isArchived: true })),
                    },
                {
                  label: 'Delete',
                  icon: <Trash />,
                  danger: true,
                  onSelect: () => window.confirm(`Delete “${g.name}”?`) && void act(() => api.goals.remove(g.id)),
                },
              ]}
            />
          ))}
        </div>
      )}
      {archivedCount > 0 && (
        <Button variant="link" className="mt-4" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Show active goals' : `Show archived (${archivedCount})`}
        </Button>
      )}
      <GoalDialog
        goal={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        accounts={accounts.data ?? []}
        nextSortOrder={(goals.data?.length ?? 0) + 1}
      />
    </>
  );
}

export function GoalCard({
  goal,
  account,
  actions,
}: {
  goal: SavingsGoal;
  account?: Account;
  actions?: Parameters<typeof ActionMenu>[0]['items'];
}) {
  const p = goalProgress(goal, todayISO(), account?.currentBalanceCents);
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{goal.name}</h3>
          <p className="text-xs text-ink-3">
            {account ? `Tracks ${accountDisplayName(account)}` : 'Tracked manually'}
            {goal.targetDate && ` · by ${formatShortDate(goal.targetDate, new Date().getFullYear())}`}
          </p>
        </div>
        {actions && <ActionMenu items={actions} />}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-2xl font-semibold tracking-tight">{money(p.currentCents, { whole: true })}</p>
        <p className="text-sm text-ink-3">of {money(goal.targetCents, { whole: true })}</p>
      </div>
      <Meter value={p.percent} status={p.isComplete ? 'accent' : 'ok'} label={`${goal.name} progress`} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-ink-2">{percent(p.percent)} saved</span>
        {p.isComplete ? (
          <Badge tone="good">Goal reached</Badge>
        ) : p.monthlyNeededCents != null ? (
          <span className={p.isPastDue ? 'text-bad-ink' : 'text-ink-2'}>
            {p.isPastDue ? 'Past target date · ' : ''}
            {money(p.monthlyNeededCents, { whole: true })}/mo needed
          </span>
        ) : (
          <span className="text-ink-3">{money(p.remainingCents, { whole: true })} to go</span>
        )}
      </div>
    </Card>
  );
}

function GoalDialog({
  goal,
  open,
  onOpenChange,
  accounts,
  nextSortOrder,
}: {
  goal: SavingsGoal | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accounts: Account[];
  nextSortOrder: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={goal ? 'Edit goal' : 'New goal'}>
        <GoalForm goal={goal} accounts={accounts} nextSortOrder={nextSortOrder} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function GoalForm({
  goal,
  accounts,
  nextSortOrder,
  onClose,
}: {
  goal: SavingsGoal | null;
  accounts: Account[];
  nextSortOrder: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(goal?.name ?? '');
  const [target, setTarget] = React.useState(goal ? (goal.targetCents / 100).toFixed(2) : '');
  const [current, setCurrent] = React.useState(goal ? (goal.currentCents / 100).toFixed(2) : '');
  const [date, setDate] = React.useState(goal?.targetDate ?? '');
  const [accountId, setAccountId] = React.useState<string | null>(goal?.accountId ?? null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const targetCents = parseMoneyInput(target);
    const currentCents = current.trim() ? parseMoneyInput(current) : 0;
    if (!name.trim()) return setError('Give the goal a name.');
    if (!targetCents || targetCents <= 0) return setError('Enter a target amount.');
    if (currentCents === null || currentCents < 0) return setError('Enter the amount saved so far.');
    setBusy(true);
    try {
      const input = { name, targetCents, currentCents, targetDate: date || null, accountId };
      if (goal) await api.goals.update(goal.id, input);
      else await api.goals.create(input, nextSortOrder);
      void qc.invalidateQueries({ queryKey: keys.goals });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Name" htmlFor="goal-name">
        <Input
          id="goal-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Emergency fund"
          required
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Target amount" htmlFor="goal-target">
          <Input
            id="goal-target"
            inputMode="decimal"
            className="num"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
          />
        </Field>
        <Field label="Target date" htmlFor="goal-date" hint="Optional">
          <Input id="goal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field
        label="Linked account"
        htmlFor="goal-account"
        hint="Optional: use a savings account’s balance as progress."
      >
        <AccountSelect
          id="goal-account"
          accounts={accounts.filter((a) => a.type === 'depository')}
          value={accountId}
          onChange={setAccountId}
          noneLabel="Track manually"
        />
      </Field>
      {!accountId && (
        <Field label="Saved so far" htmlFor="goal-current">
          <Input
            id="goal-current"
            inputMode="decimal"
            className="num"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
      )}
      {error && <StatusNote tone="bad">{error}</StatusNote>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save goal
        </Button>
      </div>
    </form>
  );
}
