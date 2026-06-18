import type { ComponentType } from "react";

export type WidgetKind = "builtin" | "template" | "dynamic";

export interface WidgetComponentProps {
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  readOnly: boolean;
}

export interface WidgetSize {
  w: number;
  h: number;
}

export interface WidgetPosition extends WidgetSize {
  x: number;
  y: number;
}

export interface BuiltinWidgetDefinition {
  kind: "builtin";
  type: string;
  label: string;
  description?: string;
  component: ComponentType<WidgetComponentProps>;
  defaultData: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  dataSchema?: Record<string, unknown>;
}

export interface TemplateWidgetDefinition {
  kind: "template";
  type: string;
  label: string;
  description?: string;
  component: ComponentType<WidgetComponentProps>;
  defaultData: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  dataSchema?: Record<string, unknown>;
  manifestVersion: string;
  templateVersion: string;
  source: string;
  sourceUrl?: string;
  installedAt?: number;
}

export interface DynamicWidgetDefinition {
  kind: "dynamic";
  type: string;
  label: string;
  description?: string;
  component?: ComponentType<WidgetComponentProps>;
  defaultData: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  dataSchema?: Record<string, unknown>;
  renderMode: "iframe";
  sourceHtml: string;
  sanitizedHtml: string;
  warnings: string[];
  generatedAt: number;
  confirmedByUser: boolean;
}

export type WidgetDefinition =
  | BuiltinWidgetDefinition
  | TemplateWidgetDefinition
  | DynamicWidgetDefinition;

export interface WidgetInstance {
  id: string;
  definition: WidgetDefinition;
  position: WidgetPosition;
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  dataVersion: number;
}

export const widgetRegistry = new Map<string, WidgetDefinition>();

export function registerWidget(def: WidgetDefinition): void {
  widgetRegistry.set(def.type, def);
}

export function unregisterWidget(type: string): boolean {
  return widgetRegistry.delete(type);
}

export function getWidget(type: string): WidgetDefinition | undefined {
  return widgetRegistry.get(type);
}

export function getBuiltinWidgets(): BuiltinWidgetDefinition[] {
  const result: BuiltinWidgetDefinition[] = [];
  for (const def of widgetRegistry.values()) {
    if (def.kind === "builtin") {
      result.push(def);
    }
  }
  return result;
}

export function getTemplateWidgets(): TemplateWidgetDefinition[] {
  const result: TemplateWidgetDefinition[] = [];
  for (const def of widgetRegistry.values()) {
    if (def.kind === "template") {
      result.push(def);
    }
  }
  return result;
}

export function getDynamicWidgets(): DynamicWidgetDefinition[] {
  const result: DynamicWidgetDefinition[] = [];
  for (const def of widgetRegistry.values()) {
    if (def.kind === "dynamic") {
      result.push(def);
    }
  }
  return result;
}

export function listAvailableWidgets(kind?: WidgetKind): WidgetDefinition[] {
  const defs = Array.from(widgetRegistry.values());
  if (kind) {
    return defs.filter((d) => d.kind === kind);
  }
  return defs;
}

export interface WidgetInstanceFactory {
  createInstance(
    type: string,
    position: WidgetPosition,
    initialData?: Record<string, unknown>,
    initialConfig?: Record<string, unknown>,
  ): WidgetInstance | undefined;

  updateInstance(
    instance: WidgetInstance,
    data: Record<string, unknown>,
  ): WidgetInstance;

  getDefaultSize(type: string): WidgetSize | undefined;
  getMinSize(type: string): WidgetSize | undefined;
}

export function createWidgetInstanceFactory(): WidgetInstanceFactory {
  return {
    createInstance(type, position, initialData, initialConfig) {
      const def = widgetRegistry.get(type);
      if (!def) return undefined;

      return {
        id: crypto.randomUUID(),
        definition: def,
        position,
        data: initialData ?? { ...def.defaultData },
        config: initialConfig ?? { ...def.defaultConfig },
        dataVersion: 1,
      };
    },

    updateInstance(instance, data) {
      return {
        ...instance,
        data: { ...instance.data, ...data },
        dataVersion: instance.dataVersion + 1,
      };
    },

    getDefaultSize(type) {
      const def = widgetRegistry.get(type);
      return def ? { ...def.defaultSize } : undefined;
    },

    getMinSize(type) {
      const def = widgetRegistry.get(type);
      return def ? { ...def.minSize } : undefined;
    },
  };
}

export function clearRegistry(): void {
  widgetRegistry.clear();
}
