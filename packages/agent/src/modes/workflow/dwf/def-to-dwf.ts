/**
 * def-to-dwf.ts — 声明式 WorkflowDef → dwf 脚本源码（plan 556 收敛面）。
 *
 * 录制转换（converter.ts）与 planner 产出的是同一形状的 WorkflowDef；本模块把
 * def 编译成 `.dwf.ts` 源码，让「录制 → 一键转工作流」直接落进 dwf 运行时：
 *
 *   params[]            → frontmatter args record（type 枚举两侧一致，零损失）
 *   顺序 phases/nodes   → 顺序 await 调用（中间结果用普通变量承载）
 *   `${...}` 模板插值   → JS 表达式（params.x → args.x，nodeId.f → var?.f）
 *   when 表达式         → if 条件（比较/逻辑/count/any/all 的受限翻译）
 *   六类节点            → wf.tool / gui / approve / decide / agent / log
 *   map                 → wf.map + 回调
 *   on_error: skip      → try/catch 继续；retry → 有界重试循环；fail → 默认抛出
 *   triggers            → 无对应（frontmatter 只有 description/whenToUse/args）——
 *                         丢弃并产出 warning
 *
 * 产物永远过得了 parseSavedWorkflow + compileDwfScript 双门（测试锁定）。
 * 表达式翻译是受限子集的直译——def 本来就过过 validateWorkflow，语义保持不变。
 */

import type {
  WorkflowDef,
  WorkflowNode,
  DecisionNodeSpec,
  GuiStep,
} from '../schema.js';
import { serializeSavedWorkflow } from './frontmatter.js';
import type { SavedWorkflowMeta } from './contracts.js';

export interface DefToDwfResult {
  /** 完整 .dwf.ts 源码（frontmatter + 脚本），保存即落盘的那一份。 */
  source: string;
  /** 非致命降级（triggers 丢弃、无法表达的结构等）——逐条人类可读。 */
  warnings: string[];
}

// ─── 命名 ───

/** kebab-case node id → 合法 JS 标识符（camelCase）。 */
function jsIdent(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9_$]/g, '_');
}

// ─── 字面量与插值 ───

/** JSON.stringify 的别名——生成的字面量永远是合法 JS/JSON。 */
const lit = (v: unknown): string => JSON.stringify(v) ?? 'null';

/** 模板字面量体转义：反引号、反斜杠、`${`。 */
function templateEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * 受限表达式 → JS 布尔表达式。def 的 when 已过 validate.ts（只允许引用/比较/
 * 逻辑/count/any/all），这里做直译：宽松相等收紧为严格，聚合换成数组方法。
 */
function translateWhen(expr: string): string {
  let out = expr;
  // 聚合原语 → 垫片调用（EXPR_HELPERS 提供实现）。
  out = out.replace(/\bcount\(\s*([^)]+?)\s*\)/g, (_m, ref: string) => `len(${ref.trim()})`);
  out = out.replace(/\bany\(\s*([^)]+?)\s*\)/g, (_m, ref: string) => `some(${ref.trim()})`);
  out = out.replace(/\ball\(\s*([^)]+?)\s*\)/g, (_m, ref: string) => `every(${ref.trim()})`);
  // 宽松相等 → 严格（JS 语义收紧，跨类型比较在 def 里本就是反模式）。
  out = out.replace(/([^=!<>])==([^=])/g, '$1===$2');
  out = out.replace(/!=([^=])/g, '!==$1');
  return translateRefs(out);
}

/**
 * 表达式内的引用翻译：`params.x` → `args?.x`，`node-id.output.y` →
 * `nodeId?.output?.y`。只动标识符链的根，数字/运算符原样保留。
 */
function translateRefs(expr: string): string {
  return expr.replace(/([a-zA-Z_][a-zA-Z0-9_-]*)((?:\.[a-zA-Z0-9_]+)*)/g, (full, root: string, rest: string) => {
    if (root === 'params') return `args${rest ? rest.replace(/\./g, '?.') : ''}`;
    if (root === 'true' || root === 'false' || root === 'null') return full;
    // 根是节点 id（kebab→camel），后续链路全部改用可选链。
    return `${jsIdent(root)}${rest ? rest.replace(/\./g, '?.') : ''}`;
  });
}

/** len/some/every 的运行时垫片——插在脚本顶部，when 的聚合原语落到这里。 */
const EXPR_HELPERS = [
  '  const len = (v) => (v === null || v === undefined ? 0 : (Array.isArray(v) ? v.length : Object.keys(v).length));',
  '  const some = (v) => (Array.isArray(v) ? v.some(Boolean) : false);',
  '  const every = (v) => (Array.isArray(v) ? v.every(Boolean) : true);',
];

