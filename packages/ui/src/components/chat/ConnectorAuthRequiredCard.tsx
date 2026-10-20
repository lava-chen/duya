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
 *
 * The card self-resolves the provider's display metadata (brand label,
 * icon, one-line description) from the `appConnection:providers` catalog
 * so the user can see exactly WHICH app is asking for access — a raw
 * provider id like `notion` is meaningless to most users. The fetch is
 * best-effort: when the catalog is unreachable the card falls back to
 * `resolveProviderLabel` / the raw provider id.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/hooks/useTranslation';
import { getAppConnectionAPI } from '@/lib/app-connection-ipc';
import type { AppConnectionProviderDTO } from '@/lib/app-connection-ipc';
import { ShieldIcon, ShieldCheckIcon } from '@/components/icons';
import { ConnectorIcon } from '@/components/extensions/connector-icons';

export interface ConnectorAuthRequiredRequest {
  provider?: string;
  connectionId?: string;
  toolName?: string;
  /**
   * Plan 503: 'connect' = bot-initiated first-time connect (connect_app
   * tool); 'reauth' = mid-call re-authorization (Plan 498, default).
   * Only the copy differs — the OAuth flow and resume are identical.
   */
  variant?: 'connect' | 'reauth';
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
  /** Optional label override when the provider catalog is unreachable. */
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
  const [providerMeta, setProviderMeta] = useState<AppConnectionProviderDTO | null>(null);
  const resumedRef = useRef(false);
  const isConnect = request.variant === 'connect';

  useEffect(() => {
    let cancelled = false;
    const provider = request.provider;
    if (!provider) return;
    const api = getAppConnectionAPI();
    if (!api?.providers) return;
    api
      .providers()
      .then((res) => {
        if (cancelled || !res.success || !res.data) return;
        setProviderMeta(res.data.find((p) => p.id === provider) ?? null);
      })
      .catch(() => {
        /* best-effort only — the card renders with the raw id */
      });
    return () => {
      cancelled = true;
    };
  }, [request.provider]);

  const providerLabel =
    providerMeta?.label ??
    (resolveProviderLabel ? resolveProviderLabel(request.provider ?? '') : undefined) ??
    request.provider ??
    t('connectorAuth.fallbackProvider');

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
  const connected = phase === 'connected';
  const title = isConnect
    ? t('connectorAuth.connectTitleNamed', { provider: providerLabel })
    : t('connectorAuth.reauthTitleNamed', { provider: providerLabel });
  const body = isConnect
    ? t('connectorAuth.connectBody', { provider: providerLabel })
    : t('connectorAuth.body', { provider: providerLabel, tool: request.toolName ?? '' });
  const showConfigHint =
    !connected && providerMeta?.configured === false && !!providerMeta.configurationHint;

  return (
    <div className="rounded-lg border border-border/40 bg-[var(--surface)] px-4 py-3.5 my-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/30 bg-[var(--bg-canvas)]"
        >
          {providerMeta ? (
            <ConnectorIcon
              provider={providerMeta.id}
              size={22}
              monogram={providerMeta.monogram}
              label={providerMeta.label}
            />
          ) : (
            <ShieldIcon size={18} className="text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="font-medium text-sm text-foreground">{title}</span>
          {providerMeta?.description && !connected && (
            <p
              className="mt-0.5 text-xs text-muted-foreground/80 line-clamp-1"
              title={providerMeta.description}
            >
              {providerMeta.description}
            </p>
          )}
          {connected ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-green-600" role="status">
              <ShieldCheckIcon size={14} className="shrink-0" />
              {t('connectorAuth.connected', { provider: providerLabel })}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          )}
          {error && (
            <p className="mt-2 text-xs text-red-500" role="alert">
              {error}
            </p>
          )}
          {showConfigHint && (
            <p className="mt-2 rounded-md border border-border/30 bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-muted-foreground">
              {providerMeta?.configurationHint}
            </p>
          )}
        </div>
      </div>
      {!connected && (
        <div className="mt-3 flex justify-end gap-2">
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
                : isConnect
                  ? t('connectorAuth.authorize')
                  : t('connectorAuth.reauthorize')}
          </Button>
        </div>
      )}
    </div>
  );
}
