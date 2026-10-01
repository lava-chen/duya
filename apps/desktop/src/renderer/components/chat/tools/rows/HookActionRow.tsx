// HookActionRow — plan 437.
//
// Renders one row in the message flow for every plan-87 hook
// invocation. Mirrors the tool-use row UX:
//   - collapsed: [webhook icon] Hook  <eventName> · <hookName>   [duration]
//   - hover: caret animates in, right slot reveals matcher / async badge
//   - expanded: card showing the actual `additionalContext` returned to
//     the agent (or verifier diagnostic / async task id / error)
//
// All chrome is shared with `ActionRowChrome` so visual weight matches
// every other row. Status dot uses the same `StatusDot` mapping as
// tools: ok \u2192 success, error / timeout \u2192 error, skipped \u2192 success
// (the hook didn't actually run, so we keep the row quiet).

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { WebhookIcon } from '@/components/icons';
import { ActionRowChrome, StatusDot } from '../chrome/ActionRowChrome';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import type { HookAction } from '@/types/hooks';
import type { ToolStatus } from '../types';

interface HookActionRowProps {
  hook: HookAction;
}

/** Format ms \u2192 "1.2s" / "45ms" so the right slot stays compact. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Map a hook's coarse `status` field to the existing ToolStatus used by
 * `ActionRowChrome.StatusDot`. Skipped \u2192 success keeps the row quiet
 * (a circuit-breaker-open hook didn't actually run, so a red dot would
 * be misleading). Timeout / error collapse to the error variant so the
 * user notices a real failure.
 */
function hookStatusToToolStatus(status: HookAction['status']): ToolStatus {
  if (status === 'error' || status === 'timeout') return 'error';
  return 'success';
}

export function HookActionRow({ hook }: HookActionRowProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const toolStatus = hookStatusToToolStatus(hook.status);

  // The summary uses `<eventName> \u00b7 <hookName>`. hookName is already
  // truncated at the agent boundary (80 chars) so we render it verbatim.
  const summary = (
    <span className="truncate">
      <span className="text-muted-foreground/90">{hook.hookEventName}</span>
      <span className="text-muted-foreground/40 mx-1">\u00b7</span>
      <span
        className="font-mono"
        title={
          hook.matcher
            ? `${hook.hookName}  \u2014 matcher: ${hook.matcher}`
            : hook.hookName
        }
      >
        {hook.hookName}
      </span>
    </span>
  );

  // Right slot: matcher (when present) and async badge for async hooks.
  // Both are hidden on hover-free state so the collapsed chrome stays
  // clean, but always render the async badge so the user notices the
  // hook will keep running after the row closes.
  const rightSlot = (
    <span className="flex items-center gap-1.5 shrink-0">
      {hook.matcher ? (
        <span className="text-muted-foreground/40 text-[10px] font-mono hidden sm:inline">
          {hook.matcher}
        </span>
      ) : null}
      {hook.async ? (
        <span
          className="text-[10px] font-mono px-1 py-0.5 rounded text-amber-500 bg-amber-500/10"
          title={t('streaming.toolAction.hook.asyncHint')}
        >
          {t('streaming.toolAction.hook.async')}
        </span>
      ) : null}
    </span>
  );

  // The body content depends on which status fields are present:
  //   - additionalContext \u2192 render verbatim
  //   - verifier (exitCode !== 0) \u2192 render `[verify:<type>]` prefix
  //   - errorMessage \u2192 render red prefix (only when no context)
  //   - async (backgroundTaskId) \u2192 task id + async hint
  //   - nothing \u2192 "no output" placeholder
  const hasContext = typeof hook.additionalContext === 'string' && hook.additionalContext.length > 0;
  const hasError = !hasContext && typeof hook.errorMessage === 'string' && hook.errorMessage.length > 0;
  const isVerifier = hook.exitCode !== undefined && hook.exitCode !== 0;
  const showBody = hasContext || hasError || hook.status === 'skipped' || hook.status === 'timeout';

  // Fixed-height card: content scrolls inside instead of growing the row.
  const expandedBody = (
    <div className="mx-1 my-1 rounded-lg tool-card p-3 relative">
      <div className="h-32 overflow-y-auto pr-1">
      {hasContext ? (
        <pre className="text-xs text-foreground/85 whitespace-pre-wrap break-words font-mono leading-relaxed">
          {isVerifier ? (
            <span className="text-red-400/90 select-none mr-2">
              [{t('streaming.toolAction.hook.verifierPrefix')} {hook.hookType} \u00b7 exit {hook.exitCode}]
            </span>
          ) : null}
          {hook.additionalContext}
        </pre>
      ) : null}

      {!hasContext && hasError ? (
        <div className="text-xs text-red-400/90 font-mono leading-relaxed whitespace-pre-wrap break-words">
          {hook.status === 'timeout' ? (
            <span className="select-none mr-2">
              [{t('streaming.toolAction.hook.timeout')}]
            </span>
          ) : hook.status === 'skipped' ? (
            <span className="select-none mr-2">
              [{t('streaming.toolAction.hook.skipped')}]
            </span>
          ) : (
            <span className="select-none mr-2">
              [{t('streaming.toolAction.hook.errorPrefix')}]
            </span>
          )}
          {hook.errorMessage}
        </div>
      ) : null}

      {!hasContext && !hasError && hook.async && hook.backgroundTaskId ? (
        <div className="text-xs text-muted-foreground/80 leading-relaxed">
          <div className="font-mono text-amber-500/90 break-all">
            task:{hook.backgroundTaskId}
          </div>
          <div className="mt-1 text-muted-foreground/60">
            {t('streaming.toolAction.hook.asyncHint')}
          </div>
        </div>
      ) : null}
      </div>

      {/* Mirror the tool rows' corner badge so hook rows visually
          share the same chrome. */}
      <div className="absolute top-1.5 right-1.5">
        <StatusDot status={toolStatus} />
      </div>
    </div>
  );

  const canExpand = showBody || (hook.async && !!hook.backgroundTaskId);

  return (
    <div>
      <ActionRowChrome
        status={toolStatus}
        verbKey={'streaming.toolAction.hook.collapsed' as TranslationKey}
        icon={<WebhookIcon size={14} />}
        canExpand={canExpand}
        expanded={expanded}
        hovered={hovered}
        durationMs={hook.durationMs}
        onClick={() => canExpand && setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        buttonClassName={canExpand ? 'cursor-pointer' : 'cursor-default'}
        rightSlot={rightSlot}
      >
        {summary}
      </ActionRowChrome>

      <AnimatePresence initial={false}>
        {expanded && canExpand && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            {expandedBody}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Re-export the helper so tests don't reach back into the component body.
export { formatDuration as _formatDurationForTests };