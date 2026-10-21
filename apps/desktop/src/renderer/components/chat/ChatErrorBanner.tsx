import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AlertIcon,
  ArrowClockwiseIcon,
  CopyIcon,
  InfoIcon,
  XIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/ui/toast';
import type { StreamingError } from '@/lib/stream-session-manager';

/** Render an inline error banner above the chat composer. Mirrors the
 *  ZCode ChatErrorBanner capability set: single-line truncated message,
 *  optional details dialog (verbose stack/cause), copy error (including
 *  traceId), retry, dismiss, and special branches for rate limit / usage
 *  limit / provider safety filter. */
export interface ChatErrorBannerProps {
  error: StreamingError | null;
  /** Triggered when the user clicks "Retry". */
  onRetry?: () => void;
  /** Called when the user dismisses the banner. The banner stays hidden
   *  until a new error arrives from upstream. */
  onDismiss?: () => void;
  /** Render compactly — used when the banner sits in a narrower zone
   *  (e.g. above the workspace composer). */
  variant?: 'default' | 'compact';
}

/** Tailored titles for the well-known provider error codes. */
function describeErrorCode(code: string | null | undefined): string | null {
  switch (code) {
    case 'rate_limit_error':
      return 'Rate limit hit';
    case 'usage_limit_exceeded':
      return 'Usage limit reached';
    case 'provider_safety_filter':
      return 'Safety filter stopped the response';
    case 'authentication_failed':
      return 'Authentication failed';
    case 'context_length_exceeded':
      return 'Conversation too long';
    case 'network_unavailable':
      return 'Network unavailable';
    default:
      return null;
  }
}

/** Some upstream errors carry stack/cause in `detail` but not in `message`.
 *  Fall back to detail when message looks like raw noise (only punctuation,
 *  or extremely short). */
function pickDisplayMessage(error: StreamingError): string {
  const message = error.message?.trim();
  if (message && message.length >= 4 && /[a-zA-Z\u4e00-\u9fff]/.test(message)) {
    return message;
  }
  if (error.detail && error.detail.trim().length > 0) {
    return error.detail.trim();
  }
  return 'The agent process encountered an error. You can retry with the same session.';
}

/** Generate a short client-side trace id when the upstream didn't provide
 *  one. Helps users reference this exact failure in support tickets. */
function ensureTraceId(error: StreamingError): string {
  if (error.traceId && error.traceId.length > 0) return error.traceId;
  // crypto.randomUUID is available in Electron renderer. Fall back to a
  // timestamped suffix when unavailable (very old runtimes).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `local-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `local-${Date.now().toString(36)}`;
}

