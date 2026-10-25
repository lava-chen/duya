/**
 * packages/cli/src/tui/slash/shared.ts
 *
 * Read helpers shared by the TUI slash commands: durable message loading,
 * token accounting, and the small formatting helpers the printed panels use.
 *
 * ## One estimator, not two
 *
 * The context numbers here come from `@duya/ai/context` — the same
 * `computeContextEstimate` / `resolveContextWindow` the Desktop ring uses and
 * the worker uses to budget auto-compaction. That import path is deliberate:
 * it is a subpath that re-exports the pure estimators WITHOUT the Anthropic
 * and OpenAI adapters the main `@duya/ai` barrel pulls in, so a thin HTTP
 * client can share the numbers without loading two provider SDKs.
 *
 * An earlier revision of this file carried a hand-rolled mirror of the
 * estimator. It drifted (the Desktop could compact at a different point than
 * the CLI predicted) and was deleted. Do not reintroduce a local estimator
 * here — if a number is missing, fix it upstream in `@duya/ai`.
 *
 * ## The one remaining divergence: which messages are "current"
 *
 * `includeSuperseded` decides whether a rebase folds superseded raw rows out
 * of the projection (`packages/data/src/message-log.ts`). Both values are
 * legitimate, for different questions:
 *
 *   - accounting (what the model was actually sent) → FALSE
 *   - what a human should still be able to read     → TRUE
 *
 * Desktop's chat history uses TRUE on purpose (plan 548: keep pre-compaction
 * turns visible), while its token ring reads the same store. This module
 * therefore takes the projection as a parameter instead of hard-coding one:
 * the caller states which question it is asking. See
 * {@link loadSessionMessages}.
 */

import type { DurableTimelineEntry, HostSessionPatch, HostSessionRecord } from '@duya/agent-protocol';
import { randomUUID } from 'node:crypto';
import {
  projectTimelinePersistenceMessages,
  type Message as TranscriptMessage,
} from '@duya/agent-protocol/transcript';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { WindowItem } from '../window.js';
import type { TuiSlashContext } from './types.js';

const MESSAGE_PAGE_SIZE = 200;

/** Which projection a reader wants. See the file header. */
export type HistoryView =
  /** Fold rebased rows out — what the model was actually sent. Use for accounting. */
  | 'llm-visible'
  /** Keep every raw row plus the compaction summary card — what a human reads. */
  | 'full';

export function historyQuery(view: HistoryView): { includeSuperseded: boolean } {
  return { includeSuperseded: view === 'full' };
}

