/**
 * planner-dwf.ts — LLM 生成 dwf 脚本（Phase 3），代码裁决校验。
 *
 * 沿用声明式 planner（../planner.ts）的「模型生成，代码裁决」原则：LLM 只起草
 * `.dwf.ts` 源码，frontmatter 校验、语法编译、风险扫描全部确定性。parse/compile
 * 失败把错误清单回喂 LLM 一次；第二次失败中止——绝不出半成品。
 *
 * 风险预筛（v1 规则面）：扫脚本里的 `wf.tool("...")` 字面量与 `wf.publish`/
 * `wf.approve` 存在性——命中不可逆词表的 tool 调用或有 publish 的脚本标记为
 * highRisk（run 从 awaiting_confirm 起步）。声明式 planner 的 Jev 决策面 pass
 * 需要按调用点构造 state，留到宿主绑定阶段（见 plan 552 §13 同样的位置）。
 */

import type { SavedWorkflowMeta } from './contracts.js';
import { parseSavedWorkflow } from './frontmatter.js';
import { compileDwfScript, DwfCompileError } from './runtime.js';
import { RULE_RISK_RE } from '../planner.js';

/** LLM 端口（生产：AIClient one-shot；测试：canned）。与声明式 planner 同形。 */
export type DwfPlannerLlm = (prompt: string) => Promise<string>;

export interface DwfPlannerInput {
  goal: string;
  /** 额外上下文（workingDirectory、可用 agent 类型、AGENTS.md digest）。 */
  context?: string;
  /** 脚本可用的 agent 类型（wf.agent 的合法取值）。 */
  agents?: readonly string[];
  /** 脚本可用的工具名（wf.tool 的合法取值）。 */
  tools?: readonly string[];
}

export interface DwfPlannerResult {
  meta: SavedWorkflowMeta;
  /** 脚本本体（frontmatter 之后，逐字节）。 */
  script: string;
  /** 完整文件源码（frontmatter + 脚本），保存即落盘的那一份。 */
  source: string;
  /** 命中不可逆词表的 tool 调用（run 从 awaiting_confirm 起步）。 */
  highRiskCalls: string[];
  warnings: string[];
}

