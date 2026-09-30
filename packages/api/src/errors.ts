/**
 * Normalized API errors with user-presentable messages.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface PostgrestLikeError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

const FRIENDLY: Record<string, string> = {
  '23503': 'This item is still in use and can’t be deleted. Archive it instead.',
  '23505': 'Something with that name already exists.',
  '42501': 'You don’t have permission to do that.',
  PGRST116: 'Not found.',
};

export function toApiError(err: PostgrestLikeError, fallback = 'Something went wrong.'): ApiError {
  const code = err.code ?? 'unknown';
  // Our own RAISE EXCEPTION messages (check_violation) are written for users.
  if (code === '23514' || code === 'P0001') return new ApiError(err.message, code, err);
  return new ApiError(FRIENDLY[code] ?? fallback, code, err);
}

type Result<T> = { data: T | null; error: PostgrestLikeError | null };

/** Unwrap a supabase-js result, throwing an ApiError on failure. */
export function unwrap<T>(result: Result<T>, fallback?: string): T {
  if (result.error) throw toApiError(result.error, fallback);
  return result.data as T;
}
