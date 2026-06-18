import type { TemplateManifest } from "./manifest";
import type { TemplateWidgetDefinition } from "../registry";
import type { WidgetComponentProps } from "../registry";
import type { ComponentType } from "react";
import { createTemplateLoader, templateToDefinition } from "./loader";

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

const templateLoader = createTemplateLoader();

export function installTemplate(
  manifest: TemplateManifest,
  component: ComponentType<WidgetComponentProps>,
  schema?: Record<string, unknown>,
  details?: string,
): TemplateWidgetDefinition {
  const existing = templateRegistry.get(manifest.name);

  const now = Date.now();
  const definition = templateLoader.registerTemplate(manifest, component, schema);

  const actionLog: TemplateActionLogEntry[] = existing
    ? [...existing.actionLog]
    : [];

  const action: TemplateActionLogEntry = {
    action: existing ? "upgrade" : "install",
    timestamp: now,
    details,
    previousVersion: existing?.manifest.version,
    newVersion: manifest.version,
  };
  actionLog.push(action);

  templateRegistry.set(manifest.name, {
    manifest,
    definition: {
      ...definition,
      installedAt: now,
    },
    installedAt: now,
    actionLog,
  });

  return definition;
}

export function uninstallTemplate(templateName: string, details?: string): boolean {
  const entry = templateRegistry.get(templateName);
  if (!entry) return false;

  const action: TemplateActionLogEntry = {
    action: "uninstall",
    timestamp: Date.now(),
    details,
    previousVersion: entry.manifest.version,
  };

  entry.actionLog.push(action);

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
