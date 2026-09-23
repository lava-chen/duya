/**
 * dwf-runtime.test.ts — dwf 脚本运行时 + planner 的门禁测试：
 * 编译/沙箱隔离、wf 原语的 journal 缓存经济学（resume 免重付）、approve 三态、
 * decide 不可用回退、map 并发与保序、publish/log、预算耗尽；planner 的
 * 「模型生成、代码裁决」与风险扫描。
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Journal,
  MemoryJournalSink,
} from '../journal.js';
import { BudgetLedger } from '../host.js';
import type { HostCallResult, HostAgentSpec } from '../host.js';
import {
  SavedWorkflowStore,
  compileDwfScript,
  runDwfScript,
  DwfApprovalDeniedError,
  DwfBudgetError,
  DwfCompileError,
  DwfWorkflowPlanner,
  extractToolCalls,
  scanDwfRisk,
  serializeSavedWorkflow,
  type DwfHostPorts,
} from '../dwf/index.js';

// ─── fake ports ───

function fakePorts(overrides: Partial<DwfHostPorts> = {}): DwfHostPorts & {
  toolCalls: string[];
  agentCalls: string[];
  approvals: string[];
  guiCalls: string[];
} {
  const toolCalls: string[] = [];
  const agentCalls: string[] = [];
  const approvals: string[] = [];
  const guiCalls: string[] = [];
  return {
    toolCalls,
    agentCalls,
    approvals,
    guiCalls,
    async runTool(tool: string, input: unknown) {
      toolCalls.push(`${tool}:${JSON.stringify(input)}`);
      return { ok: true, output: { echoed: input, tool } } satisfies HostCallResult;
    },
    async runAgent(spec: HostAgentSpec) {
      agentCalls.push(`${spec.agent}:${spec.prompt}`);
      return { ok: true, output: { done: true, prompt: spec.prompt } } satisfies HostCallResult;
    },
    async runGui(spec) {
      guiCalls.push(`${spec.target_app}:${spec.steps.length}`);
      return { status: 'succeeded', output: { app: spec.target_app, steps: spec.steps.length } };
    },
    async requestApproval(spec) {
      approvals.push(spec.prompt);
      return { decision: 'approve' as const };
    },
    ...overrides,
  };
}

const SIMPLE_SCRIPT = `
export default async function (wf) {
  const r = await wf.tool("Bash", { cmd: "echo hi" });
  await wf.publish("result", r);
  return r;
}`;

// ─── compile + sandbox ───

describe('dwf runtime — compile & sandbox', () => {
  it('compiles export default and returns the script value', async () => {
    const fn = await compileDwfScript('export default async function (wf) { return 42; }');
    const ports = fakePorts();
    const result = await runDwfScript('export default async function (wf) { return 42; }', ports, {
      runId: 'r1',
      journal: Journal.memory(),
    });
    expect(result).toBe(42);
    expect(fn).toBeTypeOf('function');
    void ports;
  });

  it('missing default export fails with a named compile error', async () => {
    await expect(compileDwfScript('export const x = 1;')).rejects.toBeInstanceOf(DwfCompileError);
  });

  it('syntax errors surface as DwfCompileError with the message', async () => {
    await expect(compileDwfScript('export default async function (wf) { const = ; }')).rejects.toBeInstanceOf(
      DwfCompileError,
    );
  });

  it('sandbox has no process/require/fetch — wf is the only channel out', async () => {
    const script = `
      export default async function (wf) {
        return { proc: typeof process, req: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout };
      }`;
    const result = (await runDwfScript(script, fakePorts(), { runId: 'r1', journal: Journal.memory() })) as Record<string, string>;
    expect(result.proc).toBe('undefined');
    expect(result.req).toBe('undefined');
    expect(result.fetch).toBe('undefined');
    expect(result.setTimeout).toBe('undefined');
  });

  it('args global is injected; JSON/Math are available', async () => {
    const script = `
      export default async function (wf) {
        return { name: args.name, sum: Math.round(JSON.parse("[1,2]").length * 1.5) };
      }`;
    const result = (await runDwfScript(script, fakePorts(), {
      runId: 'r1',
      journal: Journal.memory(),
      args: { name: 'duya' },
    })) as Record<string, unknown>;
    expect(result.name).toBe('duya');
    expect(result.sum).toBe(3);
  });
});

// ─── wf primitives + journal economics ───

describe('dwf runtime — wf primitives', () => {
  it('tool/agent/publish flow journals node_result + artifact records', async () => {
    const sink = new MemoryJournalSink();
    const ports = fakePorts();
    await runDwfScript(SIMPLE_SCRIPT, ports, { runId: 'r1', journal: new Journal(sink) });
    expect(ports.toolCalls).toHaveLength(1);
    const kinds = sink.readAll().map((r) => r.kind);
    expect(kinds).toContain('node_result');
    expect(kinds).toContain('artifact');
    const publish = sink.readAll().find((r) => r.kind === 'artifact');
    expect(publish?.result).toMatchObject({ name: 'result', content: { tool: 'Bash' } });
  });

  it('re-running against the same journal hits the cache — host is not called twice', async () => {
    const sink = new MemoryJournalSink();
    const ports = fakePorts();
    await runDwfScript(SIMPLE_SCRIPT, ports, { runId: 'r1', journal: new Journal(sink) });
    // resume：同一 sink 重建 journal（缓存从已成功记录重建）。
    const ports2 = fakePorts();
    await runDwfScript(SIMPLE_SCRIPT, ports2, { runId: 'r1', journal: new Journal(sink), resuming: true });
    expect(ports2.toolCalls).toHaveLength(0); // 缓存命中，宿主零调用
  });

  it('wf.gui resolves with the outcome output and journals a gui record', async () => {
    const sink = new MemoryJournalSink();
    const script = `
      export default async function (wf) {
        return await wf.gui(
          { target_app: "ERP*", steps: [{ do: "capture" }, { do: "click", element: "som:1" }], on_stuck: "agent" },
          { annotation: { source: "recorder", app: "ERP", windowTitle: "w", som: {} } },
        );
      }`;
    const result = await runDwfScript(script, fakePorts(), { runId: 'r1', journal: new Journal(sink) });
    expect(result).toMatchObject({ app: 'ERP*', steps: 2 });
    const guiRecord = sink.readAll().find((r) => r.nodeKind === 'gui');
    expect(guiRecord?.status).toBe('succeeded');
    expect(guiRecord?.action).toBe('gui:ERP*');
  });

  it('wf.gui resume hits the journal cache — runGui is not called twice', async () => {
    const sink = new MemoryJournalSink();
    const script = `
      export default async function (wf) {
        return await wf.gui({ target_app: "ERP*", steps: [{ do: "capture" }], on_stuck: "agent" });
      }`;
    await runDwfScript(script, fakePorts(), { runId: 'r1', journal: new Journal(sink) });
    const ports2 = fakePorts();
    await runDwfScript(script, ports2, { runId: 'r1', journal: new Journal(sink), resuming: true });
    expect(ports2.guiCalls).toHaveLength(0);
  });

  it('wf.gui failure throws with the outcome error and journals the failure class', async () => {
    const sink = new MemoryJournalSink();
    const script = `
      export default async function (wf) {
        try {
          await wf.gui({ target_app: "ERP*", steps: [{ do: "capture" }], on_stuck: "agent" });
          return 'no-throw';
        } catch (e) {
          return { threw: e.message };
        }
      }`;
    const ports = fakePorts({
      async runGui() {
        return { status: 'failed', error: 'element som:1 not found', verification: 'unconfirmed' };
      },
    });
    const result = (await runDwfScript(script, ports, { runId: 'r1', journal: new Journal(sink) })) as Record<string, unknown>;
    expect(result.threw).toBe('element som:1 not found');
    const failed = sink.readAll().find((r) => r.nodeKind === 'gui');
    expect(failed?.status).toBe('failed');
    expect(failed?.errorClass).toBeTruthy();
  });

  it('wf.gui skipped outcome resolves null and keeps the script going', async () => {
    const script = `
      export default async function (wf) {
        const out = await wf.gui({ target_app: "ERP*", steps: [{ do: "capture" }], on_stuck: "agent" });
        return { out };
      }`;
    const result = await runDwfScript(
      script,
      fakePorts({ async runGui() { return { status: 'skipped' }; } }),
      { runId: 'r1', journal: Journal.memory() },
    );
    expect(result).toEqual({ out: null });
  });

  // ─── wf.browser（plan 564）───

  function fakePortsWithBrowser(overrides: Partial<DwfHostPorts> = {}): DwfHostPorts & {
    browserCalls: string[];
  } {
    const browserCalls: string[] = [];
    return {
      browserCalls,
      async runBrowser(spec) {
        browserCalls.push(spec.start_url ?? spec.steps[0]?.do ?? 'browser');
        return {
          status: 'succeeded',
          output: { url: spec.start_url, steps: spec.steps.length },
        };
      },
      ...overrides,
    } as DwfHostPorts & { browserCalls: string[] };
  }

  it('wf.browser resolves the outcome output and journals nodeKind browser', async () => {
    const sink = new MemoryJournalSink();
    const script = `
      export default async function (wf) {
        return await wf.browser({
          start_url: "https://example.com",
          steps: [{ do: "click", selector: "#login" }],
        });
      }`;
    const ports = fakePortsWithBrowser();
    const result = await runDwfScript(script, ports, { runId: 'r1', journal: new Journal(sink) });
    expect(result).toMatchObject({ url: 'https://example.com', steps: 1 });
    const record = sink.readAll().find((r) => r.nodeKind === 'browser');
    expect(record?.status).toBe('succeeded');
    expect(record?.action).toBe('browser:https://example.com');
    // inputSummary 是卡片步骤行那一行（§6.1 display-only）：start_url 前缀 + 首步。
    expect(record?.inputSummary).toBe('https://example.com: click #login');
  });

  it('wf.browser resume hits the journal cache — runBrowser is not called twice', async () => {
    const sink = new MemoryJournalSink();
    const script = `
      export default async function (wf) {
        return await wf.browser({ steps: [{ do: "click", selector: "#a" }] });
      }`;
    await runDwfScript(script, fakePortsWithBrowser(), { runId: 'r1', journal: new Journal(sink) });
    const ports2 = fakePortsWithBrowser();
    await runDwfScript(script, ports2, { runId: 'r1', journal: new Journal(sink), resuming: true });
    expect(ports2.browserCalls).toHaveLength(0);
  });

  it('wf.browser failure throws with the outcome error; skipped resolves null', async () => {
    const sink = new MemoryJournalSink();
    const script = `
      export default async function (wf) {
        try {
          await wf.browser({ steps: [{ do: "click", selector: "#a" }] });
          return 'no-throw';
        } catch (e) {
          return { threw: e.message };
        }
      }`;
    const ports = fakePortsWithBrowser({
      async runBrowser() {
        return { status: 'failed', error: 'browser step 1 (click #a) failed: boom' };
      },
    });
    const result = (await runDwfScript(script, ports, { runId: 'r1', journal: new Journal(sink) })) as Record<string, unknown>;
    expect(result.threw).toBe('browser step 1 (click #a) failed: boom');
    const failed = sink.readAll().find((r) => r.nodeKind === 'browser');
    expect(failed?.status).toBe('failed');

    const skipped = await runDwfScript(
      'export default async function (wf) { return await wf.browser({ on_stuck: "skip", steps: [] }); }',
      fakePortsWithBrowser({ async runBrowser() { return { status: 'skipped', output: { steps: 0 } }; } }),
      { runId: 'r2', journal: Journal.memory() },
    );
    expect(skipped).toBe(null);
  });

  it('wf.browser without a bound port fails loudly', async () => {
    const script = `
      export default async function (wf) {
        try {
          await wf.browser({ steps: [] });
          return 'no-throw';
        } catch (e) {
          return { threw: e.message };
        }
      }`;
    const result = (await runDwfScript(script, fakePorts(), { runId: 'r1', journal: Journal.memory() })) as Record<string, unknown>;
    expect(result.threw).toContain('wf.browser is not bound');
  });

  it('approve resolves on approve; deny throws; timeout+skip returns null', async () => {
    const script = (decision: string) => `
      export default async function (wf) {
        try {
          const out = await wf.approve("Ship it?", { onTimeout: '${decision}' });
          return { out };
        } catch (e) {
          return { denied: true, name: e.name };
        }
      }`;

    const ok = await runDwfScript(script('fail'), fakePorts(), { runId: 'r1', journal: Journal.memory() });
    expect(ok).toEqual({ out: undefined }); // approve 成功 → undefined（脚本继续的信号）

    const denied = (await runDwfScript(script('fail'), fakePorts({ async requestApproval() { return { decision: 'deny' as const }; } }), {
      runId: 'r2',
      journal: Journal.memory(),
    })) as Record<string, unknown>;
    expect(denied.denied).toBe(true);
    expect(denied.name).toBe('DwfApprovalDeniedError');

    const skipped = await runDwfScript(
      script('skip'),
      fakePorts({ async requestApproval() { return { decision: 'timeout' as const }; } }),
      { runId: 'r3', journal: Journal.memory() },
    );
    expect(skipped).toEqual({ out: null });
  });

  it('approve timeout with onTimeout fail escalates via DwfApprovalDeniedError', async () => {
    const script = `
      export default async function (wf) {
        try { await wf.approve("Delete prod?", { onTimeout: 'fail' }); return 'passed'; }
        catch (e) { return { name: e.name, kind: e.kind }; }
      }`;
    const result = (await runDwfScript(
      script,
      fakePorts({ async requestApproval() { return { decision: 'timeout' as const }; } }),
      { runId: 'r1', journal: Journal.memory() },
    )) as Record<string, unknown>;
    expect(result.name).toBe('DwfApprovalDeniedError');
    expect(result.kind).toBe('escalate');
  });

  it('decide uses the backend when available', async () => {
    const script = `
      export default async function (wf) {
        return await wf.decide({ route: { type: 'choice', criteria: { fast: '', safe: '' } } }, { state: { q: 1 } });
      }`;
    const ports = fakePorts({
      decide: {
        available: true,
        async run(questions) {
          const out: Record<string, string | number> = {};
          for (const id of Object.keys(questions)) out[id] = 'fast';
          return { answers: {}, output: out, lowConfidence: [], source: 'decision' };
        },
      },
    });
    const result = (await runDwfScript(script, ports, { runId: 'r1', journal: Journal.memory() })) as Record<string, unknown>;
    expect(result.route).toBe('fast');
  });

  it('decide without a backend and without a default throws with the gray-band ids', async () => {
    const script = `
      export default async function (wf) {
        return await wf.decide({ route: { type: 'choice', criteria: { a: '', b: '' } } });
      }`;
    await expect(
      runDwfScript(script, fakePorts(), { runId: 'r1', journal: Journal.memory() }),
    ).rejects.toThrow(/decision uncertain for: route/);
  });

  it('decide without a backend falls back to onLowConfidenceDefault', async () => {
    const script = `
      export default async function (wf) {
        return await wf.decide({ route: { type: 'choice', criteria: { a: '', b: '' } } }, { onLowConfidenceDefault: 'b' });
      }`;
    const result = (await runDwfScript(script, fakePorts(), { runId: 'r1', journal: Journal.memory() })) as Record<string, unknown>;
    expect(result.route).toBe('b');
  });

  it('map preserves order and respects concurrency', async () => {
    const script = `
      export default async function (wf) {
        return await wf.map([1, 2, 3, 4, 5], async (n) => n * 2, { concurrency: 2 });
      }`;
    const result = await runDwfScript(script, fakePorts(), { runId: 'r1', journal: Journal.memory() });
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it('agent budget exhaustion surfaces as DwfBudgetError', async () => {
    const script = `
      export default async function (wf) {
        await wf.agent("researcher", "one");
      }`;
    await expect(
      runDwfScript(script, fakePorts(), {
        runId: 'r1',
        journal: Journal.memory(),
        budget: new BudgetLedger(0),
      }),
    ).rejects.toBeInstanceOf(DwfBudgetError);
  });

  it('failed tool calls journal a failed record (no cache poisoning)', async () => {
    const sink = new MemoryJournalSink();
    const script = `export default async function (wf) { await wf.tool("Bash", {}); }`;
    const ports = fakePorts({ async runTool() { return { ok: false, error: 'boom' } satisfies HostCallResult; } });
    await expect(runDwfScript(script, ports, { runId: 'r1', journal: new Journal(sink) })).rejects.toThrow('boom');
    const failed = sink.readAll().filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.errorClass).toBeDefined();
  });

  it('console.log routes into the journal as log records', async () => {
    const sink = new MemoryJournalSink();
    const script = `export default async function (wf) { console.log("hello", { a: 1 }); }`;
    await runDwfScript(script, fakePorts(), { runId: 'r1', journal: new Journal(sink) });
    const log = sink.readAll().find((r) => r.action === 'log');
    expect(log?.result).toContain('hello');
  });

  it('onJournalEvent tap receives every record (live progress)', async () => {
    const tap = vi.fn();
    await runDwfScript(SIMPLE_SCRIPT, fakePorts({ onJournalEvent: tap }), { runId: 'r1', journal: Journal.memory() });
    expect(tap).toHaveBeenCalled();
  });
});

// ─── planner ───

describe('dwf planner', () => {
  const VALID_SOURCE = serializeSavedWorkflow(
    { description: 'Review a PR.', args: { pr: { type: 'string', required: true } } },
    'export default async function (wf) { const d = await wf.tool("Bash", { cmd: "git diff" }); return d; }',
  );

  it('extractToolCalls finds wf.tool string literals across quote styles', () => {
    expect(extractToolCalls('await wf.tool("Bash", {}); wf.tool(\'Read\', x); wf.tool(`Glob`, y)')).toEqual([
      'Bash',
      'Read',
      'Glob',
    ]);
  });

  it('scanDwfRisk flags irreversible tool names and ungated publishes', () => {
    const { highRiskCalls, warnings } = scanDwfRisk('await wf.tool("deploy", {}); await wf.publish("r", 1);');
    expect(highRiskCalls).toEqual(['deploy']);
    expect(warnings.some((w) => w.includes('publishes'))).toBe(true);
  });

  it('plan accepts a valid source on the first attempt', async () => {
    const planner = new DwfWorkflowPlanner(async () => VALID_SOURCE);
    const result = await planner.plan({ goal: 'review PR 7' });
    expect(result.meta.description).toBe('Review a PR.');
    expect(result.script).toContain('export default');
    expect(result.source).toBe(VALID_SOURCE);
    expect(result.highRiskCalls).toEqual([]);
  });

  it('feeds errors back once on an invalid draft, then accepts the fix', async () => {
    const drafts = ['not a workflow at all', VALID_SOURCE];
    const prompts: string[] = [];
    const planner = new DwfWorkflowPlanner(async (prompt) => {
      prompts.push(prompt);
      return drafts[prompts.length - 1]!;
    });
    const result = await planner.plan({ goal: 'x' });
    expect(result.meta.description).toBe('Review a PR.');
    expect(prompts[1]).toContain('Your previous attempt was INVALID');
  });

  it('aborts after the second invalid attempt with both error sets', async () => {
    const planner = new DwfWorkflowPlanner(async () => 'garbage');
    await expect(planner.plan({ goal: 'x' })).rejects.toThrow(/dwf planner failed after retry/);
  });

  it('saved planner output round-trips through the store', async () => {
    const planner = new DwfWorkflowPlanner(async () => VALID_SOURCE);
    const result = await planner.plan({ goal: 'x' });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dwf-planner-'));
    try {
      const store = new SavedWorkflowStore();
      store.save(cwd, 'pr-review', result.meta, result.script, 'project', { homeDir: cwd });
      const hit = store.resolve(cwd, 'pr-review', { homeDir: cwd });
      expect(hit.ok).toBe(true);
      if (hit.ok) expect(hit.script).toBe(result.script);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