export function ChatErrorBanner({ error, onRetry, onDismiss, variant = 'default' }: ChatErrorBannerProps) {
  const { t } = useTranslation();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const errorKey = useMemo(() => {
    if (!error) return null;
    return `${error.code ?? 'unknown'}::${error.message}::${error.traceId ?? ''}`;
  }, [error]);

  // When upstream replaces the error, the banner reappears. When the
  // same error is repeated, we honor the prior dismissal until the key
  // changes (i.e. a new error event arrived).
  useEffect(() => {
    if (!errorKey) setDismissedKey(null);
  }, [errorKey]);

  if (!error || dismissedKey === errorKey) return null;

  const handleDismiss = useCallback(() => {
    setDismissedKey(errorKey);
    setDetailsOpen(false);
    onDismiss?.();
  }, [errorKey, onDismiss]);

  const displayMessage = pickDisplayMessage(error);
  const codeTitle = describeErrorCode(error.code);
  const title = codeTitle ?? 'Agent error';
  const traceId = ensureTraceId(error);
  const hasDetail =
    (typeof error.detail === 'string' && error.detail.trim().length > 0) ||
    (typeof error.taskId === 'string' && error.taskId.length > 0) ||
    Boolean(traceId);

  const handleCopy = useCallback(async () => {
    const parts = [title, displayMessage];
    if (error.code) parts.push(`code: ${error.code}`);
    if (traceId) parts.push(`traceId: ${traceId}`);
    if (error.taskId) parts.push(`taskId: ${error.taskId}`);
    if (error.detail && error.detail.trim().length > 0) {
      parts.push('---', error.detail.trim());
    }
    const text = parts.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Error copied to clipboard');
    } catch {
      toast.error('Copy failed: clipboard unavailable');
    }
  }, [title, displayMessage, error.code, error.detail, error.taskId, traceId]);

  const wrapperClass = [
    'chat-error-banner',
    `chat-error-banner--${variant}`,
    error.code ? `chat-error-banner--${error.code}` : 'chat-error-banner--generic',
  ].join(' ');

  return (
    <>
      <div className={wrapperClass} role="alert" aria-live="polite">
        <div className="chat-error-banner__icon" aria-hidden="true">
          <AlertIcon size={16} />
        </div>
        <div className="chat-error-banner__body">
          <div className="chat-error-banner__title">{title}</div>
          <div className="chat-error-banner__message" title={displayMessage}>
            {displayMessage}
          </div>
        </div>
        <div className="chat-error-banner__actions">
          {hasDetail ? (
            <button
              type="button"
              className="chat-error-banner__btn"
              onClick={() => setDetailsOpen(true)}
              title={t('chat.errorBanner.showDetails') ?? 'Show details'}
            >
              <InfoIcon size={14} />
              <span className="chat-error-banner__btn-label">
                {t('chat.errorBanner.showDetails') ?? 'Details'}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="chat-error-banner__btn"
            onClick={() => {
              void handleCopy();
            }}
            title={t('chat.errorBanner.copyError') ?? 'Copy error'}
            aria-label={t('chat.errorBanner.copyError') ?? 'Copy error'}
          >
            <CopyIcon size={14} />
          </button>
          {onRetry ? (
            <button
              type="button"
              className="chat-error-banner__btn chat-error-banner__btn--primary"
              onClick={onRetry}
              title={t('chat.errorBanner.retry') ?? 'Retry'}
            >
              <ArrowClockwiseIcon size={14} />
              <span className="chat-error-banner__btn-label">
                {t('chat.errorBanner.retry') ?? 'Retry'}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="chat-error-banner__btn chat-error-banner__btn--close"
            onClick={handleDismiss}
            aria-label={t('chat.errorBanner.dismiss') ?? 'Dismiss error banner'}
            title={t('chat.errorBanner.dismiss') ?? 'Dismiss'}
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>
      {detailsOpen ? (
        <div
          className="chat-error-banner__overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('chat.errorBanner.detailsTitle') ?? 'Error details'}
          onClick={(event) => {
            if (event.target === event.currentTarget) setDetailsOpen(false);
          }}
        >
          <div className="chat-error-banner__panel">
            <div className="chat-error-banner__panel-head">
              <div className="chat-error-banner__panel-title">
                {t('chat.errorBanner.detailsTitle') ?? 'Error details'}
              </div>
              <button
                type="button"
                className="chat-error-banner__btn chat-error-banner__btn--close"
                onClick={() => setDetailsOpen(false)}
                aria-label={t('chat.errorBanner.dismiss') ?? 'Close'}
              >
                <XIcon size={14} />
              </button>
            </div>
            <dl className="chat-error-banner__panel-meta">
              {error.code ? (
                <>
                  <dt>code</dt>
                  <dd>{error.code}</dd>
                </>
              ) : null}
              {traceId ? (
                <>
                  <dt>traceId</dt>
                  <dd>{traceId}</dd>
                </>
              ) : null}
              {error.taskId ? (
                <>
                  <dt>taskId</dt>
                  <dd>{error.taskId}</dd>
                </>
              ) : null}
            </dl>
            <div className="chat-error-banner__panel-scroll">
              <pre className="chat-error-banner__panel-detail">
                {error.detail && error.detail.trim().length > 0
                  ? error.detail
                  : displayMessage}
              </pre>
            </div>
            <div className="chat-error-banner__panel-foot">
              <button
                type="button"
                className="chat-error-banner__btn"
                onClick={() => {
                  void handleCopy();
                }}
              >
                <CopyIcon size={14} />
                <span className="chat-error-banner__btn-label">
                  {t('chat.errorBanner.copyError') ?? 'Copy error'}
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}