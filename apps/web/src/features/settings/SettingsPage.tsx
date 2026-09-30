import {
  accountDisplayName,
  describeRuleConditions,
  monthStart,
  todayISO,
  type CategorizationRule,
  type Category,
  type CategoryKind,
} from '@budget/core';
import * as Tabs from '@radix-ui/react-tabs';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus, Repeat, Trash, WandSparkles } from 'lucide-react';
import * as React from 'react';

import { useAuth } from '@/auth/AuthProvider';
import { CategoryDot, groupCategories } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Segmented, Select } from '@/components/ui/form';
import { ActionMenu, type MenuItem } from '@/components/ui/menu';
import { Badge, EmptyState, PageHeader, PageLoader, StatusNote, Switch } from '@/components/ui/misc';
import { invalidateAll, invalidateFinancialData, keys, useAccounts, useCategories, useRules } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { cn, errorMessage, KIND_LABELS } from '@/lib/utils';

import { RuleDialog } from './RuleDialog';

const tabClass =
  'rounded-control px-3 py-1.5 text-sm font-medium text-ink-3 data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs.Root defaultValue="categories">
        <Tabs.List className="mb-5 inline-flex rounded-control bg-surface-2 p-0.5" aria-label="Settings sections">
          <Tabs.Trigger value="categories" className={tabClass}>
            Categories
          </Tabs.Trigger>
          <Tabs.Trigger value="rules" className={tabClass}>
            Rules
          </Tabs.Trigger>
          <Tabs.Trigger value="general" className={tabClass}>
            General
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="categories">
          <CategoriesSection />
        </Tabs.Content>
        <Tabs.Content value="rules">
          <RulesSection />
        </Tabs.Content>
        <Tabs.Content value="general">
          <GeneralSection />
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function CategoriesSection() {
  const qc = useQueryClient();
  const categories = useCategories();
  const [showArchived, setShowArchived] = React.useState(false);
  const [dialog, setDialog] = React.useState<CategoryDialogState | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (categories.isLoading || !categories.data) return <PageLoader />;
  const all = categories.data;
  const groups = groupCategories(all, { includeArchived: showArchived });

  async function act(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      void qc.invalidateQueries({ queryKey: keys.categories });
      invalidateFinancialData(qc);
    }
  }

  function move(c: Category, dir: -1 | 1) {
    const siblings = all
      .filter((x) => x.parentId === c.parentId && !x.isArchived)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const i = siblings.findIndex((x) => x.id === c.id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const ids = siblings.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void act(() => api.categories.reorder(ids));
  }

  function actions(c: Category, isTop: boolean): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Rename', icon: <Pencil />, onSelect: () => setDialog({ mode: 'rename', category: c }) },
    ];
    if (isTop && !c.isArchived)
      items.push({
        label: 'Add subcategory',
        icon: <Plus />,
        onSelect: () => setDialog({ mode: 'create', parentId: c.id }),
      });
    if (!c.isArchived) {
      items.push({ label: 'Move up', icon: <ArrowUp />, onSelect: () => move(c, -1) });
      items.push({ label: 'Move down', icon: <ArrowDown />, onSelect: () => move(c, 1) });
    }
    if (c.kind === 'expense')
      items.push({
        label: c.rolloverEnabled ? 'Turn off rollover' : 'Roll over unused budget',
        icon: <Repeat />,
        onSelect: () =>
          void act(() =>
            api.categories.update(c.id, {
              rolloverEnabled: !c.rolloverEnabled,
              ...(!c.rolloverEnabled && !c.rolloverStartMonth ? { rolloverStartMonth: monthStart(todayISO()) } : {}),
            }),
          ),
      });
    items.push(
      c.isArchived
        ? {
            label: 'Restore',
            icon: <ArchiveRestore />,
            onSelect: () => void act(() => api.categories.update(c.id, { isArchived: false })),
          }
        : {
            label: 'Archive',
            icon: <Archive />,
            onSelect: () => void act(() => api.categories.update(c.id, { isArchived: true })),
          },
    );
    items.push({
      label: 'Delete',
      icon: <Trash />,
      danger: true,
      onSelect: () => {
        if (window.confirm(`Delete “${c.name}”? Categories used by past transactions can only be archived.`))
          void act(() => api.categories.remove(c.id));
      },
    });
    return items;
  }

  const Row = ({ c, isTop }: { c: Category; isTop: boolean }) => (
    <li className={cn('flex items-center gap-3 py-2.5 pr-3', isTop ? 'pl-5' : 'pl-11', c.isArchived && 'opacity-60')}>
      <CategoryDot color={c.color} />
      <span className={cn('flex-1 truncate text-sm', isTop && 'font-medium')}>{c.name}</span>
      {c.kind === 'income' && <Badge tone="good">Income</Badge>}
      {c.rolloverEnabled && (
        <Badge tone="accent">
          <Repeat className="size-3" /> Rollover
        </Badge>
      )}
      {c.isArchived && <Badge tone="outline">Archived</Badge>}
      <ActionMenu items={actions(c, isTop)} label={`Actions for ${c.name}`} />
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      {error && <StatusNote tone="bad">{error}</StatusNote>}
      <Card className="overflow-hidden">
        <CardHeader
          title="Categories"
          description="Archive categories you no longer use — history keeps its categories."
          action={
            <Button size="sm" variant="primary" onClick={() => setDialog({ mode: 'create', parentId: null })}>
              <Plus /> New category
            </Button>
          }
        />
        <ul className="divide-y divide-line border-t border-line">
          {groups.map(({ top, children }) => (
            <React.Fragment key={top.id}>
              <Row c={top} isTop />
              {children.map((c) => (
                <Row key={c.id} c={c} isTop={false} />
              ))}
            </React.Fragment>
          ))}
        </ul>
      </Card>
      <label className="flex items-center gap-2.5 text-sm text-ink-2">
        <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Show archived categories" />
        Show archived categories
      </label>
      <CategoryDialog state={dialog} categories={all} onClose={() => setDialog(null)} onError={setError} />
    </div>
  );
}