/** Load the session's durable history projected onto transcript messages. */
export async function loadSessionMessages(
  client: HostSessionHttpClient,
  sessionId: string,
  view: HistoryView = 'llm-visible',
): Promise<TranscriptMessage[]> {
  const entries: Extract<DurableTimelineEntry, { type: 'message' | 'compaction' }>[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.readMessages(sessionId, {
      limit: MESSAGE_PAGE_SIZE,
      ...historyQuery(view),
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const item of page.messages) {
      if (item.entry.type === 'message' || item.entry.type === 'compaction') entries.push(item.entry);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return projectTimelinePersistenceMessages(entries);
}

/** Pi-style compact token formatting, matching the Desktop stats line. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Render a scrollable panel, falling back to plain notices.
 *
 * The production TUI always supplies `showPanel` and renders this as a
 * window; a small command harness may supply only `printNotice`, and the
 * command must still show its result there.
 */
export function showPanel(
  ctx: TuiSlashContext,
  title: string,
  lines: readonly string[],
  options: { readonly footer: string; readonly scrollable: boolean },
): void {
  if (ctx.tui.showPanel !== undefined) {
    ctx.tui.showPanel(title, lines, options);
    return;
  }
  ctx.tui.printNotice(title);
  for (const line of lines) ctx.tui.printNotice(line);
}

/** One viewable entry of an interactive list panel. */
export interface TuiViewEntry {
  /** The row's name — what the filter matches and what the user reads. */
  readonly label: string;
  /** Stable identity handed back by `onEnter`. */
  readonly value: string;
  /** The per-row qualifier, dimmed after the label. */
  readonly description?: string;
  /** The right-hand column, e.g. `on`, `connected`. */
  readonly valueLabel?: string;
  /** The one-line explanation shown under the SELECTED row. */
  readonly summary?: string;
  /** The full detail page opened on Enter. */
  readonly detailLines: readonly string[];
}

/** The list footer when the host offers an interactive browser. */
export const VIEW_LIST_FOOTER = 'type to filter · ↑↓ choose · Enter details · Esc close';

/**
 * Present entries as an interactive list when the host offers one.
 *
 * Enter opens the entry's detail page; Esc comes back to the list, on the
 * row that opened it. This is the browser shape the `/plugin` `/apps`
 * `/skills` `/mcp` view commands share — codex's `/plugins` cycle, adapted
 * to the docked window the TUI already has.
 *
 * The fallbacks keep every older surface honest: a host without the browser
 * methods, or an EMPTY entry list (an empty list window would read as a
 * broken one), renders `fallbackLines` through the plain panel instead.
 * Those lines are the command's own static rendering, so a harness that only
 * has `printNotice` still sees the same facts.
 */
export function showEntries(
  ctx: TuiSlashContext,
  title: string,
  entries: readonly TuiViewEntry[],
  fallbackLines: readonly string[],
): void {
  const tui = ctx.tui;
  if (tui.showListPanel === undefined || tui.showDetailPanel === undefined || entries.length === 0) {
    showPanel(ctx, title, fallbackLines, { footer: '↑↓ / PgUp / PgDn scroll · Esc close', scrollable: true });
    return;
  }

  const items: WindowItem[] = entries.map((entry) => ({
    label: entry.label,
    value: entry.value,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.valueLabel === undefined ? {} : { valueLabel: entry.valueLabel }),
    ...(entry.summary === undefined ? {} : { detail: entry.summary }),
  }));

  const openList = (selected: number): void => {
    tui.showListPanel!(title, items, {
      footer: VIEW_LIST_FOOTER,
      ...(selected > 0 ? { initialSelected: selected } : {}),
      onEnter: (value) => {
        const index = entries.findIndex((entry) => entry.value === value);
        const entry = entries[index];
        if (entry === undefined) return;
        tui.showDetailPanel!(`${title} · ${entry.label}`, entry.detailLines, {
          footer: 'Esc back',
          onBack: () => openList(Math.max(0, index)),
        });
      },
    });
  };
  openList(0);
}

/**
 * A Host error's machine-readable code, when it has one.
 *
 * The Host answers a namespace it does not serve with a NAMED 404
 * (`checkout_api_unavailable`), and that name is the difference between "this
 * Host cannot answer" and "there is nothing to report". The code is read off
 * the error rather than off the HTTP status, because several codes share a
 * status.
 */
export function hostErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** A readable message for anything thrown. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TokenTotals {
  /** Prompt volume excluding cache re-reads — the session's "new input". */
  readonly newInput: number;
  /** Raw prompt volume, the denominator a cost estimate must use. */
  readonly rawInput: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** True when at least one message carried a usage block. */
  readonly hasUsage: boolean;
}

export const EMPTY_TOTALS: TokenTotals = {
  newInput: 0,
  rawInput: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  hasUsage: false,
};

/**
 * Cache-convention guard, identical to the Desktop's `onlyNewInputTokens`.
 *
 * Some providers report `input_tokens` already inclusive of cached tokens,
 * others exclude them. When either cache counter exceeds the reported input
 * the input clearly omits the cache, so the newly-written portion is
 * `input + cacheWrite`; cache HITS are never added because they re-read a
 * prefix that was already counted once.
 */
function nonResidentInput(input: number, cacheRead: number, cacheWrite: number): number {
  return cacheRead > input || cacheWrite > input ? input + cacheWrite : input;
}

/** Session-cumulative token totals from persisted assistant usage blocks. */
export function sumMessageUsage(messages: readonly TranscriptMessage[]): TokenTotals {
  let newInput = 0;
  let rawInput = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let hasUsage = false;
  for (const message of messages) {
    const usage = message.tokenUsage;
    if (message.role !== 'assistant' || usage === undefined) continue;
    hasUsage = true;
    const input = usage.input_tokens || 0;
    const hits = usage.cache_hit_tokens || 0;
    const writes = usage.cache_creation_tokens || 0;
    newInput += nonResidentInput(input, hits, writes);
    rawInput += input;
    output += usage.output_tokens || 0;
    cacheRead += hits;
    cacheWrite += writes;
  }
  return { newInput, rawInput, output, cacheRead, cacheWrite, hasUsage };
}

/** Message counts by role, plus a total. Roles outside the known set are kept. */
export function countByRole(messages: readonly TranscriptMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
  }
  return counts;
}

/** Update attempts before giving up on a concurrently changing session. */
const UPDATE_ATTEMPTS = 3;

/**
 * Patch the current session with optimistic concurrency.
 *
 * `update` carries `expectedUpdatedAt`, so a session someone else touched —
 * another TUI, or the Desktop — comes back as `conflict` instead of being
 * silently overwritten. A conflict is not a user-facing failure: re-read and
 * retry so the operation still lands.
 */
export async function updateSession(
  client: HostSessionHttpClient,
  session: HostSessionRecord,
  patch: HostSessionPatch,
): Promise<HostSessionRecord> {
  let current = session;
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
    const result = await client.update(current.id, current.updatedAt, patch);
    if (result.updated) return result.session;
    if (result.reason === 'not_found') {
      throw new Error(`Session ${current.id} no longer exists on this Host.`);
    }
    const latest = await client.get(current.id);
    if (latest === null) {
      throw new Error(`Session ${current.id} no longer exists on this Host.`);
    }
    current = latest;
  }
  throw new Error(
    `Session kept changing while applying ${Object.keys(patch).join(', ')} `
    + `(gave up after ${UPDATE_ATTEMPTS} attempts).`,
  );
}

/**
 * Mint a client-side session id.
 *
 * `forkAt` requires a caller-owned destination id (it namespaces the copied
 * message ids), so the fork target cannot be server-assigned the way
 * `create()` does.
 */
export function mintSessionId(): string {
  return randomUUID();
}
