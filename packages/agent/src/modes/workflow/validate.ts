/**
 * validate.ts — static semantic validation for workflow definitions
 * (plan 552 Phase 1; extends the zod shape checks in schema.ts).
 *
 * Layers:
 *   - schema.ts (zod): shapes, lengths, enums, `human.timeout.on_timeout`
 *     REQUIRED (anti-suspension-leak), gui step discriminated union.
 *   - validate.ts (here): cross-node semantics —
 *       · unique phase / node ids
 *       · every reference (when / map.over / templates / decision state)
 *         resolves to a known node id, `params.*`, or the node's own
 *         map loop variable
 *       · no dependency cycles; dependencies may not cross into LATER
 *         phases (same-phase forward refs are fine — the engine orders
 *         them topologically)
 *       · decision node coherence: threshold keys ⊆ question ids,
 *         choice questions carry ≥2 options, on_low_confidence defaults
 *         match the question kind
 *
 * Expressions are parsed with expr.ts — a parse failure is a validation
 * error, never a runtime surprise (ZCode principle 2: 代码裁决).
 */

import {
  WorkflowDefSchema,
  type WorkflowDef,
  type WorkflowNode,
} from './schema.js';
import { parseExpr, templateRefRoots, exprRefRoots } from './expr.js';

export interface ValidationError {
  /** Dotted location, e.g. `phases[0].nodes[2].when`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

interface NodeIndex {
  node: WorkflowNode;
  phaseIdx: number;
  nodeIdx: number;
}

function flattenedNodes(def: WorkflowDef): NodeIndex[] {
  const out: NodeIndex[] = [];
  def.phases.forEach((phase, phaseIdx) => {
    phase.nodes.forEach((node, nodeIdx) => {
      out.push({ node, phaseIdx, nodeIdx });
    });
  });
  return out;
}

/** Roots a node's references may legally point at (ids + params + own loop var). */
function loopVarsOf(node: WorkflowNode): Set<string> {
  return new Set<string>(node.map ? [node.map.as] : []);
}

/**
 * Dependencies of a node: node ids it references. Returns them together
 * with per-reference errors (unparseable expressions / templates).
 * Exported for the engine's topological ordering (same extractor —
 * validation and execution can never disagree about edges).
 */
export function nodeDependencies(node: WorkflowNode): { deps: Set<string>; errors: ValidationError[] } {
  const deps = new Set<string>();
  const errors: ValidationError[] = [];

  const checkExpr = (src: string | undefined, path: string): void => {
    if (typeof src !== 'string' || src === '') return;
    try {
      for (const root of exprRefRoots(src)) deps.add(root);
    } catch (err) {
      errors.push({ path, message: `invalid expression: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const checkTemplate = (t: string | undefined, path: string): void => {
    if (typeof t !== 'string' || t === '') return;
    try {
      for (const root of templateRefRoots(t)) deps.add(root);
    } catch (err) {
      errors.push({ path, message: `invalid template: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const checkObject = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      checkTemplate(value, path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => checkObject(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) checkObject(v, `${path}.${k}`);
    }
  };

  checkExpr(node.when, `${node.id}.when`);
  if (node.map) {
    checkExpr(node.map.over, `${node.id}.map.over`);
    checkTemplate(node.map.prompt, `${node.id}.map.prompt`);
    checkObject(node.map.input, `${node.id}.map.input`);
  }
  checkTemplate(node.agent !== undefined ? node.prompt : undefined, `${node.id}.prompt`);
  checkObject(node.input, `${node.id}.input`);
  if (node.gui) {
    node.gui.steps.forEach((step, i) => {
      if ('text' in step) checkTemplate(step.text, `${node.id}.gui.steps[${i}].text`);
    });
  }
  if (node.human) checkTemplate(node.human.prompt, `${node.id}.human.prompt`);
  if (node.decision) {
    if ('output' in node.decision.state && typeof node.decision.state.output === 'string') {
      checkTemplate(node.decision.state.output, `${node.id}.decision.state.output`);
    } else {
      checkObject(node.decision.state, `${node.id}.decision.state`);
    }
    for (const [qid, q] of Object.entries(node.decision.questions)) {
      checkTemplate(q.instructions ?? '', `${node.id}.decision.questions.${qid}.instructions`);
      if (q.type === 'choice') {
        for (const [opt, desc] of Object.entries(q.criteria)) {
          checkTemplate(desc, `${node.id}.decision.questions.${qid}.criteria.${opt}`);
        }
      }
    }
  }
  return { deps, errors };
}

/** Validate decision-node semantics beyond shape (plan 552 §4.2 ③). */
function validateDecisionNode(node: WorkflowNode, errors: ValidationError[]): void {
  const decision = node.decision;
  if (!decision) return;
  const questionIds = Object.keys(decision.questions);
  if (questionIds.length === 0) {
    errors.push({ path: `${node.id}.decision.questions`, message: 'decision node carries no questions' });
    return;
  }
  // Question id sanity: they ride the journal + when scope as refs.
  for (const qid of questionIds) {
    if (!/^[a-z][a-z0-9_]*$/.test(qid)) {
      errors.push({ path: `${node.id}.decision.questions.${qid}`, message: 'question id must be snake_case' });
    }
    const q = decision.questions[qid];
    if (q.type === 'choice' && Object.keys(q.criteria).length < 2) {
      errors.push({ path: `${node.id}.decision.questions.${qid}`, message: 'choice question needs at least 2 options' });
    }
  }
  for (const key of Object.keys(decision.thresholds ?? {})) {
    if (!decision.questions[key]) {
      errors.push({ path: `${node.id}.decision.thresholds.${key}`, message: 'threshold references an unknown question' });
    }
  }
  const olc = decision.on_low_confidence;
  if (olc && typeof olc === 'object' && 'default' in olc) {
    const first = decision.questions[questionIds[0]];
    if (typeof olc.default === 'string' && first.type === 'choice') {
      if (!(olc.default in first.criteria)) {
        errors.push({
          path: `${node.id}.decision.on_low_confidence.default`,
          message: `default "${olc.default}" is not one of the choice options`,
        });
      }
    }
  }
}

/**
 * Full static validation. Returns every problem found (schema shape is
 * checked first; cross-node semantics only when the shape parses).
 */
export function validateWorkflow(raw: unknown): ValidationResult & { def?: WorkflowDef } {
  const shape = WorkflowDefSchema.safeParse(raw);
  if (!shape.success) {
    return {
      ok: false,
      errors: shape.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const def = shape.data;
  const errors: ValidationError[] = [];

  // Unique ids.
  const phaseIds = new Set<string>();
  def.phases.forEach((phase, i) => {
    if (phaseIds.has(phase.phase)) {
      errors.push({ path: `phases[${i}].phase`, message: `duplicate phase id "${phase.phase}"` });
    }
    phaseIds.add(phase.phase);
  });

  const flat = flattenedNodes(def);
  const nodeIds = new Set<string>();
  for (const { node, phaseIdx, nodeIdx } of flat) {
    if (nodeIds.has(node.id)) {
      errors.push({ path: `phases[${phaseIdx}].nodes[${nodeIdx}]`, message: `duplicate node id "${node.id}"` });
    }
    nodeIds.add(node.id);
  }

  // Per-node checks (only for the FIRST occurrence of an id — duplicates
  // already reported).
  const seen = new Set<string>();
  const depsByNode = new Map<string, Set<string>>();
  for (const { node, phaseIdx } of flat) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);

    // on_error=retry needs max_retries to be meaningful (default 1 in engine).
    if (node.on_error === 'retry' && node.max_retries !== undefined && node.max_retries < 1) {
      errors.push({ path: `${node.id}.max_retries`, message: 'on_error=retry requires max_retries >= 1' });
    }

    const { deps, errors: depErrors } = nodeDependencies(node);
    depErrors.forEach((e) => errors.push(e));
    depsByNode.set(node.id, deps);

    // Reference legality: every root is a known node, `params`, or the
    // node's own map loop variable.
    const loopVars = loopVarsOf(node);
    for (const root of deps) {
      if (root === 'params' || loopVars.has(root) || nodeIds.has(root)) continue;
      errors.push({ path: node.id, message: `reference "${root}" is neither a node id, "params", nor the map variable` });
    }

    validateDecisionNode(node, errors);

    // Cross-phase forward references are unexecutable (phases are strictly
    // sequential): a node may not depend on a node in a LATER phase.
    for (const dep of deps) {
      const depIdx = flat.find((f) => f.node.id === dep);
      if (depIdx && depIdx.phaseIdx > phaseIdx) {
        errors.push({
          path: node.id,
          message: `depends on "${dep}" which lives in a later phase (phases are sequential)`,
        });
      }
    }
  }

  // Cycle detection over the dependency graph (DFS, three-color).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycleNodes: string[] = [];
  const visit = (id: string, stack: string[]): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of depsByNode.get(id) ?? []) {
      if (!nodeIds.has(dep) || dep === 'params') continue;
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        cycleNodes.push([...stack, dep].join(' -> '));
      } else if (c === WHITE) {
        visit(dep, stack);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const { node } of flat) {
    if ((color.get(node.id) ?? WHITE) === WHITE) visit(node.id, []);
  }
  if (cycleNodes.length > 0) {
    errors.push({ path: 'phases', message: `dependency cycle: ${cycleNodes[0]}` });
  }

  return { ok: errors.length === 0, errors, def };
}

/** Parse YAML text into a def, then validate. Convenience for trigger sites. */
export function validateWorkflowData(raw: unknown): ValidationResult & { def?: WorkflowDef } {
  return validateWorkflow(raw);
}

export { WorkflowDefSchema };
export type { WorkflowDef, WorkflowNode };
