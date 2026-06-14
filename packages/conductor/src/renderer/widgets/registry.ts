import type { ComponentType } from "react";
import type {
  DynamicWidgetDefinition,
  TemplateWidgetDefinition,
  WidgetComponentProps,
  WidgetDefinition,
  WidgetKind,
  WidgetPosition,
  WidgetSize,
  BuiltinWidgetDefinition,
} from "../contracts.js";
import type { TemplateManifest } from "./template/manifest.js";

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

export interface TemplateRegistryEntry {
  manifest: TemplateManifest;
  definition: TemplateWidgetDefinition;
  installedAt: number;
  actionLog: TemplateActionLogEntry[];
}

export interface TemplateActionLogEntry {
  action: "install" | "uninstall" | "upgrade";
  timestamp: number;
  details?: string;
  previousVersion?: string;
  newVersion?: string;
}

const templateRegistry = new Map<string, TemplateRegistryEntry>();

export function installTemplate(
  manifest: TemplateRegistryEntry["manifest"],
  component: ComponentType<WidgetComponentProps>,
  schema?: Record<string, unknown>,
  details?: string,
): TemplateWidgetDefinition {
  const existing = templateRegistry.get(manifest.name);

  const now = Date.now();
  const definition: TemplateWidgetDefinition = {
    kind: "template",
    type: manifest.name,
    label: manifest.label,
    description: manifest.description,
    component,
    defaultData: { ...manifest.defaultData },
    defaultConfig: { ...manifest.defaultConfig },
    defaultSize: { ...manifest.defaultSize },
    minSize: { ...manifest.minSize },
    dataSchema: schema ?? manifest.dataSchema,
    manifestVersion: manifest.manifestVersion,
    templateVersion: manifest.version,
    source: manifest.source,
    sourceUrl: manifest.sourceUrl,
    installedAt: now,
  };

  const actionLog: TemplateActionLogEntry[] = existing ? [...existing.actionLog] : [];
  actionLog.push({
    action: existing ? "upgrade" : "install",
    timestamp: now,
    details,
    previousVersion: existing?.manifest.version,
    newVersion: manifest.version,
  });

  templateRegistry.set(manifest.name, {
    manifest,
    definition,
    installedAt: now,
    actionLog,
  });

  return definition;
}

export function uninstallTemplate(templateName: string, details?: string): boolean {
  const entry = templateRegistry.get(templateName);
  if (!entry) return false;

  entry.actionLog.push({
    action: "uninstall",
    timestamp: Date.now(),
    details,
    previousVersion: entry.manifest.version,
  });

  templateRegistry.delete(templateName);
  return true;
}

export function getTemplateActionLog(templateName: string): TemplateActionLogEntry[] {
  return templateRegistry.get(templateName)?.actionLog ?? [];
}

export function listInstalledTemplates(): TemplateRegistryEntry[] {
  return Array.from(templateRegistry.values());
}

export function getTemplateEntry(templateName: string): TemplateRegistryEntry | undefined {
  return templateRegistry.get(templateName);
}

export function isTemplateInstalled(templateName: string): boolean {
  return templateRegistry.has(templateName);
}

export function clearTemplateRegistry(): void {
  templateRegistry.clear();
}
