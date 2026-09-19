/**
 * planner.ts — LLM generates the workflow YAML (plan 415 §7 + 552 §5
 * 落点⑤), then CODE decides whether the plan is high-risk.
 *
 * "模型生成,代码裁决" (plan 552 §2 principle 2): the LLM only drafts
 * the YAML — validation, reference checks and risk classification are
 * deterministic. Risk prescreen is two-tier:
 *   1. rule pass — write/irreversible-shaped tool names flag instantly,
 *   2. Jev pass (551 DecisionService) — a risk noul per ambiguous tool
 *      node; p ≥ policy.irreversibleAt flags the node. Suggestion only
 *      (419 red line): it routes the run to `awaiting_confirm`, it
 *      never executes anything itself.
 *
 * Parse/validate failures go back to the LLM ONCE with the error list
 * (415 §7); a second failure aborts planning — never a half-baked plan.
 */

import { parse as parseYaml } from 'yaml';
import type { WorkflowDef } from './schema.js';
import { validateWorkflow } from './validate.js';
import type { DecisionService } from '../../decisions/index.js';

/** The LLM port (production: AIClient one-shot; fixtures: canned). */
export type PlannerLlm = (prompt: string) => Promise<string>;

export interface PlannerInput {
  goal: string;
  /** Extra context (workingDirectory, available agents, AGENTS.md digest). */
  context?: string;
  /** Known agent types the plan may reference. */
  agents?: readonly string[];
}

export interface PlannerResult {
  def: WorkflowDef;
  /** Node ids the prescreen flagged — run starts at awaiting_confirm. */
  highRiskNodes: string[];
  warnings: string[];
}

const RULE_RISK_RE =
  /\b(pay|payment|send|post|publish|delete|drop|truncate|write|push|deploy|purchase|transfer|email|message)\b/i;

export const PLANNER_SYSTEM_PROMPT = `You translate an automation goal into a duya workflow definition (strict YAML).

Schema requirements:
- top level: name (kebab-case <=64), description (<=1024), when_to_use (optional <=2048), params (optional list of {name, type: string|number|boolean|json, required?, default?}), phases (1..8 of {phase, title, nodes}).
- node kinds — EXACTLY ONE per node: tool: <name> (+ input), gui: {target_app, steps:[{do: capture|click|type_text|set_value|key|scroll, ...}]}, decision: {state:{output: "\${ref}"}, questions:{<id>:{type: choice|noul|score, ...}}, thresholds?, on_low_confidence?}, human: {prompt, timeout:{hours, on_timeout: escalate|skip|fail}}, agent: <type> (+ prompt), noop: true.
- map primitive wraps one agent or tool: {over: <expr array>, as: <var>, prompt?/input?} — reference the item as \${var} or \${var.field}.
- when: <expr> gates a node. Expressions may ONLY use: refs like node.output / node.succeeded / params.x / nodeId.<decisionQuestion>, comparisons == != > < >= <=, logic && || !, aggregates any() all() count(). No functions, no clock, no randomness.
- Deterministic RPA (fixed clicks/typing on a desktop app) = gui nodes. Zero-LLM tool calls = tool nodes. Classification/routing = decision nodes. Anything irreversible (payments, sending, deletion) = a human node. Open-ended tasks = agent nodes.
- Templates "\${...}" interpolate params and earlier node outputs. Later nodes may reference earlier ones (same phase or earlier phases).`;

export class WorkflowPlanner {
  constructor(
    private readonly llm: PlannerLlm,
    private readonly decisionService?: DecisionService,
  ) {}

  /**
   * Goal → validated WorkflowDef + risk flags. One retry on invalid
   * YAML; a second failure rethrows with both error sets.
   */
  async plan(input: PlannerInput): Promise<PlannerResult> {
    const agentList = input.agents?.length ? `\nAvailable agent types: ${input.agents.join(', ')}` : '';
    const userPrompt =
      `Goal: ${input.goal}\n${input.context ? `Context: ${input.context}\n` : ''}${agentList}\n` +
      'Output ONLY the YAML definition, no commentary.';

    let lastErrors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? `${PLANNER_SYSTEM_PROMPT}\n\n${userPrompt}`
          : `${PLANNER_SYSTEM_PROMPT}\n\n${userPrompt}\n\nYour previous attempt was INVALID. Fix these problems and output the full YAML again:\n${lastErrors.map((e) => `- ${e}`).join('\n')}`;

      const raw = await this.llm(prompt);
      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch (err) {
        lastErrors = [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`];
        continue;
      }
      const validation = validateWorkflow(parsed);
      if (validation.ok && validation.def) {
        const { highRiskNodes, warnings } = await this.prescreenRisk(validation.def);
        return { def: validation.def, highRiskNodes, warnings };
      }
      lastErrors = validation.errors.map((e) => `${e.path || '(root)'}: ${e.message}`);
    }
    throw new Error(`planner failed after retry:\n${lastErrors.join('\n')}`);
  }

  /**
   * Two-tier risk prescreen (§5 落点⑤). Rule pass is free; the Jev pass
   * batches nothing per-node (one ask per ambiguous node — node counts
   * are small; fan-out batching rides a later optimization).
   */
  async prescreenRisk(def: WorkflowDef): Promise<{ highRiskNodes: string[]; warnings: string[] }> {
    const highRiskNodes: string[] = [];
    const warnings: string[] = [];

    for (const phase of def.phases) {
      for (const node of phase.nodes) {
        // Human nodes ARE the control — not flagged.
        if (node.human) continue;
        const action = describeNodeAction(node);
        if (!action) continue;
        if (node.tool && RULE_RISK_RE.test(node.tool)) {
          highRiskNodes.push(node.id);
          continue;
        }
        if (node.gui) {
          // Declared desktop steps on someone else's UI: conservative
          // default without a decision backend is to stop for confirm.
          highRiskNodes.push(node.id);
          continue;
        }
        if (!this.decisionService) continue;
        if (!this.decisionService.available) continue;
        try {
          const res = await this.decisionService.ask(
            { node: node.id, action },
            { risk: this.decisionService.irreversibleQuestion(action) },
          );
          const { p, verdict } = this.decisionService.resolveNoul(res, 'risk');
          if (verdict === 'yes') {
            highRiskNodes.push(node.id);
          } else if (verdict === 'uncertain') {
            warnings.push(`node "${node.id}" risk unresolved (p=${p.toFixed(2)}) — proceeding unconfirmed`);
          }
        } catch {
          warnings.push(`node "${node.id}" risk prescreen skipped (decision backend unavailable)`);
        }
      }
    }
    return { highRiskNodes, warnings };
  }
}

function describeNodeAction(node: import('./schema.js').WorkflowNode): string | undefined {
  if (node.tool) return `run tool "${node.tool}"${node.input ? ` with ${JSON.stringify(node.input)}` : ''}`;
  if (node.gui) return `drive the desktop app "${node.gui.target_app}" through ${node.gui.steps.length} steps`;
  if (node.agent) return `spawn agent "${node.agent}"`;
  return undefined;
}
