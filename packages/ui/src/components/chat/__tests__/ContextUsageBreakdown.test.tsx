/**
 * ContextUsageBreakdown.test.tsx - bucket mapping + segmented bar tests.
 *
 * The breakdown is a pure projection of the worker's `composition`
 * snapshot onto nine display buckets; the token accounting must never
 * disagree with the headline number, and the bar must stay proportional
 * to the buckets it renders.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import {
  buildContextBreakdown,
  formatRatio,
  ContextUsageBreakdown,
} from '../ContextUsageBreakdown';
import type { ContextCompositionSnapshot } from '@/stores/context-usage-store';

type Composition = ContextCompositionSnapshot['composition'];

const WINDOW = 100_000;

function composition(overrides: Partial<Composition> = {}): Composition {
  return {
    unattributedObservedTokens: 0,
    system: [],
    conversation: [],
    injectedContext: [],
    skills: [],
    toolDefinitions: [],
    toolResults: [],
    attachments: [],
    memory: [],
    providerOverhead: [],
    ...overrides,
  };
}

/** Bucket key -> tokens, for order-independent assertions. */
function tokensByKey(model: ReturnType<typeof buildContextBreakdown>) {
  return Object.fromEntries(model.buckets.map((bucket) => [bucket.key, bucket.tokens]));
}

describe('buildContextBreakdown', () => {
  it('maps every composition source onto its display bucket', () => {
    const model = buildContextBreakdown({
      composition: composition({
        system: [{ label: 'system prompt', tokens: 10_000 }],
        toolDefinitions: [
          { label: 'read_file', tokens: 5_000 },
          { label: 'mcp:github', tokens: 4_000 },
        ],
        toolResults: [
          { label: 'read_file', tokens: 1_000 },
          { label: 'connector:notion', tokens: 2_000 },
        ],
        conversation: [{ label: 'user message', tokens: 20_000 }],
        attachments: [{ label: 'a.png', tokens: 3_000 }],
        skills: [{ label: 'skill:pdf', tokens: 2_000 }],
        memory: [{ label: 'AGENTS.md', tokens: 1_000 }],
        injectedContext: [{ label: 'runtime', tokens: 500 }],
        providerOverhead: [{ label: 'overhead', tokens: 300 }],
      }),
      usedTokens: 48_800,
      contextWindow: WINDOW,
    });

    expect(tokensByKey(model)).toEqual({
      system: 10_000,
      // built-in tool definition + its result
      tools: 6_000,
      // MCP tool definition + connector result
      mcp: 6_000,
      // conversation + attachments
      messages: 23_000,
      skills: 2_000,
      memory: 1_000,
      injected: 500,
      other: 300,
    });
    expect(model.hasComposition).toBe(true);
  });

  it('keeps the unattributed remainder inside the other bucket', () => {
    const model = buildContextBreakdown({
      composition: composition({ system: [{ label: 'system', tokens: 10_000 }] }),
      usedTokens: 25_000,
      contextWindow: WINDOW,
    });

    // 10k classified + 15k that the worker could not attribute.
    expect(tokensByKey(model)).toEqual({ system: 10_000, other: 15_000 });
    const other = model.buckets.find((bucket) => bucket.key === 'other');
    expect(other?.parts.map((part) => part.label)).toContain('未归属余量');
  });

  it('scales the estimate down onto the observed headline total', () => {
    const model = buildContextBreakdown({
      composition: composition({
        system: [{ label: 'system', tokens: 30_000 }],
        conversation: [{ label: 'msg', tokens: 70_000 }],
      }),
      usedTokens: 50_000,
      contextWindow: WINDOW,
    });

    const classified = model.buckets.reduce((total, bucket) => total + bucket.tokens, 0);
    expect(classified).toBeCloseTo(50_000, 6);
    expect(model.usedTokens).toBe(50_000);
  });

  it('covers the whole window with the buckets plus free space', () => {
    const model = buildContextBreakdown({
      composition: composition({
        system: [{ label: 'system', tokens: 10_000 }],
        conversation: [{ label: 'msg', tokens: 20_000 }],
      }),
      usedTokens: 30_000,
      contextWindow: WINDOW,
    });

    const used = model.buckets.reduce((total, bucket) => total + bucket.ratio, 0);
    expect(model.free?.tokens).toBe(70_000);
    expect(used + (model.free?.ratio ?? 0)).toBeCloseTo(1, 10);
  });

  it('reports no composition when the worker never sent one', () => {
    const model = buildContextBreakdown({
      composition: undefined,
      usedTokens: 0,
      contextWindow: WINDOW,
    });

    expect(model.hasComposition).toBe(false);
    expect(model.buckets).toHaveLength(0);
    // Nothing to split yet: the panel shows a placeholder instead of a
    // half-empty table.
    expect(model.free).toBeNull();
  });
});

