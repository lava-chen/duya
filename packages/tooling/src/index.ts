/**
 * `@duya/tooling` — the extension contract plus assembly.
 *
 * What this package is: 13 narrow contributor interfaces, an
 * `ExtensionRegistry` with 13 independent slots, and assembly-time
 * validation.
 *
 * What this package refuses to be: a universal registry. It carries no
 * feature implementations, no behaviour takeover mechanism, and no runtime
 * catalog state (`catalogRevision` / `replaceByOwner` stay in
 * `packages/agent/src/tool/registry.ts`). It imports no `capabilities`, no
 * `connectors`, and no `memory` — it defines interfaces and the host injects
 * implementations at assembly time.
 */

export type {
  ExtensionContributor,
  ModeContributor,
  ModeApplication,
  ModePatch,
  ToolContributor,
  ExtensionToolDefinition,
  PromptSectionContributor,
  PromptRenderInput,
  PromptSlot,
  HookContributor,
  HookDispatchInput,
  HookEffect,
  LoopHookEvent,
  ContextContributor,
  ContextLoadInput,
  ContextSection,
  SkillContributor,
  SkillActivation,
  ApprovalPolicyContributor,
  ApprovalRule,
  ApprovalDecision,
  ProfileContributor,
  ServerContributor,
  ServerContributorKind,
  MemoryPolicyContributor,
  MemoryPolicyRule,
  DecisionContributor,
  DecisionInput,
  DecisionOutcome,
  LifecycleContributor,
  LifecycleEvent,
  LifecycleInput,
  TokenUsageContributor,
  NormalizedUsageInput,
} from './contributors.js';

export { EXTENSION_SLOTS, isExtensionCapability, grantedCapabilities, allCapabilities } from './grants.js';
export type { ExtensionSlot, ExtensionCapability, GrantedCapabilities } from './grants.js';

export { ExtensionRegistry, ExtensionRegistryBuilder } from './registry.js';

export { validate, ExtensionValidationError } from './validation.js';
export type { ExtensionSnapshot, ValidationIssue, ValidationRule } from './validation.js';

export { assembleExtensions } from './assemble.js';
