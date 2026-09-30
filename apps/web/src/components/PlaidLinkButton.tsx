import { useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';

import { Button, type ButtonProps } from '@/components/ui/button';
import { invalidateAll } from '@/hooks/queries';
import { api } from '@/lib/supabase';
import { errorMessage } from '@/lib/utils';

const TOKEN_KEY = 'plaid_link_token';

interface Props extends Omit<ButtonProps, 'onClick' | 'onError'> {
  /** Update mode: re-authenticate an existing connection. */
  connectionId?: string;
  onConnected?: (institution: string) => void;
  onError?: (message: string) => void;
}

/**
 * Opens Plaid Link. The link token comes from the `plaid` edge function; the
 * resulting public token goes straight back to it for exchange, so no Plaid
 * secret or access token ever reaches the browser.
 */
export function PlaidLinkButton({ connectionId, onConnected, onError, children, ...buttonProps }: Props) {
  const qc = useQueryClient();
  const [token, setToken] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onSuccess = React.useCallback<PlaidLinkOnSuccess>(
    async (publicToken) => {
      try {
        setBusy(true);
        if (connectionId) {
          // Update mode: the Item is repaired; just sync it.
          await api.plaid.sync(connectionId);
          onConnected?.('');
        } else if (publicToken) {
          const res = await api.plaid.exchangePublicToken(publicToken);
          onConnected?.(res.institution_name);
        }
      } catch (err) {
        onError?.(errorMessage(err));
      } finally {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setBusy(false);
        invalidateAll(qc);
      }
    },
    [connectionId, onConnected, onError, qc],
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    onExit: (err) => {
      setToken(null);
      setBusy(false);
      if (err?.display_message) onError?.(err.display_message);
    },
  });

  React.useEffect(() => {
    if (token && ready) open();
  }, [token, ready, open]);

  async function start() {
    try {
      setBusy(true);
      const res = await api.plaid.createLinkToken(connectionId);
      // Kept for the OAuth redirect return trip (see PlaidOAuthReturn).
      sessionStorage.setItem(TOKEN_KEY, res.link_token);
      setToken(res.link_token);
    } catch (err) {
      setBusy(false);
      onError?.(errorMessage(err));
    }
  }

  return (
    <Button variant={connectionId ? 'secondary' : 'primary'} onClick={start} loading={busy} {...buttonProps}>
      {!busy && (connectionId ? <RefreshCw /> : <Plus />)}
      {children ?? (connectionId ? 'Reconnect' : 'Connect account')}
    </Button>
  );
}

/**
 * Route for institutions that use OAuth: Plaid redirects back here and Link
 * must be re-opened with the same token plus the redirect URI.
 */
export function PlaidOAuthReturn({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const token = typeof window !== 'undefined' ? sessionStorage.getItem(TOKEN_KEY) : null;
  const { open, ready } = usePlaidLink({
    token,
    receivedRedirectUri: window.location.href,
    onSuccess: async (publicToken) => {
      try {
        if (publicToken) await api.plaid.exchangePublicToken(publicToken);
      } finally {
        sessionStorage.removeItem(TOKEN_KEY);
        invalidateAll(qc);
        onDone();
      }
    },
    onExit: () => {
      sessionStorage.removeItem(TOKEN_KEY);
      onDone();
    },
  });
  React.useEffect(() => {
    if (!token) onDone();
    else if (ready) open();
  }, [token, ready, open, onDone]);
  return null;
}