type CategoryDialogState = { mode: 'create'; parentId: string | null } | { mode: 'rename'; category: Category };

function CategoryDialog({
  state,
  categories,
  onClose,
  onError,
}: {
  state: CategoryDialogState | null;
  categories: Category[];
  onClose: () => void;
  onError: (e: string) => void;
}) {
  return (
    <Dialog open={Boolean(state)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={state?.mode === 'rename' ? 'Rename category' : 'New category'}>
        {state && <CategoryForm state={state} categories={categories} onClose={onClose} onError={onError} />}
      </DialogContent>
    </Dialog>
  );
}

function CategoryForm({
  state,
  categories,
  onClose,
  onError,
}: {
  state: CategoryDialogState;
  categories: Category[];
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(state.mode === 'rename' ? state.category.name : '');
  const [kind, setKind] = React.useState<CategoryKind>(state.mode === 'rename' ? state.category.kind : 'expense');
  const [parentId, setParentId] = React.useState<string | null>(
    state.mode === 'create' ? state.parentId : state.category.parentId,
  );
  const [busy, setBusy] = React.useState(false);

  const parents = categories.filter(
    (c) => !c.parentId && !c.isArchived && (state.mode !== 'rename' || c.id !== state.category.id),
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (state.mode === 'rename') await api.categories.update(state.category.id, { name });
      else await api.categories.create({ name, parentId, kind }, categories);
      void qc.invalidateQueries({ queryKey: keys.categories });
      onClose();
    } catch (err) {
      onError(errorMessage(err));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Name" htmlFor="cat-name">
        <Input id="cat-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required autoFocus />
      </Field>
      {state.mode === 'create' && (
        <>
          <Field label="Inside group" htmlFor="cat-parent">
            <Select id="cat-parent" value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
              <option value="">None (top level)</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {!parentId && (
            <Segmented
              label="Kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'expense', label: 'Spending' },
                { value: 'income', label: 'Income' },
              ]}
            />
          )}
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function RulesSection() {
  const qc = useQueryClient();
  const rules = useRules();
  const categories = useCategories();
  const accounts = useAccounts();
  const [editing, setEditing] = React.useState<CategorizationRule | 'new' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      void qc.invalidateQueries({ queryKey: keys.rules });
    }
  }

  const categoryName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name;
  const accountName = (id: string | null) => {
    const a = accounts.data?.find((x) => x.id === id);
    return a ? accountDisplayName(a) : null;
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <StatusNote tone="bad">{error}</StatusNote>}
      <Card className="overflow-hidden">
        <CardHeader
          title="Categorization rules"
          description="Applied to new transactions first, then your past choices, then the bank’s category."
          action={
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              <Plus /> New rule
            </Button>
          }
        />
        {rules.isLoading ? (
          <PageLoader />
        ) : !rules.data?.length ? (
          <EmptyState
            icon={<WandSparkles />}
            title="No rules yet"
            description="Example: name contains “Netflix” → Subscriptions. You can also create a rule from any transaction."
          />
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {rules.data.map((r) => (
              <li key={r.id} className={cn('flex items-center gap-3 px-5 py-3', !r.isEnabled && 'opacity-60')}>
                <Switch
                  checked={r.isEnabled}
                  aria-label={r.isEnabled ? 'Disable rule' : 'Enable rule'}
                  onCheckedChange={(v) => void act(() => api.rules.update(r.id, { isEnabled: v }))}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{describeRuleConditions(r, accountName(r.accountId))}</p>
                  <p className="truncate text-xs text-ink-3">
                    →{' '}
                    {[
                      r.setCategoryId && categoryName(r.setCategoryId),
                      r.setKind && `mark as ${KIND_LABELS[r.setKind].toLowerCase()}`,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    {` · priority ${r.priority}`}
                  </p>
                </div>
                <ActionMenu
                  items={[
                    { label: 'Edit', icon: <Pencil />, onSelect: () => setEditing(r) },
                    {
                      label: 'Delete',
                      icon: <Trash />,
                      danger: true,
                      onSelect: () =>
                        window.confirm('Delete this rule? Past categorizations are kept.') &&
                        void act(() => api.rules.remove(r.id)),
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <RuleDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        rule={editing === 'new' ? null : editing}
        categories={categories.data ?? []}
        accounts={accounts.data ?? []}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function GeneralSection() {
  const qc = useQueryClient();
  const { session, signOut } = useAuth();
  const [theme, setTheme] = React.useState<Theme>(readTheme);
  const [scanning, setScanning] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  function applyTheme(t: Theme) {
    setTheme(t);
    try {
      if (t === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', t);
    } catch {
      // storage unavailable; still apply for this session
    }
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }

  async function rescan() {
    setScanning(true);
    try {
      await api.plaid.rescan();
      invalidateAll(qc);
      setNotice({ tone: 'good', text: 'Transfers and recurring bills re-detected.' });
    } catch (err) {
      setNotice({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader title="Appearance" />
        <CardBody>
          <Segmented
            label="Theme"
            value={theme}
            onChange={applyTheme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Automatic detection"
          description="Find transfers between your accounts and recurring bills across all history."
        />
        <CardBody className="flex flex-col gap-3">
          {notice && <StatusNote tone={notice.tone}>{notice.text}</StatusNote>}
          <Button className="self-start" onClick={rescan} loading={scanning}>
            Re-scan now
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Account" description={session?.user.email} />
        <CardBody>
          <Button onClick={() => void signOut()}>Sign out</Button>
        </CardBody>
      </Card>
    </div>
  );
}
