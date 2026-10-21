// run-display/dwf-preview.ts — static flow preview for never-run .dwf.ts definitions.
//
// Plan 565 Phase B upgraded the regex scan to a real AST read: the caller
// injects the `typescript` module (renderer lazy-imports it so the ~6 MB
// compiler never lands in the main chunk; tests pass it directly), and this
// module walks CallExpressions instead of guessing at source text. That kills
// the regex false positives (strings that contain "wf.tool(", nested quotes)
// and lets us read object-literal options such as on_stuck/optional that the
// text scan could never see.
//
// This is still a *static* read — template-literal labels, conditionals and
// wf.map fan-out shape are not interpreted; a real run's journal remains the
// only precise record. Syntax errors and unknown wf.* primitives surface as
// diagnostics so a broken script previews as "broken", not as "empty".

import type * as Ts from 'typescript';
import type { RunStepNodeKind } from '@/types/stream';
import type { StageStep } from './stage-columns';

export interface DwfPreviewStep extends StageStep {
  status: 'pending';
}

export interface DwfPreviewDiagnostic {
  /** 1-based source line. */
  line: number;
  message: string;
}

export interface DwfPreviewResult {
  steps: DwfPreviewStep[];
  diagnostics: DwfPreviewDiagnostic[];
}

/**
 * wf.phase('name')          → divider (cuts the rail into stage columns)
 * wf.agent('agent:研究员')  → agent chip
 * wf.tool('Bash', ...)      → script chip (aggregated per column)
 * wf.gui({ ... })           → script chip
 * wf.approve('...')         → human chip (prompt truncated)
 * wf.decide([...])          → decision chip
 * wf.publish('name')        → script chip (the deliverable itself is unknown
 *                             until the run produces it)
 *
 * wf.log / wf.map are skipped as steps — map's inner calls are visited in
 * place by the tree walk. Anything else on `wf.*` is a diagnostic: the runtime
 * API surface is closed, so an unknown verb means the script will throw mid-run.
 */
const KNOWN_VERBS: ReadonlySet<string> = new Set([
  'phase',
  'agent',
  'tool',
  'publish',
  'approve',
  'gui',
  'browser',
  'decide',
  'map',
  'log',
]);

const NODE_KIND_BY_VERB: Readonly<Record<string, RunStepNodeKind>> = {
  phase: 'phase',
  agent: 'agent',
  tool: 'tool',
  publish: 'tool',
  approve: 'human',
  gui: 'gui',
  browser: 'browser',
  decide: 'decision',
};

/** Human chips carry prompts — cap them so a long prompt does not bloat the rail. */
const HUMAN_LABEL_MAX = 24;

type TsModule = typeof Ts;

/** StringLiteral, or a template literal with NO ${} holes, or `undefined`. */
function staticStringArg(ts: TsModule, arg: Ts.Expression | undefined): string | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return undefined;
}

/**
 * Reads the options object for `on_stuck: 'skip'` / `optional: true` — the two
 * statically-visible "this node may no-op" markers. Returns the label suffix
 * the preview chips use so a skippable node is distinguishable before a run.
 */
function skippableSuffix(ts: TsModule, args: readonly Ts.Expression[]): string | undefined {
  for (const arg of args) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const init = prop.initializer;
      if (
        (prop.name.text === 'optional' && init.kind === ts.SyntaxKind.TrueKeyword) ||
        (prop.name.text === 'on_stuck' && ts.isStringLiteral(init) && init.text === 'skip')
      ) {
        return 'skip';
      }
    }
  }
  return undefined;
}

export function parseDwfPreviewSteps(script: string, ts: TsModule): DwfPreviewResult {
  if (!script) return { steps: [], diagnostics: [] };

  const sourceFile = ts.createSourceFile('workflow.dwf.ts', script, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);

  // Parse diagnostics are on an internal-but-stable field; a syntax error must
  // reach the preview card instead of silently rendering a partial rail.
  const diagnostics: DwfPreviewDiagnostic[] = [];
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly Ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const diag of parseDiagnostics) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0);
    diagnostics.push({ line: line + 1, message: ts.flattenDiagnosticMessageText(diag.messageText, ' ') });
  }

  const steps: DwfPreviewStep[] = [];
  let index = 0;

  const visit = (node: Ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
      const verb = node.expression.name.text;
      if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'wf') {
        if (!KNOWN_VERBS.has(verb)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          diagnostics.push({ line: line + 1, message: `unknown wf primitive: wf.${verb}()` });
        } else if (verb !== 'log' && verb !== 'map') {
          index += 1;
          const id = `preview-${String(index).padStart(3, '0')}-${verb}`;
          let label = staticStringArg(ts, node.arguments[0]);
          const suffix = skippableSuffix(ts, node.arguments);
          if (verb === 'approve' && label && label.length > HUMAN_LABEL_MAX) {
            label = `${label.slice(0, HUMAN_LABEL_MAX)}…`;
          }
          if (suffix !== undefined) {
            label = label !== undefined ? `${label} ·${suffix}` : `·${suffix}`;
          }
          steps.push({
            id,
            ...(label !== undefined ? { label } : {}),
            status: 'pending',
            nodeKind: NODE_KIND_BY_VERB[verb],
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);

  return { steps, diagnostics };
}
