/**
 * Small PostgREST helpers for the service-role client.
 */
import type { ServiceClient } from './supabase.ts';

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

export function unwrap<T>(result: Result<T>, context: string): T {
  if (result.error) throw new Error(`${context}: ${result.error.code ?? ''} ${result.error.message}`);
  return result.data as T;
}

/** Fetch every row of a query in pages (PostgREST caps responses at 1000 rows). */
export async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<Result<T[]>>,
  context: string,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = unwrap(await build(from, from + pageSize - 1), context) ?? [];
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type { ServiceClient };
