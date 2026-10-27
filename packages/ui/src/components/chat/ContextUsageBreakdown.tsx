'use client';

/**
 * ContextUsageBreakdown.tsx
 *
 * The EXPANDED context-usage surface: a floating panel that shows where the
 * context window went, bucketed BY CONTENT SOURCE (the axis Claude Desktop
 * uses), not by message.
 *
 * The data comes from the worker's `composition` snapshot (plan 577 §4),
 * which already buckets the prompt by source:
 * `system` / `conversation` / `injectedContext` / `skills` /
 * `toolDefinitions` / `toolResults` / `attachments` / `memory` /
 * `providerOverhead` + `unattributedObservedTokens`.
 *
 * Those ten sources map onto NINE display buckets with Claude's sampled
 * light-theme palette:
 *
 *   | display bucket | duya source                                 | light     |
 *   | -------------- | ------------------------------------------- | --------- |
 *   | 系统提示词     | system[]                                    | #EDA100   |
 *   | 系统工具       | toolDefinitions[] + toolResults[] (non-MCP) | #EB6834   |
 *   | MCP 工具       | toolDefinitions[] + toolResults[] (MCP)     | #2A78D6   |
 *   | 对话消息       | conversation[] + attachments[]              | #1BAF7A   |
 *   | 技能           | skills[]                                    | #898781   |
 *   | 记忆文件       | memory[]                                    | #898781   |
 *   | 运行时注入     | injectedContext[]                           | #898781   |
 *   | 其他开销       | providerOverhead[] + unattributed           | #C3C2B7   |
 *   | 空闲空间       | contextWindow - usedTokens                  | #EEEDEC   |
 *
 * The colours live in `src/styles/globals.css` as `--usage-bucket-*`
 * tokens (a light set plus a dark twin - the sampled greys are unreadable
 * on the dark panel), so this file only names the token.
 *
 * Token accounting is unchanged: the composition is a projection of the SAME
 * measurement the headline uses, so the buckets are scaled onto the
 * headline's `usedTokens` and whatever the worker could not attribute stays
 * in 「其他开销」 instead of being silently dropped.
 */

import { useMemo, useState } from 'react';
import type { ContextCompositionSnapshot } from '@/stores/context-usage-store';
import { formatTokensPi } from '@/lib/context-usage-utils';

type ContextComposition = ContextCompositionSnapshot['composition'];

/** The nine display buckets, in bar order. */
export type ContextBreakdownBucketKey =
  | 'system'
  | 'tools'
  | 'mcp'
  | 'messages'
  | 'skills'
  | 'memory'
  | 'injected'
  | 'other'
  | 'free';

/** One labelled slice inside a bucket (a tool, a file, a skill, ...). */
export interface ContextBreakdownPart {
  label: string;
  tokens: number;
}

export interface ContextBreakdownBucket {
  key: ContextBreakdownBucketKey;
  label: string;
  tokens: number;
  /** Share of the context window, 0..1. */
  ratio: number;
  /** A `var(--usage-bucket-*)` reference - the colour token. */
  color: string;
  /** Child slices; expandable in the detail table. */
  parts: ContextBreakdownPart[];
}

export interface ContextBreakdownModel {
  /** Content buckets (free space excluded), in display order. */
  buckets: ContextBreakdownBucket[];
  /** The free-space bucket, or null when there is no room to show. */
  free: ContextBreakdownBucket | null;
  usedTokens: number;
  contextWindow: number;
  /** False when the worker never sent a composition. */
  hasComposition: boolean;
}

/** Label -> colour token. Mirrors the `--usage-bucket-*` palette. */
const BUCKET_COLOR: Record<ContextBreakdownBucketKey, string> = {
  system: 'var(--usage-bucket-system)',
  tools: 'var(--usage-bucket-tools)',
  mcp: 'var(--usage-bucket-mcp)',
  messages: 'var(--usage-bucket-messages)',
  skills: 'var(--usage-bucket-files)',
  memory: 'var(--usage-bucket-files)',
  injected: 'var(--usage-bucket-files)',
  other: 'var(--usage-bucket-other)',
  free: 'var(--usage-bucket-free)',
};

const BUCKET_LABEL: Record<ContextBreakdownBucketKey, string> = {
  system: '系统提示词',
  tools: '系统工具',
  mcp: 'MCP 工具',
  messages: '对话消息',
  skills: '技能',
  memory: '记忆文件',
  injected: '运行时注入',
  other: '其他开销',
  free: '空闲空间',
};

/**
 * A tool definition belongs to an MCP server when its label names one
 * (`mcp:<id>` / `connector:<id>` / `plugin:<id>`); tool RESULTS carry the
 * same label shape. Anything else is a built-in (system) tool.
 */
const MCP_SOURCE = /mcp|connector|plugin/i;
const MCP_RESULT_SOURCE = /^(connector|mcp|plugin):/;

