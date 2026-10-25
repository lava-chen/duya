'use client';

/**
 * The shared workspace-lifecycle panel (plan 621, slice F).
 *
 * ## What it answers, and for whom
 *
 * One panel, three surfaces. Desktop, TUI and Web each install their own
 * adapter for `WorkspaceLifecyclePort`, and this component reads through the
 * port without ever learning which transport answered. That is the whole
 * point of the port: a surface that rebuilt the session → checkout → PR
 * mapping itself would produce a second answer to the same question, and the
 * two would drift.
 *
 * ## The three answers that must not be folded together
 *
 *   1. "this session is not inside a managed checkout" — the Host said so;
 *   2. "this surface cannot observe checkouts" — the surface has no adapter,
 *      or the Host does not serve that namespace at all;
 *   3. "the Host could not answer" — the call failed.
 *
 * Folding them into one empty state is how a user ends up acting on a missing
 * observation, so each has its own line.
 *
 * ## Observations are not decisions
 *
 * Every value below is a point-in-time read of the Host's authority, and each
 * one is printed with the moment it was taken. The reclaim button does NOT
 * consult the observed `reclaimable` flag — it asks the Host to re-evaluate
 * every condition at the moment of the action, because the observed flag was
 * true (or false) some time ago and the working tree moves.
 *
 * A pull request whose observation failed is rendered as `unknown` with its
 * reason. It is never rendered as `open`: "we could not look" and "the PR is
 * open" are different facts, and only one of them is true.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckoutControls } from './CheckoutControls';
import { useWorkspaceLifecycle } from '@/hooks/useWorkspaceLifecycle';
import { useTranslation } from '@/hooks/useTranslation';
import type {
  HostCheckoutObserved,
  HostIntegrationRecord,
  HostSessionCheckoutView,
} from '@duya/agent-protocol';

export interface WorkspaceLifecyclePanelProps {
  /** The session whose checkout and pull requests are asked about. */
  readonly sessionId: string;
}

type LoadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly reason: string };

/**
 * The moment an observation was taken.
 *
 * UTC and ISO-shaped on purpose: an observation is evidence, and evidence
 * that is rendered in the reader's local time is easy to misread as "just
 * now" when it is not.
 */
function formatObservedAt(millis: number): string {
  if (!Number.isFinite(millis)) return 'unknown';
  return `${new Date(millis).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

export function WorkspaceLifecyclePanel({ sessionId }: WorkspaceLifecyclePanelProps) {
  const port = useWorkspaceLifecycle();
  const { t } = useTranslation();

  const [checkout, setCheckout] = useState<LoadState<HostSessionCheckoutView>>({ status: 'loading' });
  const [records, setRecords] = useState<LoadState<readonly HostIntegrationRecord[]>>({ status: 'loading' });
  const [busy, setBusy] = useState<'none' | 'refresh' | 'reclaim'>('none');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const checkoutPort = port?.checkouts;
    const integrationPort = port?.integrations;

    if (checkoutPort === undefined) {
      setCheckout({ status: 'ready', value: { sessionId, checkout: null, isOwner: false } });
    } else {
      try {
        setCheckout({ status: 'ready', value: await checkoutPort.observeForSession(sessionId) });
      } catch (error) {
        setCheckout({ status: 'error', reason: errorReason(error) });
      }
    }

    if (integrationPort === undefined) {
      setRecords({ status: 'ready', value: [] });
    } else {
      try {
        setRecords({ status: 'ready', value: await integrationPort.observeForSession(sessionId) });
      } catch (error) {
        setRecords({ status: 'error', reason: errorReason(error) });
      }
    }
  }, [port, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The explicit refresh. The read above never touches the network; this asks
   * the Host to re-read the pull requests now, and then reads them again.
   */
  const refresh = useCallback(async () => {
    const integrationPort = port?.integrations;
    if (integrationPort === undefined) return;
    setBusy('refresh');
    setNotice(null);
    try {
      const result = await integrationPort.refreshForSession(sessionId);
      setNotice(t('wsl.integrations.refreshed', { status: result.status }));
      await load();
    } catch (error) {
      setNotice(t('wsl.error', { reason: errorReason(error) }));
    } finally {
      setBusy('none');
    }
  }, [load, port, sessionId, t]);

  /**
   * Ask the Host to remove the checkout.
   *
   * A refusal is the normal answer, not a failure: the Host re-evaluates
   * every condition and may decline, and nothing is deleted when it does.
   */
  const reclaim = useCallback(async () => {
    const checkoutPort = port?.checkouts;
    if (checkoutPort === undefined || checkout.status !== 'ready') return;
    const observed = checkout.value.checkout;
    if (observed === null) return;

    setBusy('reclaim');
    setNotice(null);
    try {
      const result = await checkoutPort.requestReclaim(observed.root);
      setNotice(
        result.removed
          ? t('wsl.checkout.reclaimed')
          : t('wsl.checkout.reclaimRefused', { reason: result.reason }),
      );
      await load();
    } catch (error) {
      setNotice(t('wsl.error', { reason: errorReason(error) }));
    } finally {
      setBusy('none');
    }
  }, [checkout, load, port, t]);

  return (
    <section className="wsl-panel" aria-label={t('wsl.title')}>
      <header className="wsl-head">
        <span className="wsl-title">{t('wsl.title')}</span>
        {port?.integrations !== undefined ? (
          <button
            type="button"
            className="wsl-action"
            disabled={busy !== 'none'}
            onClick={() => {
              void refresh();
            }}
          >
            {busy === 'refresh' ? t('wsl.integrations.refreshing') : t('wsl.integrations.refresh')}
          </button>
        ) : null}
      </header>

      {notice !== null ? <p className="wsl-notice">{notice}</p> : null}
      {port?.checkouts?.control ? <CheckoutControls sessionId={sessionId} control={port.checkouts.control} onChange={load} /> : null}

      <section className="wsl-block" aria-label={t('wsl.checkout.section')}>
        <h3 className="wsl-block-title">{t('wsl.checkout.section')}</h3>

        {port === null ? (
          <p className="wsl-note">{t('wsl.checkout.cannotAnswer')}</p>
        ) : port.checkouts === undefined ? (
          <p className="wsl-note">{t('wsl.checkout.cannotAnswer')}</p>
        ) : checkout.status === 'loading' ? (
          <p className="wsl-note">{t('wsl.loading')}</p>
        ) : checkout.status === 'error' ? (
          <p className="wsl-note">{t('wsl.error', { reason: checkout.reason })}</p>
        ) : checkout.value.checkout === null ? (
          <p className="wsl-note">{t('wsl.checkout.none')}</p>
        ) : (
          <CheckoutFacts
            observed={checkout.value.checkout}
            isOwner={checkout.value.isOwner}
            onReclaim={() => {
              void reclaim();
            }}
            reclaiming={busy === 'reclaim'}
          />
        )}
      </section>

      <section className="wsl-block" aria-label={t('wsl.integrations.section')}>
        <h3 className="wsl-block-title">{t('wsl.integrations.section')}</h3>

        {port === null ? (
          <p className="wsl-note">{t('wsl.integrations.cannotAnswer')}</p>
        ) : port.integrations === undefined ? (
          <p className="wsl-note">{t('wsl.integrations.cannotAnswer')}</p>
        ) : records.status === 'loading' ? (
          <p className="wsl-note">{t('wsl.loading')}</p>
        ) : records.status === 'error' ? (
          <p className="wsl-note">{t('wsl.error', { reason: records.reason })}</p>
        ) : records.value.length === 0 ? (
          <p className="wsl-note">{t('wsl.integrations.empty')}</p>
        ) : (
          <ul className="wsl-prs">
            {records.value.map((record) => (
              <IntegrationRow key={`${record.repo}#${record.prNumber}`} record={record} />
            ))}
          </ul>
        )}

        <p className="wsl-footnote">{t('wsl.refresh.disclaimer')}</p>
      </section>
    </section>
  );
}

