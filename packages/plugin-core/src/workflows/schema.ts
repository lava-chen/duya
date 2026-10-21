// packages/plugin-core/src/workflows/schema.ts
// Plan 311 — Phase 0/3: Workflow template schema, permission tier mapping.
//
// A workflow template is a reusable task prompt shipped by a plugin. The
// manifest `components.workflows` field lists template IDs; the actual
// template lives at `workflows/<id>.yaml` inside the plugin directory.
// Capability index exposes only the summary (id/name/description/tier);
// the full prompt is fetched on demand via `plugin:workflow:get`.
//
// Permission tiers follow the design doc §6 five-tier model:
//   read / draft / write / modify / dangerous
// `read` and `draft` run automatically; `write` and `modify` require
// confirmation; `dangerous` requires explicit confirmation. When a
// template does not declare a tier, the runtime applies a conservative
// one-step bump (see `bumpPermissionTier`).

import { z } from 'zod';

// ----------------------------------------------------------------------------
// Permission tiers
// ----------------------------------------------------------------------------

export const PermissionTierSchema = z.enum([
  'read',
  'draft',
  'write',
  'modify',
  'dangerous',
]);

export type PermissionTier = z.infer<typeof PermissionTierSchema>;

/**
 * Ordered list of permission tiers from least to most dangerous.
 * Used by `compareTiers`, `bumpPermissionTier`, and `mergeTiers`.
 */
export const PERMISSION_TIER_ORDER: readonly PermissionTier[] = [
  'read',
  'draft',
  'write',
  'modify',
  'dangerous',
];

/**
 * Numeric rank for a tier (higher = more dangerous). Falls back to 0
 * for unknown values so callers can compare defensively.
 */
export function tierRank(tier: PermissionTier | string | undefined): number {
  if (!tier) return 0;
  const idx = PERMISSION_TIER_ORDER.indexOf(tier as PermissionTier);
  return idx === -1 ? 0 : idx;
}

/**
 * Compare two tiers. Returns a negative number if `a` is less dangerous,
 * zero if equal, positive if `a` is more dangerous.
 */
export function compareTiers(
  a: PermissionTier | string | undefined,
  b: PermissionTier | string | undefined,
): number {
  return tierRank(a) - tierRank(b);
}

/**
 * Return the stricter of two tiers (the one with the higher rank).
 * Used when a template tier and the plugin's `permissionPolicy.defaultMode`
 * conflict — the design doc §6 says "take the stricter". When both
 * ranks are equal (e.g. both are `read` or both are undefined), the
 * defined value wins; when both are undefined, defaults to `read`.
 */
export function mergeTiers(
  a: PermissionTier | string | undefined,
  b: PermissionTier | string | undefined,
): PermissionTier {
  const ra = tierRank(a);
  const rb = tierRank(b);
  if (ra > rb) return a as PermissionTier;
  if (rb > ra) return b as PermissionTier;
  // Equal ranks: prefer the defined value, default to 'read'.
  return (a ?? b ?? 'read') as PermissionTier;
}

/**
 * Conservative default: when a template does not declare a tier, bump
 * one step up from `read` (i.e. to `draft`). If already at the top,
 * stay there. This matches design doc §6 "未声明的动作按保守默认上提
 * 一档处理".
 */
export function bumpPermissionTier(
  tier: PermissionTier | string | undefined,
): PermissionTier {
  const rank = tierRank(tier);
  const next = Math.min(rank + 1, PERMISSION_TIER_ORDER.length - 1);
  return PERMISSION_TIER_ORDER[next];
}

/**
 * Whether the tier requires user confirmation before the workflow
 * prompt is dispatched. `read`/`draft` run automatically; `write`
 * and above require confirmation. The runtime confirmation UI is
 * reused from the existing tool-call confirmation path.
 */
export function tierRequiresConfirmation(
  tier: PermissionTier | string | undefined,
): boolean {
  return tierRank(tier) >= tierRank('write');
}

/**
 * Whether the tier requires an explicit checkbox / opt-in before
 * dispatch (only the `dangerous` tier).
 */
export function tierRequiresExplicitConfirmation(
  tier: PermissionTier | string | undefined,
): boolean {
  return tierRank(tier) >= tierRank('dangerous');
}

// ----------------------------------------------------------------------------
// Workflow template schema
// ----------------------------------------------------------------------------

/**
 * A single workflow step. v1 of the runtime only consumes `prompt`;
 * `steps` is reserved so the schema can evolve without another
 * manifest version bump. See Plan 311 Open Question 1.
 */
export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /**
   * The prompt body. Supports `{{variable}}` placeholders consumed by
   * `instantiateWorkflow` (see `./instantiate.ts`). Either `prompt`
   * or `steps` must be present; v1 runtime consumes `prompt` only.
   */
  prompt: z.string().optional(),
  steps: z.array(WorkflowStepSchema).optional(),
  /**
   * Capability IDs the template expects to be available, e.g.
   * `mcp:literature` or `skill:paper-analysis`. The runtime checks
   * these against the enabled-plugin capability index before
   * launching; missing capabilities produce an explicit warning.
   */
  requiredCapabilities: z.array(z.string()).default([]),
  /**
   * Permission tier — see `PermissionTierSchema` above. Optional;
   * when omitted the runtime applies `bumpPermissionTier(undefined)`
   * to be conservative.
   */
  permissionTier: PermissionTierSchema.default('read'),
});

export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

/**
 * Summary shape exposed by the capability index. Deliberately omits
 * `prompt` / `steps` to keep the index payload small (Plan 241
 * progressive disclosure). The full template is fetched on demand
 * via `plugin:workflow:get`.
 */
export interface WorkflowTemplateSummary {
  id: string;
  name: string;
  description: string;
  permissionTier: PermissionTier;
}

/**
 * Project a full template into a summary. The summary is the only
 * shape the capability index sends to the renderer; the prompt body
 * is fetched on demand.
 */
export function toWorkflowSummary(
  template: WorkflowTemplate,
): WorkflowTemplateSummary {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    permissionTier: template.permissionTier,
  };
}
