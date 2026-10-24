/**
 * Streaming-render benchmark harness (Agent B / perf-streaming).
 *
 * WHY THIS LIVES INSIDE THE UI PACKAGE
 *
 * The repository's architecture gate treats an `e2e/` file that imports a
 * workspace package as a new `module-dependency` violation (verified: adding
 * `import { ToolActionsGroup } from '@duya/ui'` under `e2e/` turns
 * `npm run architecture:check` red). `e2e/turn/loopback-anthropic.ts` records
 * the same decision for the host side: reaching from the e2e tree into a
 * product package is a governance decision about the whole e2e tree, not
 * something a benchmark slice may take on its own.
 *
 * So the harness APP lives here, inside the package that owns the components
 * it renders (no boundary is crossed), and the measurement DRIVER lives in
 * `e2e/perf/agents/agent-b/`, where it only orchestrates: build, serve, drive
 * a browser, collect numbers. The driver references this directory by path.
 *
 * WHAT IS MEASURED
 *
 * The real render path, in a real browser engine (Chromium — the same engine
 * Electron's renderer is), against a production React build:
 *
 *   ToolActionsGroup -> TextRow -> MarkdownRenderer -> react-markdown
 *                    -> CodeBlock -> react-syntax-highlighter
 *
 * The event stream is driven through `streamingEventsToActions` — the SAME
 * function the product's `useStreamingActions` hook uses — so the actions
 * array the renderer sees has production shape (a fresh array and fresh tool
 * objects on every animation frame).
 */

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolActionsGroup } from '@/components/chat/ToolActionsGroup';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { streamingEventsToActions } from '@/hooks/useStreamingActions';
import { CHUNK, REPLY, TOOL_STORM, TOOLS } from './fixture';
import { installInstrumentation } from './metrics';
import '@duya/ui/styles.css';

type StreamEvent = Parameters<typeof streamingEventsToActions>[0][number];

export interface Scenario {
  /** Project fixture id (see the perf plan). */
  id: string;
  text: string;
  chunk: number;
  tools: typeof TOOLS;
  /** Frames between two tool_use events. 0 disables tool events. */
  toolEvery: number;
}

const SHORT_REPLY = `Working on it now.

I inspected the render path and found the hot spot.

\`\`\`ts
export const hot = true;
\`\`\`

Done.`;

/**
 * The scenarios of the LOCAL evidence harness.
 *
 * These ids live in their own `ui-harness/` namespace on purpose. The shared
 * performance harness (`e2e/perf/lib/fixtures.mjs`) owns the `perf/*` fixture
 * contract, and `perf/stream-long-reply` there is a PLAIN TEXT reply of 2 000
 * chunks — while the reply rendered here carries three fenced code blocks.
 * The same id with different content would make every cross-harness number
 * comparison meaningless, so the local harness names its scenarios
 * differently. See `e2e/perf/agents/agent-b/README.md` for the mapping from
 * the labels the first round's archived evidence used.
 */
export const SCENARIOS: Record<string, Scenario> = {
  'ui-harness/stream-long-reply': {
    id: 'ui-harness/stream-long-reply',
    text: REPLY,
    chunk: CHUNK,
    tools: [],
    toolEvery: 0,
  },
  'ui-harness/stream-tool-storm': {
    id: 'ui-harness/stream-tool-storm',
    text: SHORT_REPLY,
    chunk: CHUNK,
    tools: TOOL_STORM,
    toolEvery: 2,
  },
};

const HISTORY_BLOCKS = [
  '## Earlier answer\n\nA completed message that must not be re-rendered while the next reply streams.\n\n```ts\nconst done = true;\n```\n',
  'Second earlier answer with a list:\n\n- one\n- two\n- three\n',
  'Third earlier answer, plain prose only.\n',
];

const instrumentation = installInstrumentation();
const renderCounts = { history: 0 };

const HistoryPanel = React.memo(function HistoryPanel({ blocks }: { blocks: string[] }) {
  renderCounts.history += 1;
  return (
    <div id="history" className="px-4 py-2">
      {blocks.map((block, index) => (
        <MarkdownRenderer key={index} className="message-content">
          {block}
        </MarkdownRenderer>
      ))}
    </div>
  );
});

