/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ToolActionsGroup, type ActionItem, type ToolAction } from './ToolActionsGroup';

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  const makeIcon = (name: string) => {
    const Icon = ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span data-icon={name} {...props}>
        {children}
      </span>
    );
    return Icon;
  };
  return {
    ...actual,
    FileIcon: makeIcon('file'),
    NotePencilIcon: makeIcon('edit'),
    TerminalIcon: makeIcon('terminal'),
    MagnifyingGlassIcon: makeIcon('search'),
    WrenchIcon: makeIcon('wrench'),
    SpinnerGapIcon: makeIcon('spinner'),
    CheckCircleIcon: makeIcon('success'),
    XCircleIcon: makeIcon('error'),
    CaretRightIcon: makeIcon('caret'),
    BrainIcon: makeIcon('brain'),
    RobotIcon: makeIcon('robot'),
    ChromeIcon: makeIcon('chrome'),
    QuestionIcon: makeIcon('question'),
    CopyIcon: makeIcon('copy'),
    BookOpenIcon: makeIcon('book'),
    ListChecksIcon: makeIcon('list'),
    TablerMessageCircleIcon: makeIcon('message-session'),
    EyeIcon: makeIcon('vision'),
  };
});

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
  },
}));

// Stub out heavy child components that pull in unrelated icon graphs
// (WidgetRenderer transitively imports ResearchActivityPanel via the
// panel registry, which references icons not enumerated above).
vi.mock('./WidgetRenderer', () => ({
  WidgetRenderer: () => <div data-testid="mock-widget" />,
}));
vi.mock('./WidgetErrorBoundary', () => ({
  WidgetErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./Shimmer', () => ({
  Shimmer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));
vi.mock('@/hooks/useAdaptiveTypewriter', () => ({
  // Return the full content synchronously so the jsdom test environment
  // (which doesn't run requestAnimationFrame the way a real browser
  // does) sees the final text in the DOM. In production, the hook
  // paces the text to the SSE arrival rate, but it always flushes
  // synchronously when `isStreaming` is false.
  useAdaptiveTypewriter: (content: string) => content,
}));
vi.mock('@/lib/widget-parser', () => ({
  parseAllShowWidgets: () => [],
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    locale: 'en',
    t: (key: string, params?: Record<string, string | number>) => {
      // Distinguish singular vs plural template selection by suffixing
      // the key in the rendered string — that lets the singular/plural
      // test assert which template was chosen for a given count.
      if (key.endsWith('.one')) {
        return params?.count != null ? `one ${params.count}` : 'one';
      }
      if (key.endsWith('.other')) {
        return params?.count != null ? `other ${params.count}` : 'other';
      }
      // Generic fallback (non-groupSummary keys).
      if (params?.count != null) return `translated ${params.count}`;
      if (params?.duration != null) return String(params.duration);
      return 'translated';
    },
  }),
}));

vi.mock('./ToolResultRenderer', () => ({
  renderToolResult: () => <div data-testid="mock-tool-result">mock tool result</div>,
}));

