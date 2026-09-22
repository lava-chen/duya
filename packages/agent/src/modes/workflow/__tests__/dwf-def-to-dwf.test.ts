/**
 * dwf-def-to-dwf.test.ts — def→dwf 编译器门禁：产物必须过
 * parseSavedWorkflow + compileDwfScript 双门；六类节点映射、when/插值
 * 翻译、on_error 包装、map 回调、converter 事件流端到端。
 */

import { describe, it, expect } from 'vitest';
import type { AppRef, RecorderEvent } from '@duya/computer-use';

import { convertEventsToWorkflow } from '../converter.js';
import {
  defToDwfSource,
  parseSavedWorkflow,
  serializeSavedWorkflow,
  compileDwfScript,
} from '../dwf/index.js';
import type { WorkflowDef } from '../schema.js';

// 双门：parseSavedWorkflow（frontmatter）+ compileDwfScript（esbuild 编译）。
async function assertCompiles(source: string): Promise<void> {
  const parsed = parseSavedWorkflow(source);
  if (!parsed.ok) throw new Error(`frontmatter parse failed: ${parsed.reason}: ${parsed.detail}`);
  await compileDwfScript(parsed.script);
}

// ─── fixtures ───

let clock = 0;
const ts = (): number => (clock += 100);
const appRef = (name: string, processName: string, pid: number, title = ''): AppRef => ({
  name,
  title,
  processName,
  pid,
});
const CHROME = appRef('Google Chrome', 'chrome', 4242, 'Example - Google Chrome');

function fullDef(): WorkflowDef {
  return {
    name: 'invoice-flow',
    description: '核对发票并按部门路由',
    when_to_use: '按金额分派并走审批时',
    params: [
      { name: 'invoice_id', type: 'string', required: true },
      { name: 'amount_limit', type: 'number', default: 10000 },
    ],
    phases: [
      {
        phase: 'ingest',
        title: '读取发票',
        nodes: [
          { id: 'fetch', tool: 'excel.read', input: { file: '${params.invoice_id}.xlsx' } },
        ],
      },
      {
        phase: 'route',
        title: '核对并路由',
        nodes: [
          {
            id: 'route-ticket',
            decision: {
              state: { output: '${fetch.output}' },
              questions: {
                department: { type: 'choice', criteria: { billing: '费用相关', ops: '运维相关' } },
                over_limit: { type: 'noul', instructions: '金额超过阈值吗' },
              },
              on_low_confidence: { default: 'unknown' },
            },
          },
          {
            id: 'approve',
            when: 'route-ticket.over_limit > 0.65 || params.amount_limit > 10000',
            human: {
              via: 'approval_card',
              prompt: '放行 ${fetch.output.total} 元付款(${params.invoice_id})？',
              timeout: { hours: 24, on_timeout: 'escalate' },
            },
          },
          {
            id: 'audit-each',
            when: 'count(fetch.files) > 0',
            map: { over: '${fetch.files}', as: 'f', parallel: true, concurrency: 4 },
            agent: 'general-purpose',
            prompt: '审计 ${f.path} 的正确性',
          },
          {
            id: 'report',
            agent: 'general-purpose',
            prompt: '汇总 ${route-ticket.department} 的结果',
            output_schema: { type: 'object' },
          },
          { id: 'done', when: "route-ticket.department == 'billing'", noop: true },
        ],
      },
    ],
  };
}

// ─── 双门 ───

describe('defToDwfSource — compile gates', () => {
  it('a six-kind def compiles through both gates', async () => {
    const { source, warnings } = defToDwfSource(fullDef());
    expect(warnings).toEqual([]);
    await assertCompiles(source);
  });

  it('frontmatter round-trips through serializeSavedWorkflow (deterministic bytes)', async () => {
    const { source } = defToDwfSource(fullDef());
    const parsed = parseSavedWorkflow(source);
    if (!parsed.ok) throw new Error(parsed.reason);
    const reserialized = serializeSavedWorkflow(parsed.meta, parsed.script);
    expect(reserialized).toBe(source);
  });
});

// ─── 映射正确性 ───

