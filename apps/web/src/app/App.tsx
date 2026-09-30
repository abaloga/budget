import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useNavigate } from 'react-router';

import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { SignInPage } from '@/auth/SignInPage';
import { PlaidOAuthReturn } from '@/components/PlaidLinkButton';
import { PageLoader } from '@/components/ui/misc';

import { AppShell } from './AppShell';

const DashboardPage = React.lazy(() => import('@/features/dashboard/DashboardPage'));
const TransactionsPage = React.lazy(() => import('@/features/transactions/TransactionsPage'));
const BudgetPage = React.lazy(() => import('@/features/budget/BudgetPage'));
const RecurringPage = React.lazy(() => import('@/features/recurring/RecurringPage'));
const GoalsPage = React.lazy(() => import('@/features/goals/GoalsPage'));
const ReportsPage = React.lazy(() => import('@/features/reports/ReportsPage'));
const AccountsPage = React.lazy(() => import('@/features/accounts/AccountsPage'));
const SettingsPage = React.lazy(() => import('@/features/settings/SettingsPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
  },
});

function RequireAuth() {
  const { session, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!session) return <SignInPage />;
  return <Outlet />;
}

function OAuthReturnRoute() {
  const navigate = useNavigate();
  return (
    <>
      <PageLoader />
      <PlaidOAuthReturn onDone={() => navigate('/accounts', { replace: true })} />
    </>
  );
}

const page = (el: React.ReactNode) => <React.Suspense fallback={<PageLoader />}>{el}</React.Suspense>;

const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [
      { path: '/plaid/oauth', element: <OAuthReturnRoute /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: page(<DashboardPage />) },
          { path: 'transactions', element: page(<TransactionsPage />) },
          { path: 'budget', element: page(<BudgetPage />) },
          { path: 'recurring', element: page(<RecurringPage />) },
          { path: 'goals', element: page(<GoalsPage />) },
          { path: 'reports', element: page(<ReportsPage />) },
          { path: 'accounts', element: page(<AccountsPage />) },
          { path: 'settings', element: page(<SettingsPage />) },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
