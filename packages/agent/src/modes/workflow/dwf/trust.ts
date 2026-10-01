/**
 * trust.ts — dwf 脚本「识别器」：执行前那道门的判定规则。
 *
 * 为什么需要这个模块：`node:vm` **不是**安全边界。对 runtime.ts 里真实的
 * `createContext` 形状做了三轮实测，结论是只要往 context 注入**任何一个**宿主
 * realm 对象就能逃逸——`wf.tool` / `wf.log` / `console.log` / `args` 各自都成立，
 * 且把内建对象全部改成 context 内构造、再关掉 `codeGeneration` 也照样成立。
 * vm 的配置空间里**不存在**一个能把它调安全的旋钮，而 dwf 的整个设计就是把宿主
 * 原语桥 `wf` 注入进去。所以本模块不假装能困住脚本。
 *
 * 它做的是另一件事：**判断我们是否「认得」这段脚本**——每个 `wf.*` 成员是不是
 * 文档化的原语，源码里有没有出现逃逸词表里的词。认不出的脚本**不是被拦下**，而是
 * 在执行前连同**真实源码**一起升级给用户裁决。
 *
 * 两条必须写在最前面的诚实说明：
 *  1. 识别是「可读性」判断，**永远不是安全保证**。一段被认出的脚本若找到我们没
 *     列出的逃逸路径，它照样逃逸。
 *  2. 真正兜住「不执行未认可代码」的是升级给用户这一步，所以它必须展示脚本本体
 *     ——看不到内容就没法做知情决定。
 */

import { RULE_RISK_RE } from '../planner.js';

/**
 * `wf` 的原语面，逐字转录自 runtime.ts 的 `DwfApi`（不是从文档抄的——文档会漂）。
 * 不在此集合里的 `wf.x` 一律判为「认不出」：vm 本来也只绑定这些，跑到那里必然抛错，
 * 所以出现它意味着这段脚本不是对着本宿主写的。
 */
export const DWF_PRIMITIVES = [
  'tool',
  'gui',
  'browser',
  'agent',
  'approve',
  'ask',
  'decide',
  'map',
  'publish',
  'log',
  'phase',
] as const;

/**
 * 逃逸词表。命中即「认不出」。
 *
 * 这个表是**双刃**的：它把「构造宿主 Function 的那条路」以及它的同类写法列出来，
 * 但一份纯正则的词表**不可能穷尽**。所以命中只是升级给人看的理由，漏掉不等于安全
 * —— 上面第 1 条诚实说明就是这个意思。
 *
 * 误报方向是刻意选的：宁可多弹一次确认，也不要漏放。像 `const process = ...` 或者
 * 一段恰好提到 "constructor" 的文案都会触发，这在安全方向上是「错得多」而不是
 * 「错得少」。
 */