function CheckoutFacts({
  observed,
  isOwner,
  onReclaim,
  reclaiming,
}: {
  readonly observed: HostCheckoutObserved;
  readonly isOwner: boolean;
  readonly onReclaim: () => void;
  readonly reclaiming: boolean;
}) {
  const { t } = useTranslation();

  const owner = observed.ownerUnreadable
    ? t('wsl.checkout.ownerUnknown')
    : observed.ownerSessionId === null
      ? t('wsl.checkout.ownerNone')
      : isOwner
        ? t('wsl.checkout.ownerSelf')
        : t('wsl.checkout.ownerOther', { sessionId: observed.ownerSessionId });

  return (
    <>
      <dl className="wsl-facts">
        <dt>{t('wsl.checkout.root')}</dt>
        <dd className="wsl-path">{observed.root}</dd>

        <dt>{t('wsl.checkout.cwd')}</dt>
        <dd className="wsl-path">{observed.cwd}</dd>

        <dt>{t('wsl.checkout.registered')}</dt>
        <dd>{observed.registered ? t('wsl.yes') : t('wsl.no')}</dd>

        <dt>{t('wsl.checkout.worktree')}</dt>
        <dd>{observed.worktree}</dd>

        <dt>{t('wsl.checkout.owner')}</dt>
        <dd>{owner}</dd>

        <dt>{t('wsl.checkout.locked')}</dt>
        <dd>{observed.locked ? t('wsl.yes') : t('wsl.no')}</dd>

        <dt>{t('wsl.checkout.reclaim')}</dt>
        <dd>
          {observed.reclaimable
            ? t('wsl.checkout.reclaimable')
            : t('wsl.checkout.retained', { reason: observed.retainReason ?? 'unknown' })}
        </dd>

        <dt>{t('wsl.checkout.observedAt')}</dt>
        <dd>{formatObservedAt(observed.observedAt)}</dd>
      </dl>

      <button type="button" className="wsl-action" disabled={reclaiming} onClick={onReclaim}>
        {reclaiming ? t('wsl.checkout.reclaiming') : t('wsl.checkout.reclaimAction')}
      </button>
      <p className="wsl-footnote">{t('wsl.reclaim.disclaimer')}</p>
    </>
  );
}

function IntegrationRow({ record }: { readonly record: HostIntegrationRecord }) {
  const { t } = useTranslation();

  return (
    <li className="wsl-pr">
      <span className="wsl-pr-name">
        {record.repo}#{record.prNumber}
      </span>
      {/* `unknown` is rendered as `unknown`, with the reason. It is never
          rendered as `open`: the observation failed, and that is a different
          fact from the pull request being open. */}
      <span className={`wsl-pr-state is-${record.state}`}>{record.state}</span>
      {record.state === 'unknown' && record.observedError !== null ? (
        <span className="wsl-pr-reason">{t('wsl.integrations.unknown', { reason: record.observedError })}</span>
      ) : null}
      {record.url !== null ? (
        <a className="wsl-pr-url" href={record.url} target="_blank" rel="noreferrer">
          {record.url}
        </a>
      ) : null}
      <span className="wsl-pr-observed">{formatObservedAt(record.observedAt)}</span>
    </li>
  );
}
