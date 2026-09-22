/**
 * dwf/index.ts — barrel for the dwf/ subfolder (saved `.dwf.ts` workflows).
 */

export {
  SAVED_WORKFLOW_FILE_EXTENSION,
  SAVED_WORKFLOW_PROJECT_DIR,
  SAVED_WORKFLOW_GLOBAL_DIR,
  SAVED_WORKFLOW_DRAFTS_DIR,
  SAVED_WORKFLOW_NAME_PATTERN,
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SAVED_WORKFLOW_SCOPES,
  SAVED_WORKFLOW_SHADOWING,
  SAVED_WORKFLOW_ARG_TYPES,
  SavedWorkflowScopeSchema,
  SavedWorkflowShadowingSchema,
  SavedWorkflowArgTypeSchema,
  SavedWorkflowArgDeclarationSchema,
  SavedWorkflowArgsDeclarationSchema,
  SavedWorkflowMetaSchema,
  SavedWorkflowEntrySchema,
  isValidSavedWorkflowName,
  savedWorkflowFileName,
} from './contracts.js';

export type {
  SavedWorkflowScope,
  SavedWorkflowShadowing,
  SavedWorkflowArgType,
  SavedWorkflowArgDeclaration,
  SavedWorkflowArgsDeclaration,
  SavedWorkflowMeta,
  SavedWorkflowEntry,
  SavedWorkflowInvalidEntry,
} from './contracts.js';

export {
  SAVED_WORKFLOW_SENTINEL,
  serializeSavedWorkflow,
  parseSavedWorkflow,
} from './frontmatter.js';

export type { SavedWorkflowParseErrorReason, SavedWorkflowParseResult } from './frontmatter.js';

export {
  SavedWorkflowStore,
  savedWorkflowRoots,
  savedWorkflowRoot,
  savedWorkflowDraftsDir,
  savedWorkflowShadowing,
} from './store.js';

export type {
  SavedWorkflowRoot,
  SavedWorkflowRootsOptions,
  ResolvedSavedWorkflow,
  SavedWorkflowResolveFailure,
  SavedWorkflowResolveResult,
  SavedWorkflowListResult,
} from './store.js';

export {
  compileDwfScript,
  createDwfApi,
  runDwfScript,
  DwfApprovalDeniedError,
  DwfBudgetError,
  DwfCompileError,
} from './runtime.js';

export type { DwfApi, DwfHostPorts, DwfDecisionPort, DwfDecisionOutcome, DwfRunOptions } from './runtime.js';

export {
  DwfWorkflowPlanner,
  PLANNER_DWF_SYSTEM_PROMPT,
  extractToolCalls,
  scanDwfRisk,
} from './planner-dwf.js';

export type { DwfPlannerLlm, DwfPlannerInput, DwfPlannerResult } from './planner-dwf.js';

export { defToDwfSource } from './def-to-dwf.js';

export type { DefToDwfResult } from './def-to-dwf.js';
