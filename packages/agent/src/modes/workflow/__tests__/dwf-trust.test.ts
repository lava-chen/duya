/**
 * dwf-trust.test.ts — 执行前那道门的判定规则。
 *
 * 这里最要紧的一组用例是 **ESCAPED_PAYLOADS**：那四条不是假想的威胁模型，而是本 plan
 * 三轮实测里**逐一验证过真的能逃逸**的写法。把它们钉成回归守卫，是为了让「vm 不是
 * 沙箱」这个结论不会在某次重构后被人当成过期知识顺手删掉。
 *
 * 注意本文件**不执行**这些 payload：测试自己的进程比被测对象更不该被跑逃逸代码。
 * 这里断言的是「识别器会不会拦下它」，不是「它能不能逃」。
 */

import { describe, it, expect } from 'vitest';
import {
  DWF_PRIMITIVES,
  assessDwfScript,
  extractToolCalls,
  formatDwfConsentPrompt,
} from '../dwf/index.js';

const BENIGN = `export default async function (wf) {
  wf.phase("collect");
  const tags = await wf.tool("Bash", { cmd: "git tag --list v*" });
  await wf.publish("report.md", tags, "text/markdown");
  return "ok";
}`;

describe('assessDwfScript — recognized', () => {
  it('a script using only documented primitives is recognized', () => {
    const a = assessDwfScript(BENIGN);
    expect(a.recognized).toBe(true);
    expect(a.reasons).toEqual([]);
    expect(a.primitives).toEqual(['phase', 'publish', 'tool']);
    expect(a.highRiskCalls).toEqual([]);
  });

  it('every primitive DwfApi actually provides is in the allow-list', () => {
    // 防漂移：DWF_PRIMITIVES 必须覆盖 runtime.ts 的 DwfApi 全集。新增原语却忘了
    // 加进白名单 = 所有用到它的脚本都被判「认不出」（安全方向，但会变成骚扰）。
    expect([...DWF_PRIMITIVES].sort()).toEqual(
      ['agent', 'approve', 'ask', 'browser', 'decide', 'gui', 'log', 'map', 'phase', 'publish', 'tool'].sort(),
    );
  });

  it('injected context globals the prompt documents stay usable', () => {
    // args / JSON / Math / URL / TextEncoder / TextDecoder / console 是 vm 显式
    // 注入的，模板 prompt 明确承诺可用 —— 不能因为它们的名字而误判。
    const script = `
      const n = Math.max(1, Number(args.pr ?? 2));
      const body = JSON.stringify({ n, url: new URL('https://x.test').host });
      const s = new TextEncoder().encode(body);
      console.log(new TextDecoder().decode(s));
      return body;
    `;
    expect(assessDwfScript(script).recognized).toBe(true);
  });

  it('high-risk tool names are still caught by the shared RULE_RISK_RE table', () => {
    const a = assessDwfScript('export default async function (wf) { await wf.tool("deploy", {}); }');
    expect(a.recognized).toBe(false);
    expect(a.highRiskCalls).toEqual(['deploy']);
  });
});

describe('assessDwfScript — the four proven escapes', () => {
  /**
   * 逐条实测过的逃逸（见 plan 583「阻断性发现」）：注入的宿主 realm 对象，其
   * `.constructor.constructor` 就是宿主 Function 构造器。第三轮证明：只要注入
   * **任何**一个宿主对象即可，与 vm 自身的 codeGeneration 设置无关。
   */
  const ESCAPED_PAYLOADS: ReadonlyArray<{ label: string; script: string }> = [
    {
      label: 'wf.tool (the host bridge itself)',
      script: 'export default async function (wf) { return wf.tool.constructor.constructor("return process")(); }',
    },
    {
      label: 'wf.log',
      script: 'export default async function (wf) { return wf.log.constructor.constructor("return process")(); }',
    },
    {
      label: 'console.log',
      script: 'export default async function (wf) { return console.log.constructor.constructor("return process")(); }',
    },
    {
      label: 'args',
      script: 'export default async function (wf) { return args.constructor.constructor("return process")(); }',
    },
  ];

  for (const { label, script } of ESCAPED_PAYLOADS) {
    it(`is unrecognized: ${label}`, () => {
      const a = assessDwfScript(script);
      expect(a.recognized).toBe(false);
      expect(a.reasons.some((r) => r.includes('constructor'))).toBe(true);
    });
  }

  it('prototype / __proto__ / globalThis are the same class of attempt', () => {
    for (const script of [
      'export default async function (wf) { return wf.tool.prototype; }',
      'export default async function (wf) { return args.__proto__; }',
      'export default async function (wf) { return globalThis; }',
    ]) {
      expect(assessDwfScript(script).recognized).toBe(false);
    }
  });
});