/** The `skill:<name>` prefix is redundant inside the 技能 bucket. */
function partLabel(label: string): string {
  return label.startsWith('skill:') ? label.slice('skill:'.length) : label;
}

function toParts(
  parts: readonly { label: string; tokens: number }[] | undefined,
): ContextBreakdownPart[] {
  if (!parts) return [];
  return parts
    .filter((part) => part.tokens > 0)
    .map((part) => ({ label: partLabel(part.label), tokens: part.tokens }));
}

function sumParts(parts: readonly ContextBreakdownPart[]): number {
  return parts.reduce((total, part) => total + part.tokens, 0);
}

export interface ContextBreakdownInput {
  composition?: ContextComposition | undefined;
  usedTokens: number;
  contextWindow: number;
}

/**
 * Map the worker's composition onto the nine display buckets.
 *
 * The bucket totals are scaled onto `usedTokens` (the headline number) so
 * the bar and the headline can never disagree: when the local estimates
 * exceed the provider-observed total they are scaled down, and when they
 * fall short the difference is kept in 「其他开销」 as an explicit
 * unattributed slice instead of disappearing.
 */
export function buildContextBreakdown({
  composition,
  usedTokens,
  contextWindow,
}: ContextBreakdownInput): ContextBreakdownModel {
  const window = contextWindow > 0 ? contextWindow : 0;
  if (!composition) {
    return {
      buckets: [],
      free: null,
      usedTokens,
      contextWindow: window,
      hasComposition: false,
    };
  }

  const definitions = composition.toolDefinitions ?? [];
  const results = composition.toolResults ?? [];
  const mcpDefinitions = definitions.filter((part) => MCP_SOURCE.test(part.label));
  const systemDefinitions = definitions.filter((part) => !MCP_SOURCE.test(part.label));
  const mcpResults = results.filter((part) => MCP_RESULT_SOURCE.test(part.label));
  const systemResults = results.filter((part) => !MCP_RESULT_SOURCE.test(part.label));

  const unattributed = composition.unattributedObservedTokens ?? 0;

  const groups: Array<{ key: ContextBreakdownBucketKey; parts: ContextBreakdownPart[] }> = [
    { key: 'system', parts: toParts(composition.system) },
    { key: 'tools', parts: [...toParts(systemDefinitions), ...toParts(systemResults)] },
    { key: 'mcp', parts: [...toParts(mcpDefinitions), ...toParts(mcpResults)] },
    {
      key: 'messages',
      parts: [...toParts(composition.conversation), ...toParts(composition.attachments)],
    },
    { key: 'skills', parts: toParts(composition.skills) },
    { key: 'memory', parts: toParts(composition.memory) },
    { key: 'injected', parts: toParts(composition.injectedContext) },
    {
      key: 'other',
      parts: [
        ...toParts(composition.providerOverhead),
        ...(unattributed > 0 ? [{ label: '未归属观测', tokens: unattributed }] : []),
      ],
    },
  ];

  const classified = groups.reduce((total, group) => total + sumParts(group.parts), 0);
  const used = usedTokens > 0 ? usedTokens : classified;
  // Scale the local estimate onto the provider-observed headline. Only ever
  // scales DOWN: an estimate that falls short must not be inflated.
  const scale = classified > 0 && used > 0 && classified > used ? used / classified : 1;

  const scaled = groups.map((group) => ({
    key: group.key,
    parts: group.parts
      .map((part) => ({ label: part.label, tokens: part.tokens * scale }))
      .filter((part) => part.tokens > 0),
  }));

  const scaledTotal = scaled.reduce((total, group) => total + sumParts(group.parts), 0);
  const remainder = used - scaledTotal;
  if (remainder > 0) {
    const other = scaled.find((group) => group.key === 'other');
    if (other) other.parts.push({ label: '未归属余量', tokens: remainder });
  }

  const buckets: ContextBreakdownBucket[] = [];
  for (const group of scaled) {
    const tokens = sumParts(group.parts);
    if (tokens <= 0) continue;
    buckets.push({
      key: group.key,
      label: BUCKET_LABEL[group.key],
      tokens,
      ratio: window > 0 ? tokens / window : 0,
      color: BUCKET_COLOR[group.key],
      parts: group.parts,
    });
  }

  const freeTokens = window > 0 ? Math.max(0, window - used) : 0;
  const free: ContextBreakdownBucket | null =
    freeTokens > 0
      ? {
          key: 'free',
          label: BUCKET_LABEL.free,
          tokens: freeTokens,
          ratio: window > 0 ? freeTokens / window : 0,
          color: BUCKET_COLOR.free,
          parts: [],
        }
      : null;

  return { buckets, free, usedTokens: used, contextWindow: window, hasComposition: true };
}

