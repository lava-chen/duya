/**
 * Handlebars prompt renderer — public surface (Plan 550).
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

export { HbsPromptRenderer } from './HandlebarsRenderer.js';
export type { HbsPromptRendererOptions } from './HandlebarsRenderer.js';
export { loadHbsAsset, loadHbsAssetSync, parseFrontmatter } from './assetLoader.js';
export type {
  HbsAsset,
  HbsFrontmatter,
  HbsCompiledTemplate,
  HbsHelper,
  HandlebarsTemplateDelegate,
} from './types.js';
export { HbsPromptSystem, mapPromptContextToHbs } from './HbsPromptSystem.js';
export type { HbsPromptSystemOptions } from './HbsPromptSystem.js';