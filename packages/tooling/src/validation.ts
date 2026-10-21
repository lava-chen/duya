/**
 * Assembly-time validation.
 *
 * This is the reason the package exists rather than being a folder of
 * interfaces. A registry that accepts anything and fails later at run time is
 * the shape plan 587's F08 rejected in HostMap, where the second live run
 * silently evicted the first at capacity 1. Every rule here therefore runs
 * once, at assembly, BEFORE a registry is handed to a runtime — never during a
 * turn.
 *
 * `validate` returns the full issue list rather than throwing on the first
 * one, so a host fixing an assembly sees every conflict in one pass.
 */

import type { ExtensionCapability, GrantedCapabilities } from './grants.js';
import { isExtensionCapability } from './grants.js';
import type {
  ApprovalPolicyContributor,
  ContextContributor,
  DecisionContributor,
  HookContributor,
  LifecycleContributor,
  MemoryPolicyContributor,
  ModeContributor,
  ProfileContributor,
  PromptSectionContributor,
  PromptSlot,
  ServerContributor,
  SkillContributor,
  TokenUsageContributor,
  ToolContributor,
} from './contributors.js';

/** One slot's worth of collected contributions. */
export interface ExtensionSnapshot {
  readonly modes: readonly ModeContributor[];
  readonly tools: readonly ToolContributor[];
  readonly promptSections: readonly PromptSectionContributor[];
  readonly hooks: readonly HookContributor[];
  readonly context: readonly ContextContributor[];
  readonly skills: readonly SkillContributor[];
  readonly approvalPolicies: readonly ApprovalPolicyContributor[];
  readonly profiles: readonly ProfileContributor[];
  readonly servers: readonly ServerContributor[];
  readonly memoryPolicies: readonly MemoryPolicyContributor[];
  readonly decisions: readonly DecisionContributor[];
  readonly lifecycles: readonly LifecycleContributor[];
  readonly tokenUsage: readonly TokenUsageContributor[];
}

export type ValidationRule =
  | 'duplicate-id'
  | 'capability-escalation'
  | 'unknown-capability'
  | 'lifecycle-cycle'
  | 'prompt-slot-conflict';

export interface ValidationIssue {
  readonly rule: ValidationRule;
  readonly slot: string;
  readonly key: string;
  readonly message: string;
}

/** Every contributor shape that declares a capability list. */
interface CapabilityBearing {
  readonly id: string;
  readonly capabilities: readonly ExtensionCapability[];
}

/**
 * The identity key of a contribution inside its slot, and the slot it lives in.
 *
 * Sourced from the real registries' keys: tool name, mode id, prompt module
 * name, hook id, skill id, permission mode, profile id, memory policy section,
 * decision id, lifecycle id, usage observer id. Server keys are namespaced by
 * kind so an MCP server and an app connection that happen to share a name do
 * not collide.
 */
function identityKeys(snapshot: ExtensionSnapshot): Array<{ slot: string; key: string; id: string }> {
  const keys: Array<{ slot: string; key: string; id: string }> = [];
  for (const c of snapshot.modes) keys.push({ slot: 'modes', key: c.modeId, id: c.id });
  for (const c of snapshot.tools) keys.push({ slot: 'tools', key: c.toolId, id: c.id });
  for (const c of snapshot.promptSections) keys.push({ slot: 'promptSections', key: c.sectionName, id: c.id });
  for (const c of snapshot.hooks) keys.push({ slot: 'hooks', key: c.id, id: c.id });
  for (const c of snapshot.context) keys.push({ slot: 'context', key: c.id, id: c.id });
  for (const c of snapshot.skills) keys.push({ slot: 'skills', key: c.skillId, id: c.id });
  for (const c of snapshot.approvalPolicies) keys.push({ slot: 'approvalPolicies', key: c.modeId, id: c.id });
  for (const c of snapshot.profiles) keys.push({ slot: 'profiles', key: c.profileId, id: c.id });
  for (const c of snapshot.servers) keys.push({ slot: 'servers', key: `${c.kind}:${c.serverId}`, id: c.id });
  for (const c of snapshot.memoryPolicies) keys.push({ slot: 'memoryPolicies', key: c.sectionId, id: c.id });
  for (const c of snapshot.decisions) keys.push({ slot: 'decisions', key: c.decisionId, id: c.id });
  for (const c of snapshot.lifecycles) keys.push({ slot: 'lifecycles', key: c.id, id: c.id });
  for (const c of snapshot.tokenUsage) keys.push({ slot: 'tokenUsage', key: c.id, id: c.id });
  return keys;
}

function allContributors(snapshot: ExtensionSnapshot): CapabilityBearing[] {
  return [
    ...snapshot.modes,
    ...snapshot.tools,
    ...snapshot.promptSections,
    ...snapshot.hooks,
    ...snapshot.context,
    ...snapshot.skills,
    ...snapshot.approvalPolicies,
    ...snapshot.profiles,
    ...snapshot.servers,
    ...snapshot.memoryPolicies,
    ...snapshot.decisions,
    ...snapshot.lifecycles,
    ...snapshot.tokenUsage,
  ];
}

/** Rule 1: two contributions claiming one identity inside one slot. */
function duplicateIdIssues(snapshot: ExtensionSnapshot): ValidationIssue[] {
  const seen = new Map<string, { slot: string; key: string; id: string }>();
  const issues: ValidationIssue[] = [];
  for (const entry of identityKeys(snapshot)) {
    const composite = `${entry.slot}::${entry.key}`;
    const first = seen.get(composite);
    if (first) {
      issues.push({
        rule: 'duplicate-id',
        slot: entry.slot,
        key: entry.key,
        message:
          `slot "${entry.slot}" has two contributions claiming "${entry.key}" `
          + `(contributors "${first.id}" and "${entry.id}").`,
      });
      continue;
    }
    seen.set(composite, entry);
  }
  return issues;
}