describe('assessDwfScript — the rest of the escape vocabulary', () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ['process', 'export default async function (wf) { return process.env; }'],
    ['fetch', 'export default async function (wf) { return fetch("https://x.test"); }'],
    ['require', 'export default async function (wf) { return require("fs"); }'],
    ['dynamic import', 'export default async function (wf) { return import("fs"); }'],
    ['eval', 'export default async function (wf) { return eval("1"); }'],
    ['Function ctor', 'export default async function (wf) { return Function("return 1")(); }'],
    ['Buffer', 'export default async function (wf) { return Buffer.from("x"); }'],
    ['WebAssembly', 'export default async function (wf) { return WebAssembly; }'],
    ['timers', 'export default async function (wf) { return setTimeout(() => {}, 1); }'],
    ['Reflect', 'export default async function (wf) { return Reflect; }'],
  ];

  for (const [label, script] of CASES) {
    it(`is unrecognized: ${label}`, () => {
      expect(assessDwfScript(script).recognized).toBe(false);
    });
  }
});

describe('assessDwfScript — unknown primitives', () => {
  it('names the members this host does not provide', () => {
    const a = assessDwfScript('export default async function (wf) { return wf.exec("rm -rf /"); }');
    expect(a.recognized).toBe(false);
    expect(a.unknownPrimitives).toEqual(['exec']);
    expect(a.reasons.some((r) => r.includes('does not provide') && r.includes('exec'))).toBe(true);
  });

  it('unrecognized is never silent: recognized=false always carries a reason', () => {
    for (const script of ['', 'const a = 1;', 'wf.nope()', 'process.exit(1)']) {
      const a = assessDwfScript(script);
      if (!a.recognized) expect(a.reasons.length).toBeGreaterThan(0);
      else expect(a.reasons).toEqual([]);
    }
  });
});

describe('extractToolCalls', () => {
  it('finds wf.tool string literals across quote styles', () => {
    expect(extractToolCalls('await wf.tool("Bash", {}); wf.tool(\'Read\', x); wf.tool(`Glob`, y)')).toEqual([
      'Bash',
      'Read',
      'Glob',
    ]);
  });
});

describe('formatDwfConsentPrompt', () => {
  it('carries the reasons AND the real source — a decision needs content', () => {
    const script = 'export default async function (wf) { return wf.tool.constructor.constructor("return 1")(); }';
    const prompt = formatDwfConsentPrompt({
      name: 'from-clone',
      path: '/repo/.duya/workflows/from-clone.dwf.ts',
      scope: 'global',
      description: 'shipped by a repository',
      script,
      assessment: assessDwfScript(script),
    });
    expect(prompt).toContain('from-clone');
    expect(prompt).toContain('/repo/.duya/workflows/from-clone.dwf.ts');
    expect(prompt).toContain('constructor');
    expect(prompt).toContain('wf.tool');
    // 源码本体必须在里面：看不到内容就没法做知情决定。
    expect(prompt).toContain(script);
    // 并且要诚实说明这不是沙箱，别让用户以为点一下就等于安全。
    expect(prompt).toContain('NOT a security boundary');
  });

  it('truncates an oversized script but still points at the real file', () => {
    const script = `export default async function (wf) { /* ${'x'.repeat(9_000)} */ }`;
    const prompt = formatDwfConsentPrompt({
      name: 'big',
      path: '/u/.duya/workflows/big.dwf.ts',
      scope: 'global',
      description: 'big one',
      script,
      assessment: assessDwfScript(script),
    });
    expect(prompt).toContain('truncated');
    expect(prompt).toContain('/u/.duya/workflows/big.dwf.ts');
    expect(prompt.length).toBeLessThan(6_000);
  });
});
