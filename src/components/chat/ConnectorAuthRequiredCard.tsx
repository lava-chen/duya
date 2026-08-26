'use client';

/**
 * Connector re-authorization card (Plan 450 Phase B).
 *
 * Surfaces the `chat:connector_auth_required` SSE event from the agent
 * worker as a discrete UI card with a one-click re-authorization flow.
 * Mirrors codex's auth elicitation: the model is told the call failed,
 * the renderer draws the re-auth path, and the user clicks through the
 * existing OAuth loopback (Plan 312) without any new protocol.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/hooks/useTranslation';
import { getAppConnectionAPI } from '@/lib/app-connection-ipc';
import { ShieldIcon } from '@/components/icons';

export interface ConnectorAuthRequiredRequest {
  provider?: string;
  connectionId?: string;
  toolName?: string;
}

export interface ConnectorAuthRequiredCardProps {
  request: ConnectorAuthRequiredRequest;
  /** Clear the request from stream-session-manager after user dismisses it. */
  onDismiss: () => void;
  /** Clear + send a fresh user turn so the agent retries the failed call. */
  onRetry: () => void;
  /** Localize provider label when the registry is reachable. */
  resolveProviderLabel?: (providerId: string) => string;
}

export function ConnectorAuthRequiredCard({
  request,
  onDismiss,
  onRetry,
  resolveProviderLabel,
}: ConnectorAuthRequiredCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'idle' | 'connecting' | 'retrying'>('idle');
  const [error, setError] = useState<string | null>(null);

  const providerLabel = resolveProviderLabel
    ? resolveProviderLabel(request.provider ?? '')
    : request.provider ?? 'the connected app';

  const handleReauthorize = async () => {
    if (!request.provider) {
      onDismiss();
      return;
    }
    setBusy('connecting');
    setError(null);
    try {
      const api = getAppConnectionAPI();
      if (!api) {
        setError(t('connectorAuth.apiUnavailable'));
        setBusy('idle');
        return;
      }
      const result = await api.connect({ provider: request.provider as Parameters<typeof api.connect>[0]['provider'] });
      if (!result.success) {
        setError(result.error ?? t('connectorAuth.connectFailed'));
        setBusy('idle');
        return;
      }
      setBusy('retrying');
      // Hand off to the caller so it can clear the pending state and
      // re-issue the original tool call (auto-retry, Phase B3 hook).
      onRetry();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy('idle');
    }
  };

  const handleDismiss = () => {
    onDismiss();
  };

  return (
    <div className="rounded-lg border border-border/40 bg-[var(--surface)] px-4 py-3 my-2">
      <div className="flex items-center gap-2 mb-2">
        <ShieldIcon size={18} />
        <span className="font-medium text-sm text-foreground">
          {t('connectorAuth.title')}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        {t('connectorAuth.body', { provider: providerLabel, tool: request.toolName ?? '' })}
      </p>
      {error && (
        <p className="text-xs text-red-500 mb-3" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== 'idle'}
          onClick={handleDismiss}
        >
          {t('connectorAuth.dismiss')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== 'idle'}
          onClick={handleReauthorize}
        >
          {busy === 'connecting'
            ? t('connectorAuth.connecting')
            : busy === 'retrying'
              ? t('connectorAuth.retrying')
              : t('connectorAuth.reauthorize')}
        </Button>
      </div>
    </div>
  );
}