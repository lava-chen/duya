// packages/plugin-core/src/workflows/index.ts
// Barrel for the workflows/ subfolder. Plan 311.

export {
  PermissionTierSchema,
  PERMISSION_TIER_ORDER,
  tierRank,
  compareTiers,
  mergeTiers,
  bumpPermissionTier,
  tierRequiresConfirmation,
  tierRequiresExplicitConfirmation,
  WorkflowStepSchema,
  WorkflowTemplateSchema,
  toWorkflowSummary,
} from './schema';

export type {
  PermissionTier,
  WorkflowStep,
  WorkflowTemplate,
  WorkflowTemplateSummary,
} from './schema';

export {
  instantiateWorkflow,
  extractVariables,
  getTemplatePrompt,
  effectiveTier,
  WorkflowInstantiateError,
} from './instantiate';

export type {
  InstantiateOptions,
  InstantiateResult,
} from './instantiate';
