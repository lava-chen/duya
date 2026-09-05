'use client';

/**
 * Connector re-authorization card (Plan 450 Phase B / Plan 498 state machine).
 *
 * Surfaces the `chat:connector_auth_required` SSE event from the agent
 * worker as a discrete UI card with a one-click re-authorization flow.
 * Mirrors codex's auth elicitation: the model is told the call failed,
 * the renderer draws the re-auth path, and the user clicks through the
 * existing OAuth loopback (Plan 312) without any new protocol.
 *
 * State machine (Plan 498, grok-bot connector-card parity):
 *   waiting ──Authorize──▶ connecting ──connect resolves──▶ connected
 *      ▲                      │                              (onRetry once)
 *      │                      └──failure──▶ failed ──Retry──▶ connecting
 *   The `authCompleted` prop (main's `app-connection:connected` broadcast)
 *   drives the same connected transition, covering a re-auth started from
 *   the settings page while this card was pending.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * Plan 498: true once main broadcasts `app-connection:connected` for the
   * pending provider. Moves the card to its real "connected" state and
   * fires `onRetry` exactly once.
   */
  authCompleted?: boolean;
  /** Clear the request from stream-session-manager after user dismisses it. */
  onDismiss: () => void;
  /** Fired once when the card reaches the connected state. */
  onRetry: () => void;
  /** Localize provider label when the registry is reachable. */
  resolveProviderLabel?: (providerId: string) => string;
}

type CardPhase = 'waiting' | 'connecting' | 'connected' | 'failed';

export function ConnectorAuthRequiredCard({
  request,
  authCompleted,
  onDismiss,
  onRetry,
  resolveProviderLabel,
}: ConnectorAuthRequiredCardProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<CardPhase>('waiting');
  const [error, setError] = useState<string | null>(null);
  const resumedRef = useRef(false);

  const providerLabel = resolveProviderLabel
    ? resolveProviderLabel(request.provider ?? '')
    : request.provider ?? 'the connected app';

  const finishConnected = useCallback(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    setError(null);
    setPhase('connected');
    onRetry();
  }, [onRetry]);

  useEffect(() => {
    if (authCompleted) finishConnected();
  }, [authCompleted, finishConnected]);

  const handleReauthorize = async () => {
    if (!request.provider) {
      onDismiss();
      return;
    }
    setPhase('connecting');
    setError(null);
    try {
      const api = getAppConnectionAPI();
      if (!api) {
        setError(t('connectorAuth.apiUnavailable'));
        setPhase('failed');
        return;
      }
      const result = await api.connect({ provider: request.provider as Parameters<typeof api.connect>[0]['provider'] });
      if (!result.success) {
        setError(result.error ?? t('connectorAuth.connectFailed'));
        setPhase('failed');
        return;
      }
      finishConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  };

  const handleDismiss = () => {
    onDismiss();
  };

  const busy = phase === 'connecting';

  return (
    <div className="rounded-lg border border-border/40 bg-[var(--surface)] px-4 py-3 my-2">
      <div className="flex items-center gap-2 mb-2">
        <ShieldIcon size={18} />
        <span className="font-medium text-sm text-foreground">
          {t('connectorAuth.title')}
        </span>
      </div>
      {phase === 'connected' ? (
        <p className="text-sm text-green-600 mb-1" role="status">
          {t('connectorAuth.connected', { provider: providerLabel })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground mb-3">
          {t('connectorAuth.body', { provider: providerLabel, tool: request.toolName ?? '' })}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500 mb-3" role="alert">
          {error}
        </p>
      )}
      {phase !== 'connected' && (
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={handleDismiss}
          >
            {t('connectorAuth.dismiss')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={handleReauthorize}
          >
            {busy
              ? t('connectorAuth.connecting')
              : phase === 'failed'
                ? t('connectorAuth.retry')
                : t('connectorAuth.reauthorize')}
          </Button>
        </div>
      )}
    </div>
  );
}
