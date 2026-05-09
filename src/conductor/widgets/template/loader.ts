import type { TemplateManifest } from "./manifest";
import type { TemplateWidgetDefinition } from "../registry";
import type { WidgetComponentProps } from "../registry";
import type { ComponentType } from "react";

export interface LoadedTemplate {
  manifest: TemplateManifest;
  component: ComponentType<WidgetComponentProps>;
  schema?: Record<string, unknown>;
}

export interface TemplateLoadError {
  templateName: string;
  message: string;
  phase: "manifest" | "component" | "schema";
}

export interface TemplateLoadResult {
  success: boolean;
  template?: LoadedTemplate;
  errors: TemplateLoadError[];
}

export function templateToDefinition(
  loaded: LoadedTemplate,
  installedAt?: number,
): TemplateWidgetDefinition {
  return {
    kind: "template",
    type: loaded.manifest.name,
    label: loaded.manifest.label,
    description: loaded.manifest.description,
    component: loaded.component,
    defaultData: { ...loaded.manifest.defaultData },
    defaultConfig: { ...loaded.manifest.defaultConfig },
    defaultSize: { ...loaded.manifest.defaultSize },
    minSize: { ...loaded.manifest.minSize },
    dataSchema: loaded.schema ?? loaded.manifest.dataSchema,
    manifestVersion: loaded.manifest.manifestVersion,
    templateVersion: loaded.manifest.version,
    source: loaded.manifest.source,
    sourceUrl: loaded.manifest.sourceUrl,
    installedAt,
  };
}

export function createTemplateLoader(): {
  registerTemplate: (
    manifest: TemplateManifest,
    component: ComponentType<WidgetComponentProps>,
    schema?: Record<string, unknown>,
  ) => TemplateWidgetDefinition;
} {
  return {
    registerTemplate(manifest, component, schema) {
      const loaded: LoadedTemplate = { manifest, component, schema };
      return templateToDefinition(loaded, Date.now());
    },
  };
}