describe('formatRatio', () => {
  it('keeps one decimal and trims a trailing .0', () => {
    expect(formatRatio(0.123)).toBe('12.3%');
    expect(formatRatio(0.5)).toBe('50%');
  });
});

describe('ContextUsageBreakdown', () => {
  it('sizes each bar segment by its token share', () => {
    const { container } = render(
      <ContextUsageBreakdown
        composition={composition({
          system: [{ label: 'system', tokens: 10_000 }],
          conversation: [{ label: 'msg', tokens: 20_000 }],
        })}
        usedTokens={30_000}
        contextWindow={WINDOW}
      />,
    );

    const segments = [
      ...container.querySelectorAll<HTMLElement>('.context-usage-breakdown__segment'),
    ];
    // 10k system + 20k messages + 70k free.
    expect(segments.map((segment) => segment.style.flexGrow)).toEqual([
      '10000',
      '20000',
      '70000',
    ]);
  });

  it('lists every bucket with its tokens and share', () => {
    const { container } = render(
      <ContextUsageBreakdown
        composition={composition({ system: [{ label: 'system', tokens: 10_000 }] })}
        usedTokens={10_000}
        contextWindow={WINDOW}
      />,
    );

    const rows = [
      ...container.querySelectorAll<HTMLElement>('.context-usage-breakdown__row'),
    ];
    expect(rows).toHaveLength(2); // 系统提示词 + 空闲空间
    expect(rows[0].textContent).toContain('系统提示词');
    expect(rows[0].textContent).toContain('10k');
    expect(rows[0].textContent).toContain('10%');
    expect(rows[1].textContent).toContain('空闲空间');
    // Bucket colours come from the shared palette tokens.
    expect(
      container.querySelector<HTMLElement>('.context-usage-breakdown__chip')?.style.background,
    ).toContain('var(--usage-bucket-');
  });

  it('expands a bucket into its child slices', () => {
    const { container } = render(
      <ContextUsageBreakdown
        composition={composition({
          system: [{ label: 'system prompt', tokens: 10_000 }],
        })}
        usedTokens={10_000}
        contextWindow={WINDOW}
      />,
    );

    expect(container.querySelector('.context-usage-breakdown__children')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      '.context-usage-breakdown__label--toggle',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle as HTMLButtonElement);

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('.context-usage-breakdown__child')?.textContent,
    ).toContain('system prompt');
  });

  it('falls back to a placeholder without a composition', () => {
    const { container } = render(
      <ContextUsageBreakdown usedTokens={0} contextWindow={WINDOW} hasData={false} />,
    );

    expect(container.querySelector('.context-usage-breakdown__bar')).toBeNull();
    expect(container.querySelector('.context-usage-breakdown__empty')?.textContent).toContain(
      '分类明细',
    );
    // No usage data yet -> the headline shows "?" instead of a fake number.
    expect(container.querySelector('.context-usage-breakdown__headline')?.textContent).toContain(
      '?',
    );
  });
});
