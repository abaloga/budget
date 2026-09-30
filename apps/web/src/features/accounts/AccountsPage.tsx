import {
  accountDisplayName,
  accountSubtypeLabel,
  balanceTotals,
  creditUtilization,
  groupAccountsByInstitution,
  isLiability,
  type Account,
  type Connection,
} from '@budget/core';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Landmark, Pencil, RefreshCw, Unlink } from 'lucide-react';
import * as React from 'react';

import { StatTile } from '@/components/charts/charts';
import { PlaidLinkButton } from '@/components/PlaidLinkButton';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { ActionMenu } from '@/components/ui/menu';
import { Badge, EmptyState, ErrorState, PageHeader, PageLoader, StatusNote } from '@/components/ui/misc';
import { invalidateAll, keys, useAccounts, useConnections, useSync } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { cn, errorMessage, money, percent, relativeTime } from '@/lib/utils';

const STATUS: Record<Connection['status'], { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  active: { label: 'Connected', tone: 'good' },
  login_required: { label: 'Needs sign-in', tone: 'bad' },
  pending_expiration: { label: 'Reconnect soon', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

export default function AccountsPage() {
  const qc = useQueryClient();
  const connections = useConnections();
  const accounts = useAccounts();
  const sync = useSync();
  const [notice, setNotice] = React.useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Account | null>(null);
  const [disconnecting, setDisconnecting] = React.useState<Connection | null>(null);

  const groups = groupAccountsByInstitution(connections.data ?? [], accounts.data ?? [], { includeHidden: showHidden });
  const totals = balanceTotals(accounts.data ?? []);
  const hiddenCount = (accounts.data ?? []).filter((a) => a.isHidden).length;

  function runSync(connectionId?: string) {
    sync.mutate(connectionId, {
      onSuccess: ({ results }) => {
        const failed = results.filter((r) => r.status === 'failed');
        const added = results.reduce((n, r) => n + r.added, 0);
        setNotice(
          failed.length
            ? {
                tone: 'bad',
                text: `Sync failed for ${failed.length} connection${failed.length === 1 ? '' : 's'} (${failed[0]!.errorCode}).`,
              }
            : {
                tone: 'good',
                text: added
                  ? `Imported ${added} new transaction${added === 1 ? '' : 's'}.`
                  : 'Everything is up to date.',
              },
        );
      },
      onError: (e) => setNotice({ tone: 'bad', text: errorMessage(e) }),
    });
  }

  async function toggleHidden(a: Account) {
    await api.accounts.updateAccount(a.id, { isHidden: !a.isHidden });
    void qc.invalidateQueries({ queryKey: keys.accounts });
  }

  const onConnected = (name: string) =>
    setNotice({ tone: 'good', text: name ? `Connected ${name}. Importing transactions…` : 'Connection repaired.' });
  const onLinkError = (text: string) => setNotice({ tone: 'bad', text });

  return (
    <>
      <PageHeader
        title="Accounts"
        actions={
          <>
            {!!connections.data?.length && (
              <Button size="sm" onClick={() => runSync()} loading={sync.isPending && !sync.variables}>
                <RefreshCw /> Sync all
              </Button>
            )}
            <PlaidLinkButton size="sm" onConnected={onConnected} onError={onLinkError} />
          </>
        }
      />
      {notice && (
        <StatusNote tone={notice.tone} className="mb-4">
          {notice.text}
        </StatusNote>
      )}
      {(connections.error || accounts.error) && (
        <ErrorState error={connections.error ?? accounts.error} onRetry={() => invalidateAll(qc)} />
      )}

      {connections.isLoading || accounts.isLoading ? (
        <PageLoader />
      ) : !groups.length ? (
        <Card>
          <EmptyState
            icon={<Landmark />}
            title="Connect your bank and credit cards"
            description="Balances and transactions import automatically. Your bank login goes directly to Plaid — it’s never stored here."
            action={<PlaidLinkButton onConnected={onConnected} onError={onLinkError} />}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <StatTile label="Cash" value={money(totals.cashCents, { whole: true })} detail="checking & savings" />
            <StatTile
              label="Credit card balances"
              value={money(totals.creditOwedCents, { whole: true })}
              detail="currently owed"
            />
          </div>

          {groups.map(({ connection, accounts: list }) => {
            const status = STATUS[connection.status];
            const needsRepair = connection.status === 'login_required' || connection.status === 'pending_expiration';
            return (
              <Card key={connection.id} className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-sm font-semibold">{connection.institutionName}</h2>
                      <Badge tone={status.tone === 'neutral' ? 'neutral' : status.tone}>{status.label}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {connection.status === 'disconnected'
                        ? 'History kept · no longer syncing'
                        : `Last synced ${relativeTime(connection.lastSyncedAt)}`}
                    </p>
                  </div>
                  {connection.status !== 'disconnected' && (
                    <div className="flex items-center gap-1">
                      {needsRepair ? (
                        <PlaidLinkButton
                          size="sm"
                          connectionId={connection.id}
                          onConnected={onConnected}
                          onError={onLinkError}
                        />
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => runSync(connection.id)}
                          loading={sync.isPending && sync.variables === connection.id}
                        >
                          <RefreshCw /> Sync
                        </Button>
                      )}
                      <ActionMenu
                        items={[
                          {
                            label: 'Disconnect…',
                            icon: <Unlink />,
                            danger: true,
                            onSelect: () => setDisconnecting(connection),
                          },
                        ]}
                      />
                    </div>
                  )}
                </div>
                <ul className="divide-y divide-line">
                  {list.map((a) => {
                    const util = creditUtilization(a);
                    return (
                      <li
                        key={a.id}
                        className={cn('flex items-center gap-3 px-5 py-3', (a.isHidden || !a.isActive) && 'opacity-60')}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 truncate text-sm font-medium">
                            {accountDisplayName(a)}
                            {a.isHidden && <Badge tone="outline">Hidden</Badge>}
                          </p>
                          <p className="truncate text-xs text-ink-3">
                            {accountSubtypeLabel(a)}
                            {a.availableBalanceCents != null &&
                              a.type === 'depository' &&
                              ` · ${money(a.availableBalanceCents)} available`}
                            {a.type === 'credit' &&
                              a.availableBalanceCents != null &&
                              ` · ${money(a.availableBalanceCents)} available credit`}
                            {util != null && ` · ${percent(util)} used`}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="num text-sm font-semibold">
                            {a.currentBalanceCents == null ? '—' : money(a.currentBalanceCents)}
                          </p>
                          {isLiability(a.type) && <p className="text-xs text-ink-3">owed</p>}
                        </div>
                        <ActionMenu
                          items={[
                            { label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(a) },
                            {
                              label: a.isHidden ? 'Show account' : 'Hide account',
                              icon: a.isHidden ? <Eye /> : <EyeOff />,
                              onSelect: () => void toggleHidden(a),
                            },
                          ]}
                        />
                      </li>
                    );
                  })}
                  {list.length === 0 && <li className="px-5 py-3 text-sm text-ink-3">All accounts hidden.</li>}
                </ul>
              </Card>
            );
          })}
          {hiddenCount > 0 && (
            <Button variant="link" className="self-start" onClick={() => setShowHidden((v) => !v)}>
              {showHidden
                ? 'Hide hidden accounts'
                : `Show ${hiddenCount} hidden account${hiddenCount === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      )}

      <RenameDialog account={renaming} onClose={() => setRenaming(null)} />
      <DisconnectDialog
        connection={disconnecting}
        onClose={() => setDisconnecting(null)}
        onDone={(t) => setNotice({ tone: 'good', text: t })}
      />
    </>
  );
}

function RenameDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(account)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Rename account">
        {account && <RenameForm account={account} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ account, onClose }: { account: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(account.displayName ?? account.name);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await api.accounts.updateAccount(account.id, { displayName: name.trim() === account.name ? null : name });
    void qc.invalidateQueries({ queryKey: keys.accounts });
    onClose();
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field label="Display name" htmlFor="acct-name" hint={`Bank name: ${account.name}`}>
        <Input id="acct-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}

function DisconnectDialog({
  connection,
  onClose,
  onDone,
}: {
  connection: Connection | null;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [deleteData, setDeleteData] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const close = () => {
    setDeleteData(false);
    setError(null);
    onClose();
  };

  async function confirm() {
    if (!connection) return;
    setBusy(true);
    try {
      await api.plaid.disconnect(connection.id, deleteData);
      invalidateAll(qc);
      onDone(`${connection.institutionName} disconnected.`);
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(connection)} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={`Disconnect ${connection?.institutionName ?? ''}`}
        description="We’ll stop syncing and revoke access at Plaid."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={confirm}>
              Disconnect
            </Button>
          </>
        }
      >
        <fieldset className="flex flex-col gap-3 text-sm">
          <legend className="sr-only">What should happen to imported data?</legend>
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="disc"
              className="mt-0.5 accent-[var(--accent)]"
              checked={!deleteData}
              onChange={() => setDeleteData(false)}
            />
            <span>
              Keep history
              <span className="block text-xs text-ink-3">Past transactions stay in your budgets and reports.</span>
            </span>
          </label>
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="disc"
              className="mt-0.5 accent-[var(--accent)]"
              checked={deleteData}
              onChange={() => setDeleteData(true)}
            />
            <span>
              Delete accounts and transactions
              <span className="block text-xs text-ink-3">
                Permanently removes everything imported from this institution.
              </span>
            </span>
          </label>
          {error && <StatusNote tone="bad">{error}</StatusNote>}
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