describe('defToDwfSource — mappings', () => {
  it('params → frontmatter args; ${params.x} → args?.x in call inputs', async () => {
    const { source } = defToDwfSource(fullDef());
    // frontmatter 由 serializeSavedWorkflow 生成（yaml block 风格，字节确定性归它管）
    expect(source).toContain('  invoice_id:\n    type: string\n    required: true');
    expect(source).toContain('  amount_limit:\n    type: number\n    default: 10000');
    expect(source).toContain('args?.invoice_id');
    expect(source).not.toContain('${params');
  });

  it('decision node → wf.decide with state interpolation and default', async () => {
    const { source } = defToDwfSource(fullDef());
    expect(source).toContain('await wf.decide(');
    expect(source).toContain('state: {\n      "output": fetch?.output');
    expect(source).toContain('onLowConfidenceDefault: "unknown"');
    // 引用链全部 camelCase 化
    expect(source).toContain('routeTicket');
  });

  it('when → if with strict equality and translated refs', async () => {
    const { source } = defToDwfSource(fullDef());
    expect(source).toContain('if (routeTicket?.over_limit > 0.65 || args?.amount_limit > 10000) {');
    // 宽松相等被收紧（正则避开 === / !== 的子串误伤）
    expect(source).toContain("routeTicket?.department === 'billing'");
    expect(source).not.toMatch(/[^=!<>]==[^=]/);
  });

  it('map node → wf.map callback with ${as} rewritten to the parameter', async () => {
    const { source } = defToDwfSource(fullDef());
    expect(source).toContain('await wf.map(fetch?.files, async (f, i) => {');
    expect(source).toContain('f?.path');
    expect(source).toContain('{ concurrency: 4 }');
  });

  it('human node → wf.approve with timeout triple', async () => {
    const { source } = defToDwfSource(fullDef());
    expect(source).toContain("await wf.approve(`放行 ${fetch?.output?.total} 元付款(${args?.invoice_id})？`");
    expect(source).toContain('timeoutHours: 24, onTimeout: "escalate"');
  });

  it('noop → wf.log stub', async () => {
    const { source } = defToDwfSource(fullDef());
    expect(source).toContain('await wf.log("noop: done")');
  });

  it('gui node (from converter annotation) → wf.gui with inlined annotation', async () => {
    const def: WorkflowDef = {
      name: 'rpa-flow',
      description: 'RPA 转换产物',
      phases: [
        {
          phase: 'p1',
          title: '操作',
          nodes: [
            {
              id: 'fill-erp',
              gui: { target_app: 'ERP*', steps: [{ do: 'capture' }, { do: 'click', element: 'som:1' }], on_stuck: 'agent' },
              annotation: { source: 'recorder', app: 'ERP', windowTitle: 'w', som: {} },
            },
          ],
        },
      ],
    };
    const { source, warnings } = defToDwfSource(def);
    expect(warnings).toEqual([]);
    expect(source).toContain('await wf.gui(');
    expect(source).toContain('target_app: "ERP*"');
    expect(source).toContain('"som:1"');
    await assertCompiles(source);
  });
});

// ─── on_error 包装 ───

describe('defToDwfSource — error semantics', () => {
  it('on_error: skip wraps the call in try/catch with a log', async () => {
    const def: WorkflowDef = {
      name: 'skip-flow',
      description: 'x',
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [{ id: 'soft-step', tool: 'fs.read', on_error: 'skip', input: { p: 1 } }],
        },
      ],
    };
    const { source } = defToDwfSource(def);
    expect(source).toContain('try {');
    expect(source).toContain("} catch (err) {");
    expect(source).toContain('on_error: skip');
    await assertCompiles(source);
  });

  it('on_error: retry wraps in a bounded retry loop', async () => {
    const def: WorkflowDef = {
      name: 'retry-flow',
      description: 'x',
      phases: [
        {
          phase: 'p',
          title: 'P',
          nodes: [{ id: 'flaky', tool: 'net.get', on_error: 'retry', max_retries: 2, input: { u: 1 } }],
        },
      ],
    };
    const { source } = defToDwfSource(def);
    expect(source).toContain('let flakyRetries = 0;');
    expect(source).toContain('if (flakyRetries >= 3) throw err;');
    await assertCompiles(source);
  });
});

// ─── 端到端：录制事件 → def → dwf 源码 ───

describe('defToDwfSource — recorder end-to-end', () => {
  it('recorded events → def → dwf source passes both gates and carries wf.gui + approve', async () => {
    const events: RecorderEvent[] = [
      { type: 'app_focus', ts: ts(), app: CHROME },
      {
        type: 'click',
        ts: ts(),
        app: CHROME,
        click: { x: 120, y: 80, button: 'left', count: 1 },
        element: { name: 'Search box', controlType: 'Edit', source: 'uia-probe' },
      },
      {
        type: 'type',
        ts: ts(),
        app: CHROME,
        text: 'hello world',
        element: { name: 'Text field', controlType: 'Edit', source: 'uia-probe' },
      },
      {
        type: 'click',
        ts: ts(),
        app: CHROME,
        click: { x: 10, y: 10, button: 'left', count: 1 },
        element: { name: 'Delete all', controlType: 'MenuItem', source: 'uia-probe' },
      },
    ];
    const converted = convertEventsToWorkflow(events);
    expect(converted.def).toBeDefined();
    const { source, warnings } = defToDwfSource(converted.def!);
    // MenuItem 点击触发前插 human 节点 → wf.approve
    expect(source).toContain('await wf.approve(');
    expect(source).toContain('await wf.gui(');
    // 转换器产出的 som annotation 完整内联进脚本
    expect(source).toContain('"source": "recorder"');
    await assertCompiles(source);
    void warnings;
  });
});
