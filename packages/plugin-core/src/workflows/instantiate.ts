// packages/plugin-core/src/workflows/instantiate.ts
// Plan 311 — Phase 2/3: pure workflow instantiation.
//
// Given a `WorkflowTemplate` and a map of variable values, produce the
// final prompt string with all `{{variable}}` placeholders replaced.
// Pure function — no I/O, no logging. Callers (renderer / IPC) own
// the variable-collection UI and the dispatch path.
//
// Syntax (Plan 311 Open Question 2 — v1 choice):
//   {{name}}        — required variable. Missing value => throws.
//   {{name?}}       — optional variable. Missing value => empty string.
//   {{name=def}}    — variable with default. Missing value => `def`.
//
// Escape rules:
//   `{{` not followed by a valid variable token is left as-is.
//   Literal `{{` inside a value is fine — we only substitute on the
//   template side, never on the value side, so no double-expansion.
//
// The automation NL template system uses `$project` syntax; the two
// are deliberately separate because plugin workflows are user-visible
// prompts (curly braces are conventional in prompt engineering) while
// automation NL templates are scheduler parameters. See
// `automation-nl-templates-design.md` §6.3.

import type { WorkflowTemplate, PermissionTier } from './schema';
import { bumpPermissionTier } from './schema';

export interface InstantiateOptions {
  /**
   * Variable values keyed by name. Keys not present in the template
   * are ignored; keys referenced by the template but missing from
   * this map follow the required/optional/default rules above.
   */
  variables?: Record<string, string>;
}

export interface InstantiateResult {
  /** Final prompt text, ready to drop into the chat input box. */
  prompt: string;
  /** Names of variables that were referenced but missing (only set when throwing). */
  missingVariables: string[];
}

export class WorkflowInstantiateError extends Error {
  readonly missingVariables: string[];
  constructor(message: string, missingVariables: string[]) {
    super(message);
    this.name = 'WorkflowInstantiateError';
    this.missingVariables = missingVariables;
  }
}

const VAR_PATTERN = /\{\{([^}]+)\}\}/g;

interface ParsedVar {
  /** Raw match text including braces, e.g. `{{name?}}`. */
  raw: string;
  /** Variable name without modifiers. */
  name: string;
  /** Whether the variable is optional (`?` suffix). */
  optional: boolean;
  /** Default value, or `undefined` when no `=default` is given. */
  defaultValue: string | undefined;
}

function parseVariableToken(inner: string): ParsedVar {
  // inner is the captured group between `{{` and `}}`.
  let name = inner.trim();
  let optional = false;
  let defaultValue: string | undefined;

  if (name.endsWith('?')) {
    optional = true;
    name = name.slice(0, -1).trim();
  }

  const eqIdx = name.indexOf('=');
  if (eqIdx !== -1) {
    defaultValue = name.slice(eqIdx + 1);
    name = name.slice(0, eqIdx).trim();
  }

  return { raw: `{{${inner}}}`, name, optional, defaultValue };
}

/**
 * Validate that a template declares a usable prompt path. v1 runtime
 * consumes `prompt` only; `steps` is reserved for future use.
 */
export function getTemplatePrompt(template: WorkflowTemplate): string {
  if (typeof template.prompt === 'string' && template.prompt.length > 0) {
    return template.prompt;
  }
  if (Array.isArray(template.steps) && template.steps.length > 0) {
    // Future: concatenate step prompts with separators. v1 simply
    // joins the first step's prompt so the runtime has something
    // to dispatch; a real steps engine is Plan 311 Open Question 1.
    return template.steps.map((s) => s.prompt).join('\n\n');
  }
  throw new WorkflowInstantiateError(
    `Workflow ${template.id} has neither prompt nor steps`,
    [],
  );
}

/**
 * Extract the set of variable names referenced by a template prompt.
 * Optional / defaulted variables are still included — callers can use
 * this to drive a variable-collection UI.
 */
export function extractVariables(template: WorkflowTemplate): string[] {
  const prompt = getTemplatePrompt(template);
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  VAR_PATTERN.lastIndex = 0;
  while ((match = VAR_PATTERN.exec(prompt)) !== null) {
    const parsed = parseVariableToken(match[1]);
    if (parsed.name) names.add(parsed.name);
  }
  return Array.from(names);
}

/**
 * Substitute variables into the template prompt. Throws
 * `WorkflowInstantiateError` when a required variable is missing.
 */
export function instantiateWorkflow(
  template: WorkflowTemplate,
  options: InstantiateOptions = {},
): InstantiateResult {
  const prompt = getTemplatePrompt(template);
  const values = options.variables ?? {};
  const missing: string[] = [];

  const result = prompt.replace(VAR_PATTERN, (full, inner: string) => {
    const parsed = parseVariableToken(inner);
    if (!parsed.name) return full;

    if (Object.prototype.hasOwnProperty.call(values, parsed.name)) {
      return values[parsed.name];
    }

    if (parsed.defaultValue !== undefined) {
      return parsed.defaultValue;
    }

    if (parsed.optional) {
      return '';
    }

    missing.push(parsed.name);
    return full;
  });

  if (missing.length > 0) {
    throw new WorkflowInstantiateError(
      `Missing required workflow variables: ${missing.join(', ')}`,
      missing,
    );
  }

  return { prompt: result, missingVariables: [] };
}

/**
 * Effective permission tier for a template, applying the conservative
 * one-step bump when the tier is undeclared. Callers that also have a
 * plugin-level `permissionPolicy.defaultMode` should additionally call
 * `mergeTiers(templateTier, defaultMode)` to take the stricter.
 */
export function effectiveTier(template: WorkflowTemplate): PermissionTier {
  // The schema defaults `permissionTier` to `'read'`, so we cannot
  // distinguish "declared read" from "undeclared" via the parsed
  // object alone. The bump is applied unconditionally; this matches
  // the design doc: declared `read` stays `read` only when the
  // template explicitly opts in. To preserve the "undeclared =>
  // bump" semantics, callers should pass the raw tier through
  // `bumpPermissionTier` before merging.
  return bumpPermissionTier(template.permissionTier);
}
