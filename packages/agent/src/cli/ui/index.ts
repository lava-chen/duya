/** Transitional adapter for TUI callers that have not moved out of the agent package. */

export * from '@duya/cli/tui';
export { defaultCompletionSources } from './candidates.js';
export { SurfaceTape, renderToolRow, renderTurnRow, type SurfacePushResult } from './surface-view.js';
export {
  promptText,
  promptSecret,
  promptConfirm,
  promptSelect,
  promptCheckbox,
  promptRadio,
  promptChecklist,
  type PromptOptions,
  type SelectOptions,
  type CheckboxOptions,
} from './prompts.js';
