/**
 * browser-runner.test.ts — wf.browser 节点执行器门禁（plan 564）：
 * 顺序执行与 output 汇总、on_stuck 三档（fail/skip/agent 未接线）、
 * max_actions 护栏、screenshot 落 artifact store、close_tab 语义、
 * 未连通 loud fail。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runBrowserNode,
  describeBrowserStep,
  type BrowserBackendPort,
  type BrowserNodeSpec,
  type BrowserStepResult,
} from '../browser-runner.js';
import { MemoryArtifactStore } from '../gui-artifacts.js';

// ─── fake backend ───

interface FakeBackendOptions {
  connectError?: string;
  /** 按 selector/do 返回失败的步骤谓词（返回 string = 错误消息）。 */
  failWhen?: (step: Parameters<BrowserBackendPort['run']>[0]) => string | undefined;
}

function fakeBackend(opts: FakeBackendOptions = {}) {
  const calls: string[] = [];
  let closed = 0;
  const backend: BrowserBackendPort & { calls: string[]; closeCount: () => number } = {
    calls,
    closeCount: () => closed,
    async connect() {
      if (opts.connectError) throw new Error(opts.connectError);
    },
    async run(step) {
      calls.push(describeBrowserStep(step));
      const failure = opts.failWhen?.(step);
      if (failure) return { ok: false, error: failure } satisfies BrowserStepResult;
      if (step.do === 'navigate') {
        return { ok: true, data: { url: step.url, title: `page of ${step.url}` } };
      }
      if (step.do === 'screenshot') {
        return { ok: true, data: { base64: 'c2hvdA==' } };
      }
      return { ok: true };
    },
    async close() {
      closed += 1;
    },
  };
  return backend;
}

// ─── happy path ───

