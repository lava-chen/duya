import type { WidgetSize } from "../registry";

export interface TemplateManifest {
  name: string;
  version: string;
  manifestVersion: "1.0";
  label: string;
  description?: string;
  author?: string;
  source: string;
  sourceUrl?: string;
  defaultData: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  dataSchema?: Record<string, unknown>;
  toolMappings?: TemplateToolMapping[];
  tags?: string[];
}

export interface TemplateToolMapping {
  toolName: string;
  widgetField: string;
  transform?: "identity" | "json" | "text" | "list";
}

export interface TemplateDirectoryStructure {
  manifest: "manifest.json";
  schema?: "schema.ts" | "schema.json";
  component: "component.tsx";
  styles?: "styles.css";
}

export function validateManifest(manifest: unknown): manifest is TemplateManifest {
  if (!manifest || typeof manifest !== "object") return false;
  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== "string" || !m.name) return false;
  if (typeof m.version !== "string" || !m.version) return false;
  if (m.manifestVersion !== "1.0") return false;
  if (typeof m.label !== "string" || !m.label) return false;
  if (typeof m.source !== "string" || !m.source) return false;
  if (typeof m.defaultData !== "object" || m.defaultData === null) return false;
  if (typeof m.defaultConfig !== "object" || m.defaultConfig === null) return false;
  if (!m.defaultSize || typeof m.defaultSize !== "object") return false;
  if (!m.minSize || typeof m.minSize !== "object") return false;

  const ds = m.defaultSize as Record<string, unknown>;
  const ms = m.minSize as Record<string, unknown>;
  if (typeof ds.w !== "number" || typeof ds.h !== "number") return false;
  if (typeof ms.w !== "number" || typeof ms.h !== "number") return false;

  return true;
}

export function createEmptyManifest(name: string): TemplateManifest {
  return {
    name,
    version: "0.1.0",
    manifestVersion: "1.0",
    label: name,
    source: "local",
    defaultData: {},
    defaultConfig: {},
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
  };
}