const ESCAPE_VOCABULARY: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // 拿到宿主 Function 构造器的那条链，以及它的等价写法。
  { pattern: /\bconstructor\b/, label: 'constructor' },
  { pattern: /\b__proto__\b/, label: '__proto__' },
  { pattern: /\bprototype\b/, label: 'prototype' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  // 宿主侧的逃逸目标。
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\bBuffer\b/, label: 'Buffer' },
  { pattern: /\bWebAssembly\b/, label: 'WebAssembly' },
  { pattern: /\bSharedArrayBuffer\b/, label: 'SharedArrayBuffer' },
  { pattern: /\bAtomics\b/, label: 'Atomics' },
  { pattern: /\bReflect\b/, label: 'Reflect' },
  { pattern: /\bProxy\b/, label: 'Proxy' },
  // 拿到代码生成 / 模块加载。
  { pattern: /\beval\s*\(/, label: 'eval(' },
  { pattern: /\bFunction\s*\(/, label: 'Function(' },
  { pattern: /\brequire\s*\(/, label: 'require(' },
  { pattern: /\bimport\s*\(/, label: 'import(' },
  // 网络与定时器：vm 本来就不该有，出现了说明脚本在够不该够的东西。
  { pattern: /\bfetch\s*\(/, label: 'fetch(' },
  { pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(|\bqueueMicrotask\s*\(/, label: 'timers' },
  // 别的运行时全局。
  { pattern: /\bDeno\b|\bBun\b/, label: 'another runtime global' },
];

/** 抽取脚本里的 `wf.tool("...")` / `wf.tool('...')` 字面量。 */
export function extractToolCalls(script: string): string[] {
  const names: string[] = [];
  const re = /\bwf\.tool\(\s*(['"`])([^'"`]+)\1/g;
  for (const match of script.matchAll(re)) {
    names.push(match[2]!);
  }
  return names;
}

export interface DwfScriptAssessment {
  /** 只有「认得」才为 true。认不出 = 需要用户裁决，不是「危险」的同义词。 */
  recognized: boolean;
  /** 认不出的理由，逐条；`recognized` 为 true 时为空。这些理由直接进确认窗。 */
  reasons: string[];
  /** 脚本用到的 `wf.*` 原语，去重后按字典序。 */
  primitives: string[];
  /** 落在 `DWF_PRIMITIVES` 之外的 `wf.*` 成员。 */
  unknownPrimitives: string[];
  /** 命中不可逆词表的 `wf.tool(...)` 字面量。 */
  highRiskCalls: string[];
}

/**
 * 识别一段 dwf 脚本。纯函数，无 IO——门禁测试可以直达。
 *
 * 判「认不出」的三种情形：调了本宿主没有的原语、源码出现逃逸词表里的词、
 * 调了不可逆工具（沿用 planner 的 `RULE_RISK_RE`，与声明式侧同一张表，
 * 免得两边的「不可逆」定义漂移）。
 */
export function assessDwfScript(script: string): DwfScriptAssessment {
  const primitives = [
    ...new Set([...script.matchAll(/\bwf\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!)),
  ].sort();
  const unknownPrimitives = primitives.filter(
    (name) => !(DWF_PRIMITIVES as readonly string[]).includes(name),
  );

  const reasons: string[] = [];
  if (unknownPrimitives.length > 0) {
    reasons.push(`calls wf members this host does not provide: ${unknownPrimitives.join(', ')}`);
  }
  for (const token of ESCAPE_VOCABULARY) {
    if (token.pattern.test(script)) reasons.push(`references \`${token.label}\``);
  }
  const highRiskCalls = extractToolCalls(script).filter((name) => RULE_RISK_RE.test(name));
  if (highRiskCalls.length > 0) {
    reasons.push(`calls irreversible tools: ${highRiskCalls.join(', ')}`);
  }

  return { recognized: reasons.length === 0, reasons, primitives, unknownPrimitives, highRiskCalls };
}

/** 源码内联进确认窗的字节上限；超过则截断并指路到真实文件。 */
const SCRIPT_INLINE_LIMIT = 4_000;

export interface DwfConsentFacts {
  name: string;
  path: string;
  scope: string;
  description: string;
  script: string;
  assessment: DwfScriptAssessment;
}

/**
 * 拼出执行前的确认文案。**必须带真实源码**——看不到内容就没法做知情决定，
 * 这是 G5 立下的纪律，这里是它的脚本版。
 *
 * 走 `toolInput.prompt` 同一个字符串字段，所以复用现有的 `workflow_approval`
 * 卡片，**不需要任何新 UI**。文案是英文：worker 进程够不到渲染层的 i18n
 * （i18n 是 renderer 侧的），要本地化得另开一条通路。
 */
export function formatDwfConsentPrompt(facts: DwfConsentFacts): string {
  const { assessment } = facts;
  const bytes = Buffer.byteLength(facts.script, 'utf8');
  const inline =
    facts.script.length <= SCRIPT_INLINE_LIMIT
      ? facts.script
      : `${facts.script.slice(0, SCRIPT_INLINE_LIMIT)}\n… (truncated — read the full file above)`;

  const lines = [
    `Run the saved workflow "${facts.name}"?`,
    `  file:    ${facts.path}`,
    `  scope:   ${facts.scope}`,
    `  summary: ${facts.description}`,
    '',
    'This script was not recognized automatically, so it needs your approval before it runs:',
    ...assessment.reasons.map((reason) => `  - ${reason}`),
  ];
  if (assessment.primitives.length > 0) {
    lines.push('', `It calls: ${assessment.primitives.map((p) => `wf.${p}`).join(', ')}`);
  }
  if (assessment.highRiskCalls.length > 0) {
    lines.push(`Irreversible tools: ${assessment.highRiskCalls.join(', ')}`);
  }
  lines.push(
    '',
    'The dwf sandbox is NOT a security boundary — approval is the only control here.',
    '',
    `Source (${bytes} bytes, from ${facts.path}):`,
    '---',
    inline,
    '---',
  );
  return lines.join('\n');
}
