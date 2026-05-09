export type { TemplateManifest, TemplateToolMapping, TemplateDirectoryStructure } from "./manifest";
export { validateManifest, createEmptyManifest } from "./manifest";

export type { LoadedTemplate, TemplateLoadError, TemplateLoadResult } from "./loader";
export { templateToDefinition, createTemplateLoader } from "./loader";

export type { TemplateRegistryEntry, TemplateActionLogEntry } from "./registry";
export {
  installTemplate,
  uninstallTemplate,
  getTemplateActionLog,
  listInstalledTemplates,
  getTemplateEntry,
  isTemplateInstalled,
  clearTemplateRegistry,
} from "./registry";

export type { SchemaValidationResult, SchemaValidationError } from "./schema";
export { validateDataAgainstSchema, validateTemplateData } from "./schema";
