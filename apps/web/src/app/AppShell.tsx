import {
  ArrowLeftRight,
  ChartColumn,
  Landmark,
  LayoutDashboard,
  Menu,
  PiggyBank,
  Repeat,
  Settings,
  Target,
  X,
} from 'lucide-react';
import * as React from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { to: '/budget', label: 'Budget', icon: PiggyBank },
  { to: '/recurring', label: 'Recurring', icon: Repeat },
  { to: '/goals', label: 'Goals', icon: Target },
  { to: '/reports', label: 'Reports', icon: ChartColumn },
  { to: '/accounts', label: 'Accounts', icon: Landmark },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, ...rest }) => (
        <NavLink
          key={to}
          to={to}
          end={'end' in rest}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-accent-wash text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )
          }
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="text-base font-semibold tracking-tight">Budget</span>
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = React.useState(false);
  const { pathname } = useLocation();
  // Close the mobile menu whenever the route changes (including back/forward).
  const [menuPath, setMenuPath] = React.useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    if (open) setOpen(false);
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-surface focus:p-2"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line bg-surface px-3 py-5 lg:flex">
        <Brand />
        <NavItems />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur lg:hidden">
        <Brand />
        <button
          type="button"
          className="rounded-control p-2 text-ink-2 hover:bg-surface-2"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </header>
      {open && (
        <div className="fixed inset-x-0 top-[3.3rem] bottom-0 z-20 bg-surface px-3 py-4 lg:hidden">
          <NavItems onNavigate={() => setOpen(false)} />
        </div>
      )}

      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
