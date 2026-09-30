import * as SwitchPrimitive from '@radix-ui/react-switch';
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-surface-3 transition-colors',
        'data-[state=checked]:bg-accent disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[1.05rem]" />
    </SwitchPrimitive.Root>
  );
}

const badgeTones = {
  neutral: 'bg-surface-2 text-ink-2',
  accent: 'bg-accent-wash text-accent',
  good: 'bg-good/12 text-good-ink',
  warn: 'bg-warn/18 text-warn-ink',
  bad: 'bg-bad/12 text-bad-ink',
  outline: 'border border-line text-ink-3',
} as const;

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-sm text-ink-3', className)}>
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function PageLoader() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon && <div className="mb-1 text-ink-3 [&_svg]:size-7">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-sm text-sm text-ink-3">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-card border border-bad/25 bg-bad/5 px-4 py-3 text-sm text-bad-ink"
    >
      <CircleAlert className="size-4 shrink-0" />
      <span className="flex-1">{error instanceof Error ? error.message : 'Something went wrong.'}</span>
      {onRetry && (
        <button type="button" className="font-medium underline underline-offset-2" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Status is never color alone: every status carries an icon and a label.
 */
export function StatusNote({
  tone,
  children,
  className,
}: {
  tone: 'good' | 'warn' | 'bad';
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === 'good' ? CircleCheck : tone === 'warn' ? TriangleAlert : CircleAlert;
  const styles = {
    good: 'border-good/25 bg-good/6 text-good-ink',
    warn: 'border-warn/40 bg-warn/10 text-warn-ink',
    bad: 'border-bad/25 bg-bad/6 text-bad-ink',
  }[tone];
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2.5 rounded-card border px-4 py-3 text-sm', styles, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex-1">{children}</div>
    </div>
  );
}

/** Budget-style meter. Fill color carries state; the track is a light wash. */
export function Meter({
  value,
  status = 'ok',
  className,
  label,
}: {
  /** 0..1+ (values over 1 fill completely) */
  value: number | null;
  status?: 'ok' | 'warning' | 'over' | 'none' | 'unbudgeted' | 'accent';
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(value ?? 0, 1)) * 100;
  const fill =
    status === 'over'
      ? 'bg-bad'
      : status === 'warning'
        ? 'bg-warn'
        : status === 'unbudgeted'
          ? 'bg-ink-3'
          : 'bg-accent';
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((value ?? 0) * 100)}
    >
      <div className={cn('h-full rounded-full transition-[width] duration-300', fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
