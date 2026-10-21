/**
 * packages/cli/src/tui/slash/session-info.ts
 *
 * Read-only TUI commands: `/status`, `/usage`, `/context`, `/transcript`.
 *
 * These answer "what is happening right now" and never mutate the session,
 * so they are safe to type while a turn is streaming.
 *
 * Both the token numbers and the context window come from `@duya/ai/context`
 * — the same estimator and the same window-resolution chain the Desktop ring
 * and the worker's compaction budget use. The remaining question, "which
 * messages count as current", is answered with the LLM-visible projection
 * because that is also what the TUI renders (`chat.ts` loads its transcript
 * the same way). Every panel states its data source, and the window's
 * provenance is printed: a value that fell back to the 200K default says so
 * rather than presenting a guess as a measurement.
 */

import type { HostLocalUsagePricingRecord } from '@duya/agent-protocol';
import { computeContextEstimate, resolveContextWindow } from '@duya/ai/context';
import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import {
  countByRole,
  EMPTY_TOTALS,
  formatTokens,
  formatUsd,
  loadSessionMessages,
  sumMessageUsage,
  type HistoryView,
} from './shared.js';

/**
 * Every panel in this file describes the session the way the TUI renders it.
 * If the transcript view ever changes, change this one constant — not the
 * individual call sites — so the numbers and the screen cannot disagree.
 */
const VIEW: HistoryView = 'llm-visible';

/** USD cost from the Host's pricing index. Null when no rate is known. */
function priceWith(
  pricing: HostLocalUsagePricingRecord | undefined,
  totals: { rawInput: number; output: number; cacheRead: number; cacheWrite: number },
): number | null {
  if (pricing === undefined) return null;
  const per = (tokens: number, rate: number | undefined): number =>
    rate === undefined ? 0 : (tokens * rate) / 1_000_000;
  return (
    per(totals.rawInput, pricing.inputPerMillion) +
    per(totals.output, pricing.outputPerMillion) +
    per(totals.cacheRead, pricing.cacheReadPerMillion) +
    per(totals.cacheWrite, pricing.cacheWritePerMillion)
  );
}

function pricingFor(
  records: readonly HostLocalUsagePricingRecord[],
  providerId: string,
  model: string,
): HostLocalUsagePricingRecord | undefined {
  return records.find((record) => record.providerId === providerId && record.modelId === model);
}

const WINDOW_SOURCE_LABELS: Record<'capability' | 'catalog' | 'default', string> = {
  capability: 'model capability',
  catalog: 'built-in model catalog',
  default: 'DEFAULT (200K) — no capability row and no catalog entry for this model',
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showPanel(
  ctx: TuiSlashContext,
  title: string,
  lines: readonly string[],
  options: { readonly footer: string; readonly scrollable: boolean },
): void {
  if (ctx.tui.showPanel !== undefined) {
    ctx.tui.showPanel(title, lines, options);
    return;
  }
  // Small command harnesses can provide only the basic notice surface. The
  // production TUI always supplies `showPanel` and renders this as a window.
  ctx.tui.printNotice(title);
  for (const line of lines) ctx.tui.printNotice(line);
}

const STATUS_COMMAND: TuiSlashCommandDef = {
  name: 'status',
  description: 'Show session info (id, model, provider, messages)',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    const { session } = ctx;
    const messages = await loadSessionMessages(ctx.client, session.id, VIEW);
    const last = messages[messages.length - 1];
    const lines = [
      'Session status',
      '',
      `  id         ${session.id}`,
      `  title      ${session.title || '(untitled)'}`,
      `  model      ${session.model || '(default)'}  [${session.providerId}]`,
      `  mode       ${session.mode || '(default)'}`,
      `  permission ${session.permissionMode}`,
      `  status     ${session.status}`,
      `  messages   ${messages.length}`,
      `  updated    ${new Date(session.updatedAt).toLocaleString()}`,
    ];
    if (last !== undefined) {
      lines.push(
        `  last msg   ${last.role} at ${new Date(last.timestamp ?? session.updatedAt).toLocaleString()}`,
      );
    }
    for (const line of lines) ctx.tui.printNotice(line);
    return { kind: 'handled' };
  },
};