function StreamHarness({ scenario }: { scenario: Scenario }) {
  const [actions, setActions] = useState<ReturnType<typeof streamingEventsToActions>>([]);
  const eventsRef = useRef<StreamEvent[]>([]);

  useEffect(() => {
    eventsRef.current = [];
    setActions([]);

    let raf = 0;
    let frame = 0;
    let sent = 0;
    let nextTool = 0;
    let running = false;
    const pendingResults: Array<{ at: number; event: StreamEvent }> = [];

    const pushText = (delta: string) => {
      const events = eventsRef.current;
      const last = events[events.length - 1];
      if (last && last.type === 'text') {
        last.content += delta;
      } else {
        events.push({ type: 'text', content: delta, timestamp: Date.now() } as StreamEvent);
      }
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      frame += 1;

      if (sent < scenario.text.length) {
        pushText(scenario.text.slice(sent, sent + scenario.chunk));
        sent += scenario.chunk;
      }

      if (scenario.toolEvery > 0 && nextTool < scenario.tools.length && frame % scenario.toolEvery === 0) {
        const tool = scenario.tools[nextTool];
        nextTool += 1;
        eventsRef.current.push({
          type: 'tool_use',
          toolUse: { id: tool.id, name: tool.name, input: tool.input },
          timestamp: Date.now(),
        } as StreamEvent);
        pendingResults.push({
          at: frame + 3,
          event: {
            type: 'tool_result',
            toolResult: { tool_use_id: tool.id, content: tool.result, is_error: false },
            timestamp: Date.now(),
          } as StreamEvent,
        });
      }
      for (let i = pendingResults.length - 1; i >= 0; i -= 1) {
        if (pendingResults[i]!.at <= frame) {
          eventsRef.current.push(pendingResults[i]!.event);
          pendingResults.splice(i, 1);
        }
      }

      // Flush — mirrors useStreamingActions' once-per-frame derivation.
      setActions(streamingEventsToActions(eventsRef.current));

      if (sent >= scenario.text.length && nextTool >= scenario.tools.length && pendingResults.length === 0) {
        (window as unknown as { __benchDone?: boolean }).__benchDone = true;
      }
    };

    // The stream starts only when the driver says so, so the measurement
    // window (profiler + baseline counters) covers the WHOLE stream.
    const startTimer = window.setInterval(() => {
      if (running) return;
      if (!(window as unknown as { __benchStart?: boolean }).__benchStart) return;
      running = true;
      window.clearInterval(startTimer);
      instrumentation.reset();
      raf = requestAnimationFrame(tick);
    }, 20);

    return () => {
      window.clearInterval(startTimer);
      cancelAnimationFrame(raf);
    };
  }, [scenario]);

  return (
    <div>
      <HistoryPanel blocks={HISTORY_BLOCKS} />
      <div id="stream" className="px-4 py-2">
        {/* Mirrors StreamingMessage's StreamingTools: ToolActionsGroup is not
            mounted until there is at least one action. Mounting it with an
            empty array trips a hook-order violation inside the group
            (its early return skips three useMemo calls), which the product
            never hits because of this same guard. */}
        {actions.length > 0 && <ToolActionsGroup actions={actions} isStreaming />}
      </div>
    </div>
  );
}

interface BenchWindow extends Window {
  __benchDone?: boolean;
  __benchReset?: () => void;
  __benchMetrics?: () => unknown;
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const scenarioId = params.get('scenario') ?? 'ui-harness/stream-long-reply';
  const scenario = SCENARIOS[scenarioId] ?? SCENARIOS['ui-harness/stream-long-reply']!;

  useEffect(() => {
    instrumentation.observeRegion('history', document.getElementById('history'));
    instrumentation.observeRegion('stream', document.getElementById('stream'));

    // The code-fence region is observed separately so "was this fence
    // re-highlighted?" is answerable on its own: re-highlighting replaces the
    // highlighted spans, which shows up as childList mutations inside the
    // fence's wrapper.
    const codeObserver = new MutationObserver(() => {});
    const attachCodeRegion = () => {
      const wrapper = document.querySelector('#stream .code-block-wrapper');
      if (wrapper) {
        instrumentation.observeRegion('code', wrapper);
        codeObserver.disconnect();
      }
    };
    const timer = window.setInterval(attachCodeRegion, 100);

    const win = window as BenchWindow;
    win.__benchReset = () => {
      instrumentation.reset();
      renderCounts.history = 0;
      win.__benchDone = false;
    };
    win.__benchMetrics = () => ({
      ...instrumentation.metrics(),
      renderCounts: { ...renderCounts },
    });
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen">
      <StreamHarness scenario={scenario} />
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