/**
 * 模板字符串 → JS 表达式。整串恰为一个引用 → 直接该表达式；含 `${}` 的混合文本
 * → 模板字面量；纯文本 → JSON 字符串字面量。
 *
 * 转义顺序：先把 `${引用}` 挖成占位符，再转义**剩余文本**里的字面 `${`/反引号/
 * 反斜杠，最后把占位符还原成 `${translateRefs(inner)}`——还原出的插值不能再转义。
 */
function textToExpr(text: string): string {
  const whole = /^\$\{([^}]+)\}$/.exec(text.trim());
  if (whole) return translateRefs(whole[1]!.trim());
  if (text.includes('${')) {
    const holes: string[] = [];
    const masked = text.replace(/\$\{([^}]+)\}/g, (_m, inner: string) => {
      holes.push(translateRefs(inner.trim()));
      return `\x00${holes.length - 1}\x01`;
    });
    const escaped = masked.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    const body = escaped.replace(/\x00(\d+)\x01/g, (_m, idx: string) => `\${${holes[Number(idx)]}}`);
    return '`' + body + '`';
  }
  return lit(text);
}

/** 深度插值一个 input/state/annotation 对象：字符串按 textToExpr，其余 JSON 内联。 */
function objectToExpr(value: unknown, level: number): string {
  const pad = '  '.repeat(level + 1);
  const closePad = '  '.repeat(level);
  if (typeof value === 'string') return textToExpr(value);
  if (value === null || typeof value !== 'object') return lit(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => `${pad}${objectToExpr(v, level + 1)},`);
    return `[\n${items.join('\n')}\n${closePad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `${pad}${lit(k)}: ${objectToExpr(v, level + 1)},`,
  );
  if (entries.length === 0) return '{}';
  return `{\n${entries.join('\n')}\n${closePad}}`;
}

// ─── 节点编译（层级 L：0 = 函数体顶层） ───

/** 单个 gui step → 对象字面量（text 字段插值）。 */
function guiStepToExpr(step: GuiStep, level: number): string {
  const parts = Object.entries(step).map(([k, v]) => {
    if (k === 'text' && typeof v === 'string') return `${lit(k)}: ${textToExpr(v)}`;
    return `${lit(k)}: ${lit(v)}`;
  });
  if (parts.length === 1) return `{ ${parts[0]} }`;
  const pad = '  '.repeat(level + 1);
  return `{\n${pad}${parts.join(`,\n${pad}`)},\n${'  '.repeat(level)}}`;
}

/** 主体调用行（不含 when/on_error 包装）。 */
function callLines(node: WorkflowNode, varName: string, L: number, warnings: string[]): string[] {
  const pad = '  '.repeat(L);
  const inner = L + 1;

  // map 是包装原语，必须先于它包住的 agent/tool 判定。
  if (node.map) {
    return mapCallLines(node, varName, L, warnings);
  }

  if (node.tool) {
    const args = node.input ? `${lit(node.tool)}, ${objectToExpr(node.input, inner)}` : lit(node.tool);
    return [`const ${varName} = await wf.tool(${args});`];
  }

  if (node.gui) {
    const steps = node.gui.steps.map((s) => `${'  '.repeat(inner)}${guiStepToExpr(s, inner)},`).join('\n');
    const spec =
      `{\n${pad}  target_app: ${lit(node.gui.target_app)},\n${pad}  steps: [\n${steps}\n${pad}  ],` +
      (node.gui.max_actions !== undefined ? `\n${pad}  max_actions: ${node.gui.max_actions},` : '') +
      (node.gui.on_stuck !== undefined ? `\n${pad}  on_stuck: ${lit(node.gui.on_stuck)},` : '') +
      `\n${pad}}`;
    const opts = node.annotation ? `, { annotation: ${objectToExpr(node.annotation, inner)} }` : '';
    return [`const ${varName} = await wf.gui(${spec}${opts});`];
  }

  if (node.agent) {
    const prompt = textToExpr(node.prompt ?? '');
    const opts: string[] = [];
    if (node.model) opts.push(`model: ${lit(node.model)}`);
    if (node.output_schema) opts.push(`outputSchema: ${objectToExpr(node.output_schema, inner)}`);
    const optsArg = opts.length > 0 ? `, { ${opts.join(', ')} }` : '';
    return [`const ${varName} = await wf.agent(${lit(node.agent)}, ${prompt}${optsArg});`];
  }

  if (node.human) {
    const prompt = textToExpr(node.human.prompt);
    const t = node.human.timeout;
    return [`await wf.approve(${prompt}, { timeoutHours: ${t.hours}, onTimeout: ${lit(t.on_timeout)} });`];
  }

  if (node.decision) {
    return decisionCallLines(node.decision, varName, L, warnings);
  }

  if (node.noop) {
    return [`await wf.log(${lit(`noop: ${node.id}`)});`];
  }

  warnings.push(`node "${node.id}" has no recognized kind — emitted as a log stub`);
  return [`await wf.log(${lit(`unmapped node: ${node.id}`)});`];
}

/** decision 节点 → wf.decide 调用（questions 字面 + state 深插值 + 灰带语义）。 */
function decisionCallLines(spec: DecisionNodeSpec, varName: string, L: number, warnings: string[]): string[] {
  const pad = '  '.repeat(L);
  const questions = Object.entries(spec.questions).map(([q, qspec]) => {
    const body = Object.entries(qspec)
      .map(([k, v]) => `${lit(k)}: ${lit(v)}`)
      .join(', ');
    return `${pad}  ${lit(q)}: { ${body} },`;
  });
  const opts: string[] = [];
  if (spec.state) opts.push(`state: ${objectToExpr(spec.state, L)}`);
  if (spec.thresholds) opts.push(`thresholds: ${lit(spec.thresholds)}`);
  if (spec.on_low_confidence === 'skip') {
    warnings.push(
      'decision on_low_confidence: skip has no direct dwf equivalent — decide throws on low confidence; wrap the call in try/catch yourself',
    );
  } else if (typeof spec.on_low_confidence === 'object' && spec.on_low_confidence !== null) {
    opts.push(`onLowConfidenceDefault: ${lit(spec.on_low_confidence.default)}`);
  }
  // 'ask' → 不传 default：决策面低置信时 decide 抛错（人工介入语义）。
  const optsArg = opts.length > 0 ? `{\n${pad}  ${opts.join(`,\n${pad}  `)},\n${pad}}` : '';
  return [
    `const ${varName} = await wf.decide({\n${questions.join('\n')}\n${pad}}${optsArg ? `, ${optsArg}` : ''});`,
  ];
}

/** map 节点 → wf.map + 回调（被包的 agent/tool 体进回调，`${as}` → 参量）。 */
function mapCallLines(node: WorkflowNode, varName: string, L: number, warnings: string[]): string[] {
  const map = node.map!;
  const items = translateRefs(map.over.replace(/^\$\{/, '').replace(/\}$/, '').trim());
  const asVar = map.as;

  const rewrite = (text: string): string =>
    textToExpr(
      text
        // `${as}` / `${as.field}` → `${asVar?...}`，再走普通引用翻译
        .replace(new RegExp(`\\$\\{\\s*${map.as}((?:\\.[a-zA-Z0-9_]+)*)\\s*\\}`, 'g'), (_m, rest: string) => `\${${asVar}${rest}}`),
    );

  let innerLines: string[];
  if (node.agent) {
    const opts: string[] = [];
    if (node.model) opts.push(`model: ${lit(node.model)}`);
    if (node.output_schema) opts.push(`outputSchema: ${objectToExpr(node.output_schema, L + 1)}`);
    const optsArg = opts.length > 0 ? `, { ${opts.join(', ')} }` : '';
    innerLines = [`return await wf.agent(${lit(node.agent)}, ${rewrite(node.prompt ?? '')}${optsArg});`];
  } else if (node.tool) {
    const input = node.input ? objectToExpr(node.input, L + 1) : undefined;
    innerLines = [`return await wf.tool(${lit(node.tool)}${input !== undefined ? `, ${input}` : ''});`];
  } else {
    warnings.push(`map node "${node.id}" wraps neither agent nor tool — emitted as a log stub`);
    innerLines = [`return await wf.log(${lit(`unmapped map body: ${node.id}`)});`];
  }

  const pad = '  '.repeat(L);
  const concurrency = map.concurrency !== undefined ? `, { concurrency: ${map.concurrency} }` : '';
  return [
    `const ${varName} = await wf.map(${items}, async (${asVar}, i) => {`,
    ...innerLines.map((l) => `${pad}  ${l}`),
    `${pad}}${concurrency});`,
  ];
}

// ─── 包装：when 条件 + on_error 语义（层级化，一次生成） ───

function compileNode(node: WorkflowNode, L: number, warnings: string[]): string[] {
  const pad = '  '.repeat(L);
  const lines: string[] = [`// node: ${node.id}`];
  const inner = callLines(node, jsIdent(node.id), L + 1, warnings).map((l) => `${pad}  ${l}`);
  // 闭合顺序 = 开括号逆序（内层先闭）：errClose（try/for）先于 whenClose（if）。
  const whenClose: string[] = [];
  const errClose: string[] = [];

  if (node.when) {
    lines.push(`${pad}if (${translateWhen(node.when)}) {`);
    whenClose.push(`${pad}}`);
  }
  if (node.on_error === 'skip') {
    lines.push(`${pad}try {`);
    errClose.push(
      `${pad}} catch (err) {`,
      `${pad}  await wf.log(${lit(`node ${node.id} failed (on_error: skip)`)} + ': ' + (err instanceof Error ? err.message : String(err)));`,
      `${pad}}`,
    );
  } else if (node.on_error === 'retry') {
    const tries = 1 + (node.max_retries ?? 1);
    const rv = `${jsIdent(node.id)}Retries`;
    lines.push(`${pad}let ${rv} = 0;`);
    lines.push(`${pad}for (;;) {`);
    lines.push(`${pad}  try {`);
    errClose.push(
      `${pad}  } catch (err) {`,
      `${pad}    ${rv} += 1;`,
      `${pad}    if (${rv} >= ${tries}) throw err;`,
      `${pad}    await wf.log(${lit(`node ${node.id} retry`)} + ' ' + ${rv});`,
      `${pad}  }`,
      `${pad}  break;`,
      `${pad}}`,
    );
  }

  // 内层调用行按包装深度再补缩进。
  const depth = (node.when ? 1 : 0) + (node.on_error === 'skip' || node.on_error === 'retry' ? 1 : 0);
  const shifted = depth > 0 ? inner.map((l) => (l.length > 0 ? '  '.repeat(depth) + l : l)) : inner;
  lines.push(...shifted, ...errClose, ...whenClose);
  return lines;
}