describe('runBrowserNode — happy path', () => {
  it('runs start_url + steps in order and reports url/title/step count', async () => {
    const backend = fakeBackend();
    const spec: BrowserNodeSpec = {
      start_url: 'https://example.com',
      steps: [
        { do: 'click', selector: '#login' },
        { do: 'type', selector: '#user', text: 'ada' },
        { do: 'key', key: 'Enter' },
      ],
    };
    const outcome = await runBrowserNode({ browser: spec, backend, runId: 'r1' });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output?.url).toBe('https://example.com');
    expect(outcome.output?.title).toBe('page of https://example.com');
    expect(outcome.output?.steps).toBe(3);
    // start_url navigate first, then declared steps in order.
    expect(backend.calls).toEqual([
      'navigate https://example.com',
      'click #login',
      'type #user',
      'key Enter',
    ]);
    // close_tab defaults to true → session tab recycled.
    expect(backend.closeCount()).toBe(1);
  });

  it('close_tab:false keeps the session tab open', async () => {
    const backend = fakeBackend();
    const outcome = await runBrowserNode({
      browser: { steps: [{ do: 'navigate', url: 'https://a.dev' }], close_tab: false },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('succeeded');
    expect(backend.closeCount()).toBe(0);
  });

  it('close is attempted even when connect fails (best-effort cleanup)', async () => {
    const backend = fakeBackend({ connectError: 'browser bridge unavailable' });
    await runBrowserNode({
      browser: { steps: [{ do: 'navigate', url: 'https://a.dev' }] },
      backend,
      runId: 'r1',
    });
    expect(backend.closeCount()).toBe(1);
  });
});

// ─── on_stuck ladder ───

describe('runBrowserNode — on_stuck ladder', () => {
  it('default fail: returns failed outcome with the failing step described', async () => {
    const backend = fakeBackend({
      failWhen: (step) => (step.do === 'type' ? 'Element not found: #user' : undefined),
    });
    const outcome = await runBrowserNode({
      browser: {
        start_url: 'https://x.dev',
        steps: [
          { do: 'click', selector: '#login' },
          { do: 'type', selector: '#user', text: 'ada' },
          { do: 'key', key: 'Enter' },
        ],
      },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('browser step 2 (type #user) failed');
    expect(outcome.error).toContain('Element not found');
    expect(outcome.errorClass).toBe('element_not_found');
    expect(outcome.output?.steps).toBe(1);
    // Tab is still recycled on failure.
    expect(backend.closeCount()).toBe(1);
  });

  it("on_stuck:'skip': failed steps are skipped, later steps still run", async () => {
    const backend = fakeBackend({
      failWhen: (step) => (step.do === 'type' ? 'Element not found: #user' : undefined),
    });
    const outcome = await runBrowserNode({
      browser: {
        on_stuck: 'skip',
        steps: [
          { do: 'click', selector: '#login' },
          { do: 'type', selector: '#user', text: 'ada' },
          { do: 'key', key: 'Enter' },
        ],
      },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output?.steps).toBe(2); // type skipped, not counted
    expect(backend.calls).toEqual(['click #login', 'type #user', 'key Enter']);
  });

  it("on_stuck:'agent' without an ask port — loud fail with the no-port note, same as fail", async () => {
    const backend = fakeBackend({
      failWhen: () => 'element not found: #x',
    });
    const outcome = await runBrowserNode({
      browser: { on_stuck: 'agent', steps: [{ do: 'click', selector: '#x' }] },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain("on_stuck:'agent' has no ask port");
  });

  it("on_stuck:'agent' with ask: answer retry re-runs the step once and succeeds", async () => {
    // First type invocation fails, the ask-retry second invocation succeeds.
    let typeCalls = 0;
    const backend = fakeBackend({
      failWhen: (step) => {
        if (step.do !== 'type') return undefined;
        typeCalls += 1;
        return typeCalls === 1 ? 'Element not found: #user' : undefined;
      },
    });
    const questions: string[] = [];
    const outcome = await runBrowserNode({
      browser: {
        on_stuck: 'agent',
        steps: [{ do: 'type', selector: '#user', text: 'ada' }],
      },
      backend,
      ask: async (q) => {
        questions.push(q);
        return 'retry';
      },
      runId: 'r1',
    });
    // fakeBackend failWhen keyed on invocation parity: first type call fails,
    // the ask-retry second call succeeds.
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('type #user');
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output?.steps).toBe(1);
  });

  it("on_stuck:'agent' with ask: a skip answer (or silence) skips the failing step", async () => {
    const backend = fakeBackend({
      failWhen: (step) => (step.do === 'type' ? 'Element not found: #user' : undefined),
    });
    const outcome = await runBrowserNode({
      browser: {
        on_stuck: 'agent',
        steps: [{ do: 'type', selector: '#user', text: 'ada' }, { do: 'key', key: 'Enter' }],
      },
      backend,
      ask: async () => null, // dismissed card — lands on the skip side
      runId: 'r1',
    });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output?.steps).toBe(1); // key ran, type skipped
  });

  it('connect failure → failed with tool_missing class and the bridge message', async () => {
    const backend = fakeBackend({ connectError: 'browser bridge unavailable — install/connect' });
    const outcome = await runBrowserNode({
      browser: { steps: [{ do: 'navigate', url: 'https://x.dev' }] },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.errorClass).toBe('tool_missing');
    expect(outcome.error).toContain('browser bridge unavailable');
  });

  it('connect failure with on_stuck:skip → whole node skipped', async () => {
    const backend = fakeBackend({ connectError: 'browser bridge unavailable' });
    const outcome = await runBrowserNode({
      browser: { on_stuck: 'skip', steps: [{ do: 'navigate', url: 'https://x.dev' }] },
      backend,
      runId: 'r1',
    });
    expect(outcome).toEqual({ status: 'skipped', output: { steps: 0 } });
    expect(backend.calls).toEqual([]);
  });

  it('step-level optional: a failed optional step is skipped even under default fail', async () => {
    const backend = fakeBackend({
      failWhen: (step) => (step.do === 'click' ? 'Element not found: .popup' : undefined),
    });
    const outcome = await runBrowserNode({
      browser: {
        start_url: 'https://x.dev',
        steps: [
          { do: 'click', selector: '.popup', optional: true },
          { do: 'type', selector: '#title', text: 'ada' },
        ],
      },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output?.steps).toBe(1); // optional click skipped, type counted
    expect(backend.calls).toEqual(['navigate https://x.dev', 'click .popup', 'type #title']);
  });

  it('optional does not mask a mandatory step failing after it', async () => {
    const backend = fakeBackend({
      failWhen: (step) => (step.do === 'type' ? 'Element not found: #user' : undefined),
    });
    const outcome = await runBrowserNode({
      browser: {
        steps: [
          { do: 'click', selector: '.popup', optional: true },
          { do: 'type', selector: '#user', text: 'ada' },
        ],
      },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('browser step 2 (type #user) failed');
  });

  it('click_text rides the generic step path (failure carries the text in the error)', async () => {
    const backend = fakeBackend({
      failWhen: (step) => (step.do === 'click_text' ? 'Text not found: 写长文' : undefined),
    });
    const outcome = await runBrowserNode({
      browser: { steps: [{ do: 'click_text', text: '写长文' }] },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('browser step 1 (click_text 写长文) failed');
  });
});

// ─── guardrails & artifacts ───

describe('runBrowserNode — guardrails & artifacts', () => {
  it('declared steps over max_actions fail loud without executing anything', async () => {
    const backend = fakeBackend();
    const outcome = await runBrowserNode({
      browser: {
        max_actions: 2,
        steps: [
          { do: 'click', selector: '#a' },
          { do: 'click', selector: '#b' },
          { do: 'click', selector: '#c' },
        ],
      },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('declares 3 steps but max_actions is 2');
    expect(backend.calls).toEqual([]);
  });

  it('screenshot bytes go to the artifact store; journal gets the ref only', async () => {
    const backend = fakeBackend();
    const store = new MemoryArtifactStore();
    const outcome = await runBrowserNode({
      browser: { steps: [{ do: 'screenshot', name: 'landing' }] },
      backend,
      artifacts: store,
      runId: 'run-9',
    });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output?.screenshots).toEqual(['run-9/landing.png']);
    const bytes = await store.get('run-9/landing.png');
    expect(bytes?.toString('utf8')).toBe('shot');
  });

  it('screenshot without an artifact store resolves saved:false (no inline base64)', async () => {
    const backend = fakeBackend();
    const outcome = await runBrowserNode({
      browser: { steps: [{ do: 'screenshot' }] },
      backend,
      runId: 'r1',
    });
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output?.screenshots).toBeUndefined();
  });

  it('auto-names screenshots when name is omitted', async () => {
    const backend = fakeBackend();
    const store = new MemoryArtifactStore();
    const outcome = await runBrowserNode({
      browser: {
        steps: [{ do: 'screenshot' }, { do: 'screenshot' }],
      },
      backend,
      artifacts: store,
      runId: 'r2',
    });
    expect(outcome.output?.screenshots).toEqual(['r2/browser-shot-1.png', 'r2/browser-shot-2.png']);
  });
});

// ─── describeBrowserStep ───

describe('describeBrowserStep', () => {
  it('renders one-line summaries per step kind', () => {
    expect(describeBrowserStep({ do: 'navigate', url: 'https://a' })).toBe('navigate https://a');
    expect(describeBrowserStep({ do: 'click', selector: '#s' })).toBe('click #s');
    expect(describeBrowserStep({ do: 'click_text', text: '发布笔记' })).toBe('click_text 发布笔记');
    expect(describeBrowserStep({ do: 'set_value', selector: '#f', value: 'v' })).toBe('set_value #f');
    expect(describeBrowserStep({ do: 'scroll', direction: 'up' })).toBe('scroll up');
    expect(describeBrowserStep({ do: 'scroll' })).toBe('scroll down');
    expect(describeBrowserStep({ do: 'wait', selector: '#w' })).toBe('wait #w');
    expect(describeBrowserStep({ do: 'wait', text: '写长文' })).toBe('wait text:写长文');
    expect(describeBrowserStep({ do: 'wait', ms: 500 })).toBe('wait');
    expect(describeBrowserStep({ do: 'screenshot', name: 'x' })).toBe('screenshot x');
  });
});