const USAGE_COMMAND: TuiSlashCommandDef = {
  // Canonical name and alias follow @duya/command-catalog, not this file's
  // convenience: the popup and `/help` render the catalog, so a handler that
  // swapped them would advertise `/usage` while the shared definition says
  // `/cost`. The desktop registry already had it this way.
  name: 'cost',
  aliases: ['usage'],
  description: 'Show session token usage and estimated cost',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    const { session } = ctx;
    const footer = '↑↓ / PgUp / PgDn scroll · Esc close';
    showPanel(ctx, 'Token usage', ['Loading usage from session history…'], {
      footer,
      scrollable: true,
    });

    try {
      const messages = await loadSessionMessages(ctx.client, session.id, VIEW);
      const totals = messages.length === 0 ? EMPTY_TOTALS : sumMessageUsage(messages);

      // Pricing is optional: the Host omits models it has no rate for, and a
      // cost guessed at another model's rates is a billing claim, not an
      // estimate.
      let pricing: HostLocalUsagePricingRecord | undefined;
      let pricingNote: string | undefined;
      if (totals.hasUsage) {
        try {
          const index = await ctx.client.getUsageIndex();
          pricing = pricingFor(index.pricing, session.providerId, session.model);
        } catch (error) {
          pricingNote = `pricing index unavailable: ${describeError(error)}`;
        }
      }

      const lines = [
        `session   ${session.id}`,
        `provider  ${session.providerId}`,
        `model     ${session.model || '(default)'}`,
        '',
      ];

      if (!totals.hasUsage) {
        lines.push('no usage recorded yet', 'Run a turn to populate provider-reported token counters.');
      } else {
        const cost = priceWith(pricing, totals);
        lines.push(
          `input (new)   ${formatTokens(totals.newInput)}`,
          `input (raw)   ${formatTokens(totals.rawInput)}`,
          `cache read    ${formatTokens(totals.cacheRead)}`,
          `cache write   ${formatTokens(totals.cacheWrite)}`,
          `output        ${formatTokens(totals.output)}`,
          '',
          cost === null
            ? `estimated cost  unavailable (no pricing for ${session.providerId}/${session.model})`
            : `estimated cost  ${formatUsd(cost)}`,
        );
        if (pricingNote !== undefined) lines.push('', pricingNote);
        lines.push('', 'Source: provider-reported usage counters persisted by the Host.');
      }

      showPanel(ctx, 'Token usage', lines, { footer, scrollable: true });
    } catch (error) {
      showPanel(ctx, 'Token usage', [
        'Could not load session usage.',
        '',
        describeError(error),
      ], { footer, scrollable: true });
    }
    return { kind: 'handled' };
  },
};

const CONTEXT_COMMAND: TuiSlashCommandDef = {
  name: 'context',
  description: 'Show context window usage',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    const { session } = ctx;
    const messages = await loadSessionMessages(ctx.client, session.id, VIEW);

    // Same estimator the worker runs when it decides to compact: identical
    // anchor choice, identical tail estimation, identical post-compaction
    // "unknown" guard.
    const estimate = computeContextEstimate(
      messages.map((message) => ({
        role: message.role,
        content: message.content as string | unknown[],
        tokenUsage: message.tokenUsage ?? undefined,
        model: message.model ?? undefined,
      })),
    );

    // The window the Host pinned for this provider+model (what the 200K/1M
    // buttons in the Desktop provider editor write). It is precedence level 1
    // of resolveContextWindow; the catalog and the 200K default follow.
    let capabilityWindow: number | undefined;
    try {
      const capability = await ctx.client.getProviderModelCapability(
        session.providerId,
        session.model,
      );
      if (capability !== null && capability.contextWindow !== undefined && capability.contextWindow > 0) {
        capabilityWindow = capability.contextWindow;
      }
    } catch (error) {
      ctx.tui.printNotice(`  (capability lookup failed: ${describeError(error)})`);
    }

    const window = resolveContextWindow({
      capabilityContextWindow: capabilityWindow,
      modelId: estimate.anchorModel ?? session.model,
    });
    const used = estimate.anchored && (estimate.usedTokens ?? 0) > 0 ? estimate.usedTokens : null;

    const lines = ['Context window', ''];
    if (used === null) {
      lines.push('  used             unknown (no usage anchor yet — run a turn first)');
    } else {
      const ratio = window.contextWindow > 0 ? used / window.contextWindow : 0;
      lines.push(
        `  used             ${formatTokens(used)}`,
        `  window           ${formatTokens(window.contextWindow)}  (${(ratio * 100).toFixed(1)}% used)`,
        `  remaining        ${formatTokens(Math.max(0, window.contextWindow - used))}`,
      );
    }
    lines.push(
      `  window source    ${WINDOW_SOURCE_LABELS[window.source]}`,
      `  model            ${session.model || '(default)'} [${session.providerId}]`,
    );
    for (const line of lines) ctx.tui.printNotice(line);
    return { kind: 'handled' };
  },
};

const TRANSCRIPT_COMMAND: TuiSlashCommandDef = {
  name: 'transcript',
  description: 'Show message counts for the current session',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    const messages = await loadSessionMessages(ctx.client, ctx.session.id, VIEW);
    if (messages.length === 0) {
      ctx.tui.printNotice('Transcript');
      ctx.tui.printNotice('');
      ctx.tui.printNotice('  no messages in this session');
      return { kind: 'handled' };
    }
    const counts = countByRole(messages);
    const order = ['user', 'assistant', 'tool', 'system'];
    const lines = ['Transcript', ''];
    for (const role of order) {
      const count = counts.get(role);
      if (count !== undefined && count > 0) lines.push(`  ${role.padEnd(10)} ${count}`);
    }
    for (const [role, count] of counts) {
      if (order.includes(role)) continue;
      lines.push(`  ${role.padEnd(10)} ${count}`);
    }
    lines.push(`  ${'total'.padEnd(10)} ${messages.length}`);
    lines.push('');
    lines.push('  export the full history with /export');
    for (const line of lines) ctx.tui.printNotice(line);
    return { kind: 'handled' };
  },
};

export const SESSION_INFO_COMMANDS: readonly TuiSlashCommandDef[] = [
  STATUS_COMMAND,
  USAGE_COMMAND,
  CONTEXT_COMMAND,
  TRANSCRIPT_COMMAND,
];