// ─── frontmatter ───

/**
 * def → SavedWorkflowMeta。frontmatter 的**字节**由 serializeSavedWorkflow 单点
 * 负责（键序、引号、折叠）——这里手拼一份迟早和它漂移，保存→读取就不再逐字节
 * 相同，而含冒号的 description（转换器常见的英文句子）手拼还过不了 YAML。
 */
function metaForDef(def: WorkflowDef): SavedWorkflowMeta {
  const meta: SavedWorkflowMeta = {
    description: def.description.trim() || '(converted workflow)',
  };
  if (def.when_to_use) meta.whenToUse = def.when_to_use;
  if (def.params && def.params.length > 0) {
    const args: NonNullable<SavedWorkflowMeta['args']> = {};
    for (const p of def.params) {
      const decl: NonNullable<SavedWorkflowMeta['args']>[string] = { type: p.type };
      if (p.required) decl.required = true;
      if (p.default !== undefined) decl.default = p.default;
      args[p.name] = decl;
    }
    meta.args = args;
  }
  return meta;
}

// ─── 主入口 ───

/**
 * 声明式 def → 完整 dwf 源码。纯函数：不校验（调用方先 validateWorkflow）、
 * 不落盘、不抛——无法表达的结构降级为 warning + 尽力转换。
 */
export function defToDwfSource(def: WorkflowDef): DefToDwfResult {
  const warnings: string[] = [];
  const body: string[] = [...EXPR_HELPERS, ''];

  for (const phase of def.phases) {
    body.push(`// ── phase: ${phase.phase} — ${phase.title} ──`);
    if (phase.detail) body.push(`// ${phase.detail}`);
    for (const node of phase.nodes) {
      body.push(...compileNode(node, 1, warnings));
    }
    body.push('');
  }

  if (def.triggers && def.triggers.length > 0) {
    warnings.push(
      `triggers (${def.triggers.map((t) => Object.keys(t)[0]).join(', ')}) have no dwf frontmatter equivalent — dropped; schedule the run through the host instead`,
    );
  }

  const script = [
    '// Converted from a declarative def by defToDwfSource — hand-edit freely.',
    'export default async function (wf) {',
    ...body,
    '}',
    '',
  ].join('\n');

  const source = serializeSavedWorkflow(metaForDef(def), script);
  return { source, warnings };
}
