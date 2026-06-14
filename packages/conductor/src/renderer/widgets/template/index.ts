export type { TemplateManifest, TemplateToolMapping, TemplateDirectoryStructure } from "./manifest.js";
export { validateManifest, createEmptyManifest } from "./manifest.js";

export type { LoadedTemplate, TemplateLoadError, TemplateLoadResult } from "./loader.js";
export { templateToDefinition, createTemplateLoader } from "./loader.js";

export type { TemplateRegistryEntry, TemplateActionLogEntry } from "./registry.js";
export {
  installTemplate,
  uninstallTemplate,
  getTemplateActionLog,
  listInstalledTemplates,
  getTemplateEntry,
  isTemplateInstalled,
  clearTemplateRegistry,
} from "./registry.js";

export type { SchemaValidationResult, SchemaValidationError } from "./schema.js";
export { validateDataAgainstSchema, validateTemplateData } from "./schema.js";
