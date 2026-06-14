export type {
  BuiltinWidgetDefinition,
  DynamicWidgetDefinition,
  TemplateWidgetDefinition,
  WidgetComponentProps,
  WidgetDefinition,
  WidgetKind,
  WidgetPosition,
  WidgetSize,
} from "../contracts.js";
export {
  clearTemplateRegistry,
  getTemplateActionLog,
  getTemplateEntry,
  installTemplate,
  isTemplateInstalled,
  listInstalledTemplates,
  uninstallTemplate,
} from "./registry.js";
export * from "./template/index.js";