/** `12.3%` - one decimal, trailing `.0` trimmed. */
export function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

export interface ContextUsageBreakdownProps {
  composition?: ContextComposition | undefined;
  usedTokens: number;
  contextWindow: number;
  /** False when there is no authoritative usage yet (shows "?"). */
  hasData?: boolean;
}

/**
 * The floating breakdown surface. Rendered inside the ring's popover shell,
 * so the shell owns positioning and this owns content.
 */
export function ContextUsageBreakdown({
  composition,
  usedTokens,
  contextWindow,
  hasData = true,
}: ContextUsageBreakdownProps) {
  const model = useMemo(
    () => buildContextBreakdown({ composition, usedTokens, contextWindow }),
    [composition, usedTokens, contextWindow],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const expandable = model.buckets.filter((bucket) => bucket.parts.length > 0);
  const allExpanded = expandable.length > 0 && expandable.every((b) => expanded.has(b.key));

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (allExpanded) expandable.forEach((bucket) => next.delete(bucket.key));
      else expandable.forEach((bucket) => next.add(bucket.key));
      return next;
    });
  };

  const f = formatTokensPi;
  const percent = hasData
    ? formatRatio(model.contextWindow > 0 ? model.usedTokens / model.contextWindow : 0)
    : '?';
  const hasRows = model.buckets.length > 0;

  return (
    <div className="context-usage-breakdown">
      <div className="context-usage-breakdown__title">上下文窗口</div>
      <div className="context-usage-breakdown__headline">
        <strong>{percent}</strong>
        <span>
          已使用 {f(model.usedTokens)} / {f(model.contextWindow)}
        </span>
      </div>

      {hasRows ? (
        <>
          <div className="context-usage-breakdown__bar" aria-hidden="true">
            {model.buckets.map((bucket) => (
              <span
                key={bucket.key}
                className="context-usage-breakdown__segment"
                style={{ flexGrow: bucket.tokens, background: bucket.color }}
              />
            ))}
            {model.free && (
              <span
                className="context-usage-breakdown__segment context-usage-breakdown__segment--free"
                style={{ flexGrow: model.free.tokens, background: model.free.color }}
              />
            )}
          </div>

          <div className="context-usage-breakdown__rows">
            {model.buckets.map((bucket) => {
              const isOpen = expanded.has(bucket.key);
              const hasChildren = bucket.parts.length > 0;
              return (
                <div className="context-usage-breakdown__group" key={bucket.key}>
                  <div className="context-usage-breakdown__row">
                    <span
                      className="context-usage-breakdown__chip"
                      style={{ background: bucket.color }}
                      aria-hidden="true"
                    />
                    {hasChildren ? (
                      <button
                        type="button"
                        className="context-usage-breakdown__label context-usage-breakdown__label--toggle"
                        aria-expanded={isOpen}
                        onClick={() => toggle(bucket.key)}
                      >
                        {bucket.label}
                      </button>
                    ) : (
                      <span className="context-usage-breakdown__label">{bucket.label}</span>
                    )}
                    <span className="context-usage-breakdown__tokens">{f(bucket.tokens)}</span>
                    <span className="context-usage-breakdown__percent">
                      {formatRatio(bucket.ratio)}
                    </span>
                  </div>
                  {hasChildren && isOpen && (
                    <div className="context-usage-breakdown__children">
                      {bucket.parts.map((part, index) => (
                        <div
                          className="context-usage-breakdown__child"
                          key={`${part.label}-${index}`}
                        >
                          <span className="context-usage-breakdown__child-label">
                            {part.label}
                          </span>
                          <span className="context-usage-breakdown__child-tokens">
                            {f(part.tokens)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {model.free && (
              <div className="context-usage-breakdown__row context-usage-breakdown__row--free">
                <span
                  className="context-usage-breakdown__chip"
                  style={{ background: model.free.color }}
                  aria-hidden="true"
                />
                <span className="context-usage-breakdown__label">{model.free.label}</span>
                <span className="context-usage-breakdown__tokens">{f(model.free.tokens)}</span>
                <span className="context-usage-breakdown__percent">
                  {formatRatio(model.free.ratio)}
                </span>
              </div>
            )}
          </div>

          <div className="context-usage-breakdown__footer">
            <button
              type="button"
              className="context-usage-breakdown__details"
              onClick={toggleAll}
              disabled={expandable.length === 0}
            >
              {allExpanded ? '收起明细' : '查看详细明细'}
            </button>
          </div>

          <div className="context-usage-breakdown__note">
            分类依据 harness 估算；有 Provider usage 时总量以实测为准，未归属差额单独保留。
          </div>
        </>
      ) : (
        <div className="context-usage-breakdown__empty">
          分类明细会在收到本轮用量构成后显示。
        </div>
      )}
    </div>
  );
}