/** Rules 2 and 3: declared capabilities must be granted, and must be known. */
function capabilityIssues(
  contributors: readonly CapabilityBearing[],
  granted: GrantedCapabilities,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const contributor of contributors) {
    for (const capability of contributor.capabilities) {
      if (!isExtensionCapability(capability as string)) {
        issues.push({
          rule: 'unknown-capability',
          slot: capability as string,
          key: contributor.id,
          message:
            `contributor "${contributor.id}" declares unknown capability "${capability as string}".`,
        });
        continue;
      }
      if (!granted.has(capability)) {
        issues.push({
          rule: 'capability-escalation',
          slot: capability,
          key: contributor.id,
          message:
            `contributor "${contributor.id}" requires capability "${capability}", `
            + `which the host did not grant this assembly.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Rule 4: a lifecycle hook that (transitively) re-registers an event it is
 * itself dispatched on.
 *
 * Modelled as a graph: contributor A declares it hooks event E, and declares
 * it installs a hook on event F; a contributor that hooks F declares E. The
 * DFS below reports every cycle it finds. Self-cycles (A declares both E and
 * F = E) are the common case and are reported too.
 */
function lifecycleCycleIssues(lifecycles: readonly LifecycleContributor[]): ValidationIssue[] {
  // events the hook installs -> the events that contributor hooks.
  const edges = new Map<string, readonly string[]>();
  for (const contributor of lifecycles) {
    if (!contributor.registers || contributor.registers.length === 0) continue;
    edges.set(contributor.id, contributor.registers);
  }
  if (edges.size === 0) return [];

  // Index contributors by the events they hook, for edge expansion.
  const byEvent = new Map<string, string[]>();
  for (const contributor of lifecycles) {
    for (const event of contributor.events) {
      const bucket = byEvent.get(event);
      if (bucket) bucket.push(contributor.id);
      else byEvent.set(event, [contributor.id]);
    }
  }

  const issues: ValidationIssue[] = [];
  const reported = new Set<string>();

  /**
   * One DFS from `startId`.
   *
   * `onStack` is the grey set (a back edge into it is a cycle). `finished` is
   * the black set and is what makes the walk terminate: without it, popping a
   * node removes it from the path and its parent re-expands into it forever,
   * which turns both a 2-cycle and a plain DAG into an infinite loop.
   * `finished` is per-walk, so each node is pushed at most once per walk.
   */
  const walk = (startId: string): void => {
    const stack: string[] = [startId];
    const onStack = new Set<string>([startId]);
    const finished = new Set<string>();

    while (stack.length > 0) {
      const id = stack[stack.length - 1]!;
      const targets = edges.get(id);
      let advanced = false;

      if (targets) {
        for (const event of targets) {
          for (const nextId of byEvent.get(event) ?? []) {
            if (onStack.has(nextId)) {
              const cycle = [...stack, nextId];
              const signature = [...new Set(cycle)].sort().join('>');
              if (!reported.has(signature)) {
                reported.add(signature);
                issues.push({
                  rule: 'lifecycle-cycle',
                  slot: 'lifecycles',
                  key: cycle.join(' -> '),
                  message: `lifecycle hook cycle: ${cycle.join(' -> ')}.`,
                });
              }
              continue;
            }
            if (finished.has(nextId)) continue;
            stack.push(nextId);
            onStack.add(nextId);
            advanced = true;
            break;
          }
          if (advanced) break;
        }
      }

      if (!advanced) {
        stack.pop();
        onStack.delete(id);
        finished.add(id);
      }
    }
  };

  for (const id of edges.keys()) walk(id);
  return issues;
}

/** Rule 5: two prompt sections claiming the same authored slot. */
function promptSlotIssues(sections: readonly PromptSectionContributor[]): ValidationIssue[] {
  const owner = new Map<PromptSlot, string>();
  const issues: ValidationIssue[] = [];
  for (const section of sections) {
    for (const slot of section.slots) {
      const previous = owner.get(slot);
      if (previous !== undefined) {
        issues.push({
          rule: 'prompt-slot-conflict',
          slot: 'promptSections',
          key: slot,
          message:
            `prompt slot "${slot}" is claimed by both section "${previous}" and section `
            + `"${section.sectionName}".`,
        });
        continue;
      }
      owner.set(slot, section.sectionName);
    }
  }
  return issues;
}

/**
 * Validate one assembled snapshot against the host's grant set.
 *
 * Pure and total: it reads the snapshot and the grant set and returns issues.
 * It has no side effects and no knowledge of any feature package.
 */
export function validate(
  snapshot: ExtensionSnapshot,
  granted: GrantedCapabilities,
): ValidationIssue[] {
  return [
    ...duplicateIdIssues(snapshot),
    ...capabilityIssues(allContributors(snapshot), granted),
    ...lifecycleCycleIssues(snapshot.lifecycles),
    ...promptSlotIssues(snapshot.promptSections),
  ];
}

/** Thrown by `assembleExtensions` when validation rejects an assembly. */
export class ExtensionValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const detail = issues.map((issue) => `  - [${issue.rule}] ${issue.message}`).join('\n');
    super(`Extension assembly rejected by validate():\n${detail}`);
    this.name = 'ExtensionValidationError';
    this.issues = issues;
  }
}

export type { ExtensionCapability };