/** 抽取脚本里的 `wf.tool("...")` / `wf.tool('...')` 字面量。 */
export function extractToolCalls(script: string): string[] {
  const names: string[] = [];
  const re = /\bwf\.tool\(\s*(['"`])([^'"`]+)\1/g;
  for (const match of script.matchAll(re)) {
    names.push(match[2]!);
  }
  return names;
}

/** 规则风险扫描：不可逆词表命中 + publish 存在性。纯函数，测试可直达。 */
export function scanDwfRisk(script: string): { highRiskCalls: string[]; warnings: string[] } {
  const highRiskCalls = extractToolCalls(script).filter((name) => RULE_RISK_RE.test(name));
  const warnings: string[] = [];
  if (/\bwf\.publish\s*\(/.test(script)) {
    warnings.push('script publishes artifacts — confirm the artifact channel is expected');
  }
  if (!/\bwf\.approve\s*\(/.test(script) && highRiskCalls.length > 0) {
    warnings.push('irreversible tool calls present without any wf.approve gate — run starts at awaiting_confirm');
  }
  return { highRiskCalls, warnings };
}

export const PLANNER_DWF_SYSTEM_PROMPT = `You translate an automation goal into a duya dwf script — a TypeScript file saved as <name>.dwf.ts.

File shape (STRICT):
/* duya-workflow
description: <one line, required>
whenToUse: <optional, when should this workflow run>
args:
  <arg_name>: { type: string|number|boolean, required: true?, default?: <json> }
*/
export default async function (wf) {
  // ...
}

The frontmatter is a block comment with a YAML body (description, optional whenToUse, optional args record). The body after the comment is plain TypeScript executed in a sandbox with EXACTLY these host primitives:
- wf.tool(name, input) — deterministic zero-LLM tool call. Resolve with the tool's output.
- wf.agent(type, prompt, opts?) — subagent task; opts = { model?, outputSchema? }. Resolve with the agent's final output.
- wf.approve(prompt, { timeoutHours?, onTimeout }) — human approval. onTimeout: 'fail' | 'skip' | 'escalate'. Denial THROWS. REQUIRED before any irreversible side effect (payments, sending, deletion).
- wf.decide(questions, { state?, thresholds?, onLowConfidenceDefault? }) — typed classification over the decision backend. Question shapes: { type: 'choice', criteria: {option: description}, instructions? } | { type: 'noul', instructions } | { type: 'score', levels: [..], instructions }.
- wf.map(items, async (item, index) => ..., { concurrency? }) — fan-out.
- wf.publish(name, content, contentType?) — user-visible artifact.
- wf.log(message) — structured progress log.

Rules:
- The ONLY way to reach the outside world is the wf object. No fetch, no fs, no process, no timers, no Math.random in control flow.
- args are available as the global \`args\` (e.g. args.pr). Reference earlier results in plain variables — the script is imperative TypeScript.
- Wrap irreversible tool calls with wf.approve BEFORE the call.
- Use wf.publish for anything the user should see as a deliverable.
- Output ONLY the complete file content (frontmatter + script), no commentary, no markdown fences.`;

export class DwfWorkflowPlanner {
  constructor(private readonly llm: DwfPlannerLlm) {}

  /**
   * Goal → 校验过的 dwf 源码 + 风险标记。parse/compile 失败回喂重试一次；
   * 第二次失败带两轮错误清单抛出。
   */
  async plan(input: DwfPlannerInput): Promise<DwfPlannerResult> {
    const agentList = input.agents?.length ? `\nAvailable agent types (wf.agent): ${input.agents.join(', ')}` : '';
    const toolList = input.tools?.length ? `\nAvailable tools (wf.tool): ${input.tools.join(', ')}` : '';
    const userPrompt =
      `Goal: ${input.goal}\n${input.context ? `Context: ${input.context}\n` : ''}${agentList}${toolList}\n` +
      'Output ONLY the complete .dwf.ts file content, no commentary.';

    let lastErrors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? `${PLANNER_DWF_SYSTEM_PROMPT}\n\n${userPrompt}`
          : `${PLANNER_DWF_SYSTEM_PROMPT}\n\n${userPrompt}\n\nYour previous attempt was INVALID. Fix these problems and output the complete file again:\n${lastErrors.map((e) => `- ${e}`).join('\n')}`;

      const raw = await this.llm(prompt);
      const errors = await this.validateSource(raw);
      if (typeof errors === 'string') {
        // validateSource 的完整失败面：收集错误并重试。
        lastErrors.push(errors);
        continue;
      }
      const { meta, script, source } = errors;
      const { highRiskCalls, warnings } = scanDwfRisk(script);
      return { meta, script, source, highRiskCalls, warnings };
    }
    throw new Error(`dwf planner failed after retry:\n${lastErrors.join('\n')}`);
  }

  /**
   * 源码 → [meta, script, source] 或错误清单（frontmatter + 编译两道门）。
   * 返回 string = 失败（错误文本，可回喂）；对象 = 成功。
   */
  async validateSource(
    source: string,
  ): Promise<{ meta: SavedWorkflowMeta; script: string; source: string } | string> {
    const errors: string[] = [];
    const parsed = parseSavedWorkflow(source);
    if (!parsed.ok) {
      errors.push(`frontmatter ${parsed.reason}: ${parsed.detail}`);
    }
    const body = parsed.ok ? parsed.script : source.split('*/').slice(1).join('*/');
    try {
      await compileDwfScript(body);
    } catch (err) {
      if (err instanceof DwfCompileError) {
        errors.push(`compile: ${err.message}`);
      } else {
        errors.push(`compile: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errors.length > 0) return errors.join('; ');
    // parse 已 ok、compile 已通过——此分支必有 meta/script。
    const ok = parsed as { ok: true; meta: SavedWorkflowMeta; script: string };
    return { meta: ok.meta, script: ok.script, source };
  }
}