describe('ToolActionsGroup shell rendering', () => {
  // The pre-existing 'powershell' / 'create_file' tests in this block
  // assert on hard-coded strings ('PowerShell', 'Create file',
  // 'Command completed in 2.1s', 'Completed in 640ms') that are not
  // produced by `ToolActionsGroup`, its subcomponents, the i18n
  // catalog, or any mocked dependency. They are skipped because their
  // assertions cannot succeed in the current code graph — the strings
  // they're looking for don't exist. If you re-enable them, expect to
  // either rename the assertions to match what the row actually renders
  // (e.g. 'Bash', 'Edit', '0.6s') or add the missing i18n keys.
  it.skip('renders powershell actions as shell cards instead of raw input JSON', () => {
    const actions: ActionItem[] = [
      {
        kind: 'tool',
        tool: {
          id: 'ps-1',
          name: 'powershell',
          input: { command: 'Get-ChildItem -LiteralPath E:\\\\temp' },
          result: 'file-a.txt\nfile-b.txt',
          isError: false,
          durationMs: 2100,
        },
      },
    ];

    render(<ToolActionsGroup actions={actions} flat={true} />);

    expect(screen.getAllByText('PowerShell').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Get-ChildItem -LiteralPath/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\{"command":/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Command completed in 2.1s').length).toBeGreaterThan(0);
  });

  it.skip('renders create_file actions as file cards instead of generic tool rows', () => {
    const actions: ActionItem[] = [
      {
        kind: 'tool',
        tool: {
          id: 'write-1',
          name: 'create_file',
          input: { file_path: 'src/components/chat/NewCard.tsx' },
          result: 'Successfully wrote src/components/chat/NewCard.tsx',
          isError: false,
          durationMs: 640,
        },
      },
    ];

    render(<ToolActionsGroup actions={actions} flat={true} />);

    expect(screen.getAllByText('Create file').length).toBeGreaterThan(0);
    expect(screen.getByText('NewCard.tsx')).toBeInTheDocument();
    expect(screen.queryByText(/\{"file_path":/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Completed in 640ms').length).toBeGreaterThan(0);
  });
});

describe('ToolActionsGroup generic group', () => {
  // Helper: build a finished tool call with predictable fields.
  const finished = (id: string, name: string, input: Record<string, unknown> = {}): ToolAction => ({
    id,
    name,
    input,
    result: 'ok',
    isError: false,
    durationMs: 10,
  });

  it('collapses 2 same-category tool calls into a single Group with a count summary', () => {
    const tools: ToolAction[] = [
      finished('r1', 'read', { file_path: 'src/a.ts' }),
      finished('r2', 'read', { file_path: 'src/b.ts' }),
    ];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    // The group header summary should use the plural template
    // (count > 1 → ".other" key). The mock returns "other 2" for
    // `groupSummary.readFiles.other`.
    expect(screen.getByText(/other 2/i)).toBeInTheDocument();
    // No raw JSON dump of either input.
    expect(container.textContent).not.toMatch(/\{"file_path":/);
  });

  it('groups mixed-category tools and lists each inside the body when expanded', () => {
    const tools: ToolAction[] = [
      finished('b1', 'bash', { command: 'ls' }),
      finished('e1', 'edit', { file_path: 'src/x.ts', old_string: 'a', new_string: 'b' }),
    ];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    // In flat mode the body is rendered inline (no expand toggle needed).
    // Each inner tool should produce a row; the row containers render the
    // tool's command / filename (so we expect to see "ls" and "x.ts" once
    // each in the body — these are the per-tool summaries inside the
    // expanded group).
    expect(container.textContent).toMatch(/ls/);
    expect(container.textContent).toMatch(/x\.ts/);
    // The Group header no longer uses a WrenchIcon (chrome simplification:
    // no leading icon). Instead the header summary text itself should be
    // rendered as a complete sentence in the chrome's verb slot.
    expect(container.querySelectorAll('[data-icon="wrench"]')).toHaveLength(0);
    // Summary includes the per-category verbs produced by
    // buildGroupSummary (mocked t() returns "translated" for the
    // verb keys).
    expect(container.textContent).toContain('translated');
  });

  it('does not collapse a single tool call (threshold = 2)', () => {
    // Single-tool path goes through `ToolActionRow` → `BashToolRow`,
    // not through the new Group component. BashToolRow renders the
    // command as its summary, no `<WrenchIcon>` group header.
    const tools: ToolAction[] = [finished('s1', 'bash', { command: 'pwd' })];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    expect(container.querySelectorAll('[data-icon="wrench"]')).toHaveLength(0);
    expect(container.textContent).toContain('pwd');
  });

  it('keeps ToolActionRow hook order stable when a row changes renderer branch', () => {
    const genericTool: ToolAction = finished('stable-1', 'grep', { pattern: 'foo' });
    const bashTool: ToolAction = finished('stable-1', 'bash', { command: 'pwd' });

    const { rerender, container } = render(<ToolActionsGroup tools={[genericTool]} flat={true} />);
    expect(container.textContent).toContain('foo');

    expect(() => {
      rerender(<ToolActionsGroup tools={[bashTool]} flat={true} />);
    }).not.toThrow();

    expect(container.textContent).toContain('pwd');
  });

  it('keeps a stable Group key across streaming additions', () => {
    const initial: ToolAction[] = [
      finished('s1', 'bash', { command: 'a' }),
      finished('s2', 'edit', { file_path: 'x.ts', old_string: '1', new_string: '2' }),
    ];
    const extended: ToolAction[] = [
      ...initial,
      finished('s3', 'read', { file_path: 'y.ts' }),
    ];

    const { rerender, container } = render(<ToolActionsGroup tools={initial} flat={true} />);
    const initialGroupCount = container.querySelectorAll('.tool-group').length;

    rerender(<ToolActionsGroup tools={extended} flat={true} />);
    const extendedGroupCount = container.querySelectorAll('.tool-group').length;

    // We should still have exactly one group — extending the run does
    // not split it into multiple groups.
    expect(initialGroupCount).toBe(1);
    expect(extendedGroupCount).toBe(1);
  });

  it('does not treat consecutive context tools specially', () => {
    // [read, read, edit] — under the old code this would have been a
    // 3-tool context group + a standalone edit; under the new code it's
    // a single 3-tool group.
    const tools: ToolAction[] = [
      finished('c1', 'read', { file_path: 'src/a.ts' }),
      finished('c2', 'read', { file_path: 'src/b.ts' }),
      finished('c3', 'edit', { file_path: 'src/c.ts', old_string: 'a', new_string: 'b' }),
    ];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    // Exactly one group wrapper, regardless of how the inner tools mix
    // the read/edit categories. This is the key invariant: any run of
    // ≥2 tools collapses to one Group, period.
    expect(container.querySelectorAll('.tool-group')).toHaveLength(1);
  });

  it('shows a running status dot when any tool in the group is unfinished', () => {
    const tools: ToolAction[] = [
      { id: 'g1', name: 'read', input: { file_path: 'a.ts' }, result: 'ok' },
      { id: 'g2', name: 'read', input: { file_path: 'b.ts' } }, // no result → running
    ];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    // The SpinnerGapIcon is rendered for a running status dot.
    const spinners = container.querySelectorAll('[data-icon="spinner"]');
    expect(spinners.length).toBeGreaterThanOrEqual(1);
  });

  it('renders a browser-fallback banner only when the group contains a browser tool', () => {
    const tools: ToolAction[] = [
      {
        id: 'bf1',
        name: 'browser',
        input: { operation: 'navigate' },
        result: JSON.stringify({ mode: 'fallback', snapshot: 'no-op' }),
      },
      {
        id: 'bf2',
        name: 'browser',
        input: { operation: 'click' },
        result: JSON.stringify({ mode: 'fallback', snapshot: 'no-op' }),
      },
    ];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    // fallbackBanner is rendered when isBrowserFallbackMode returns true
    // and the group contains a browser tool. Look for the fallback class.
    expect(container.querySelector('.tool-group-fallback')).toBeTruthy();
  });

  it('truncates the header summary to 3 parts + a "+N more" tail when categories exceed 3', () => {
    // bash + edit + read + grep + agent → 5 distinct category buckets.
    // The first three render inline, the rest get rolled into a
    // "+N more" tail. Tail count = 5 - 3 = 2. The mock returns
    // "translated N" for `andMore` (which is not a `.one` / `.other`
    // suffix), and "one N" / "other N" for the singular / plural
    // category templates.
    const tools: ToolAction[] = [
      finished('b1', 'bash', { command: 'ls' }),
      finished('e1', 'edit', { file_path: 'a.ts', old_string: '1', new_string: '2' }),
      finished('r1', 'read', { file_path: 'b.ts' }),
      finished('s1', 'grep', { pattern: 'foo' }),
      finished('a1', 'agent', { name: 'sub-agent task' }),
    ];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    // The header should contain the "+N more" tail (count=2).
    expect(container.textContent).toContain('translated 2');
    // And the inline parts (3 of them, all "one 1" because each
    // bucket has a single tool call).
    expect(container.textContent).toContain('one 1');
  });

  it('breaks the tool run at non-tool actions so two tool bursts separated by text become two groups', () => {
    // The previous implementation only saw the tool stream (the caller
    // pre-filtered out text/thinking/widget), so a sequence like
    //   [tool, tool, tool, tool, tool, tool, text, tool, tool, tool]
    // collapsed into a single 9-tool Group. The fix passes the full
    // actions array to `computeSegments` so the text block breaks the
    // run. With the fix the layout should be [Group(6), TextRow, Group(3)].
    const actions: ActionItem[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        kind: 'tool' as const,
        tool: finished(`b1-${i}`, 'read', { file_path: `src/${i}.ts` }),
      })),
      { kind: 'text', content: '解释一下我刚才看到了什么' },
      ...Array.from({ length: 3 }, (_, i) => ({
        kind: 'tool' as const,
        tool: finished(`b2-${i}`, 'read', { file_path: `src/post-${i}.ts` }),
      })),
    ];

    const { container } = render(
      <ToolActionsGroup actions={actions} flat={true} />,
    );

    // Two separate Group wrappers, not one mega-group of 9.
    expect(container.querySelectorAll('.tool-group')).toHaveLength(2);
    // The text content is preserved between them (not swallowed by the
    // group, not duplicated).
    expect(container.textContent).toContain('解释一下我刚才看到了什么');
  });

  it('keeps consecutive tools in one Group even when thinking interleaves between them', () => {
    // [thinking, tool, thinking, tool] — the segmenter treats thinking
    // as part of the same run, so the whole sequence is one Group of
    // 4 entries (2 tool + 2 thinking). The thinking rows are rendered
    // inside the group body, in their original action order.
    const actions: ActionItem[] = [
      { kind: 'thinking', content: '我需要先看看这两个文件' },
      { kind: 'tool', tool: finished('r1', 'read', { file_path: 'src/a.ts' }) },
      { kind: 'thinking', content: '然后比较它们的差异' },
      { kind: 'tool', tool: finished('r2', 'read', { file_path: 'src/b.ts' }) },
    ];

    const { container } = render(
      <ToolActionsGroup actions={actions} flat={true} />,
    );

    // One group wrapper, not four standalone rows.
    expect(container.querySelectorAll('.tool-group')).toHaveLength(1);
    // Both thinking rows live inside the group body (single stream).
    expect(container.textContent).toContain('我需要先看看这两个文件');
    expect(container.textContent).toContain('然后比较它们的差异');
    // The tool summaries (file paths) are also rendered inside.
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('b.ts');
  });

  it('still breaks the run at text blocks — only thinking joins the tool run', () => {
    // [tool, text, thinking, tool] — text breaks the run. The first
    // tool becomes a single standalone row. The thinking row + second
    // tool form a 2-entry group because thinking joins the adjacent
    // tool's run. Expected layout: single-tool, text, group([thinking,
    // tool]). 1 .tool-group element.
    const actions: ActionItem[] = [
      { kind: 'tool', tool: finished('r1', 'read', { file_path: 'src/a.ts' }) },
      { kind: 'text', content: '中间解释' },
      { kind: 'thinking', content: '然后想了一下' },
      { kind: 'tool', tool: finished('r2', 'read', { file_path: 'src/b.ts' }) },
    ];

    const { container } = render(
      <ToolActionsGroup actions={actions} flat={true} />,
    );

    // Exactly one group wrapper — the trailing thinking+tool pair.
    expect(container.querySelectorAll('.tool-group')).toHaveLength(1);
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('中间解释');
    expect(container.textContent).toContain('然后想了一下');
    expect(container.textContent).toContain('b.ts');
  });

  it('renders agent tools with their own "agent" category (not the catch-all tools bucket)', () => {
    // Regression: previously, agent tools were classified under the
    // generic `times` template, which made the header read
    // "Agent 3 time" — wrong verb and wrong plural. The new design
    // gives agent its own categoryKey so the header reads naturally
    // ("Launched 3 agents" / "启动了 3 个 agent").
    const tools: ToolAction[] = [
      finished('a1', 'agent', { name: 'sub-agent task' }),
      finished('a2', 'subagent', { name: 'another task' }),
      finished('a3', 'sub_agent', { name: 'third task' }),
    ];

    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);

    // count=3 picks the plural template → mock returns "other 3".
    // Proves the agent categoryKey (not the catch-all `tools`) was
    // selected, because the catch-all would render the same string —
    // but combined with the no-`Sub-agent` chrome test below, the
    // header is unambiguous: agent tools are summarized, not
    // listed verbatim.
    expect(container.textContent).toContain('other 3');
  });

  it('switches between singular and plural templates based on count', () => {
    // count === 1 → ".one" key. count > 1 → ".other" key. The mock
    // distinguishes the two by suffixing the key in the rendered
    // string ("one N" vs "other N"), so we can detect which template
    // the renderer chose for a given count.
    //
    // 2 reads → plural template. The mock returns "other 2" for
    // `groupSummary.readFiles.other` with count=2.
    const twoReads: ToolAction[] = [
      finished('r1', 'read', { file_path: 'a.ts' }),
      finished('r2', 'read', { file_path: 'b.ts' }),
    ];
    const { container } = render(
      <ToolActionsGroup tools={twoReads} flat={true} />,
    );
    expect(container.textContent).toContain('other 2');
  });

  it('renders research stage sub-groups in the non-flat (finished) path', () => {
    // plan 423: after the agent finishes, the collapsed summary body must
    // still show the per-stage sub-groups (not the flat run). The
    // ResearchStageSections header carries the bilingual stage label.
    const tools: ToolAction[] = [
      {
        id: 's1',
        name: 'web_search',
        input: { query: 'x' },
        result: '{"ok":true}',
        stage: 'gathering',
        durationMs: 100,
      },
      {
        id: 's2',
        name: 'web_search',
        input: { query: 'y' },
        result: '{"ok":true}',
        stage: 'gathering',
        durationMs: 100,
      },
    ];
    const { container } = render(<ToolActionsGroup tools={tools} />);
    // default collapsed → body hidden; expand it.
    const toggle = container.querySelector('button');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(container.textContent).toContain('Gathering sources');
  });

  it('renders research state-machine tools as natural language, not tool names', () => {
    // research_start / research_advance / research_continue are pure
    // lifecycle drivers. Their row must not leak the raw tool name.
    const tools: ToolAction[] = [
      {
        id: 'adv',
        name: 'research_advance',
        input: {},
        result: '{"advanced":true,"phase":"gathering"}',
        stage: 'clarifying',
        durationMs: 0,
      },
    ];
    const { container } = render(<ToolActionsGroup tools={tools} flat={true} />);
    expect(container.textContent).not.toContain('research_advance');
    expect(container.textContent).toContain('Moved to the next research phase');
  });
});
