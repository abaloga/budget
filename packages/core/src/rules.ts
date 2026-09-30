/**
 * Categorization rules: "if the name contains Netflix, set category to
 * Subscriptions". All present conditions must match. Rules run in priority
 * order (lower first, then oldest first) and the first match wins.
 */
import { formatMoney } from './money.ts';
import type { CategorizationRule, Cents, CategorySource, KindSource, TransactionKind } from './types.ts';

/** The fields a rule can look at. */
export interface RuleSubject {
  name: string;
  originalName: string;
  originalMerchantName: string | null;
  merchantKey: string;
  accountId: string | null;
  amountCents: Cents;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function nameCandidates(tx: RuleSubject): string[] {
  const out = [tx.name, tx.originalName, tx.merchantKey];
  if (tx.originalMerchantName) out.push(tx.originalMerchantName);
  return out.map(normalizeText);
}

export function ruleMatches(rule: CategorizationRule, tx: RuleSubject): boolean {
  if (!rule.isEnabled) return false;

  if (rule.nameOperator && rule.nameValue) {
    const needle = normalizeText(rule.nameValue);
    const candidates = nameCandidates(tx);
    const hit = candidates.some((c) => {
      switch (rule.nameOperator) {
        case 'equals':
          return c === needle;
        case 'starts_with':
          return c.startsWith(needle);
        case 'contains':
        default:
          return c.includes(needle);
      }
    });
    if (!hit) return false;
  }

  if (rule.accountId && rule.accountId !== tx.accountId) return false;

  if (rule.direction === 'inflow' && tx.amountCents <= 0) return false;
  if (rule.direction === 'outflow' && tx.amountCents >= 0) return false;

  const magnitude = Math.abs(tx.amountCents);
  if (rule.amountMinCents !== null && magnitude < rule.amountMinCents) return false;
  if (rule.amountMaxCents !== null && magnitude > rule.amountMaxCents) return false;

  return true;
}

export function sortRules(rules: readonly CategorizationRule[]): CategorizationRule[] {
  return [...rules].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function findMatchingRule(rules: readonly CategorizationRule[], tx: RuleSubject): CategorizationRule | null {
  for (const rule of sortRules(rules)) {
    if (ruleMatches(rule, tx)) return rule;
  }
  return null;
}

export interface RetroactiveSubject extends RuleSubject {
  id: string;
  categoryId: string | null;
  categorySource: CategorySource;
  kind: TransactionKind;
  kindSource: KindSource;
}

export interface RetroactiveUpdate {
  id: string;
  categoryId?: string | null;
  categorySource?: CategorySource;
  kind?: TransactionKind;
  kindSource?: KindSource;
}

/**
 * Updates needed to apply a rule to existing transactions. Explicit user
 * choices are respected: a manually chosen category or kind is never
 * overwritten by a rule.
 */
export function planRetroactiveRule(
  rule: CategorizationRule,
  transactions: readonly RetroactiveSubject[],
): RetroactiveUpdate[] {
  const updates: RetroactiveUpdate[] = [];
  for (const tx of transactions) {
    if (!ruleMatches({ ...rule, isEnabled: true }, tx)) continue;
    const update: RetroactiveUpdate = { id: tx.id };
    if (rule.setCategoryId && tx.categorySource !== 'user' && tx.categoryId !== rule.setCategoryId) {
      update.categoryId = rule.setCategoryId;
      update.categorySource = 'rule';
    }
    if (rule.setKind && tx.kindSource !== 'user' && tx.kind !== rule.setKind) {
      update.kind = rule.setKind;
      update.kindSource = 'rule';
    }
    if (Object.keys(update).length > 1) updates.push(update);
  }
  return updates;
}

/** Human-readable summary, e.g. `Name contains "netflix" · outflow`. */
export function describeRuleConditions(
  rule: Pick<CategorizationRule, 'nameOperator' | 'nameValue' | 'direction' | 'amountMinCents' | 'amountMaxCents'>,
  accountName?: string | null,
): string {
  const parts: string[] = [];
  if (rule.nameOperator && rule.nameValue) {
    const op = rule.nameOperator === 'starts_with' ? 'starts with' : rule.nameOperator;
    parts.push(`Name ${op} "${rule.nameValue}"`);
  }
  if (accountName) parts.push(`account is ${accountName}`);
  if (rule.direction) parts.push(rule.direction === 'inflow' ? 'money in' : 'money out');
  if (rule.amountMinCents !== null || rule.amountMaxCents !== null) {
    const fmt = (c: number) => formatMoney(c);
    if (rule.amountMinCents !== null && rule.amountMaxCents !== null)
      parts.push(`amount ${fmt(rule.amountMinCents)}–${fmt(rule.amountMaxCents)}`);
    else if (rule.amountMinCents !== null) parts.push(`amount ≥ ${fmt(rule.amountMinCents)}`);
    else if (rule.amountMaxCents !== null) parts.push(`amount ≤ ${fmt(rule.amountMaxCents)}`);
  }
  return parts.join(' · ');
}
