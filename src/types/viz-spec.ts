import { z } from 'zod';
import type { ElementKind } from './conductor';

// === Diagram Spec ===
export interface DiagramVizPayload {
  type: 'mermaid' | 'svg-raw';
  content: string;
  darkMode?: boolean;
}

export const DiagramVizPayloadSchema = z.object({
  type: z.enum(['mermaid', 'svg-raw']),
  content: z.string(),
  darkMode: z.boolean().optional(),
});

// === Chart Spec ===
export interface ChartVizPayload {
  chartType: 'bar' | 'line' | 'pie' | 'scatter';
  title?: string;
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    color?: string;
  }>;
  options?: {
    stacked?: boolean;
    showLegend?: boolean;
    yAxisLabel?: string;
  };
}

export const ChartDatasetSchema = z.object({
  label: z.string(),
  data: z.array(z.number()),
  color: z.string().optional(),
});

export const ChartVizPayloadSchema = z.object({
  chartType: z.enum(['bar', 'line', 'pie', 'scatter']),
  title: z.string().optional(),
  labels: z.array(z.string()),
  datasets: z.array(ChartDatasetSchema),
  options: z.object({
    stacked: z.boolean().optional(),
    showLegend: z.boolean().optional(),
    yAxisLabel: z.string().optional(),
  }).optional(),
});

// === Card Spec ===
export interface CardVizPayload {
  layout: 'horizontal' | 'vertical';
  header?: { title: string; subtitle?: string };
  sections: Array<{
    type: 'text' | 'key-value' | 'list' | 'progress' | 'image';
    content: Record<string, unknown>;
  }>;
  footer?: string;
}

export const CardSectionSchema = z.object({
  type: z.enum(['text', 'key-value', 'list', 'progress', 'image']),
  content: z.record(z.string(), z.unknown()),
});

export const CardVizPayloadSchema = z.object({
  layout: z.enum(['horizontal', 'vertical']),
  header: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
  }).optional(),
  sections: z.array(CardSectionSchema),
  footer: z.string().optional(),
});

// === Rich Text Spec ===
export interface RichTextVizPayload {
  format: 'markdown' | 'plain';
  content: string;
}

export const RichTextVizPayloadSchema = z.object({
  format: z.enum(['markdown', 'plain']),
  content: z.string(),
});

// === MiniApp Spec ===
export interface MiniAppVizPayload {
  html: string;
  js?: string;
  css?: string;
}

export const MiniAppVizPayloadSchema = z.object({
  html: z.string(),
  js: z.string().optional(),
  css: z.string().optional(),
});

// === Shape Spec (SVG-native shapes) ===
export interface ShapeVizPayload {
  style?: {
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
  };
}

export const ShapeVizPayloadSchema = z.object({
  style: z.object({
    fill: z.string().optional(),
    stroke: z.string().optional(),
    strokeWidth: z.number().optional(),
    opacity: z.number().optional(),
  }).optional(),
});

// === Discriminated payload union ===
export type VizSpecPayload =
  | DiagramVizPayload
  | ChartVizPayload
  | CardVizPayload
  | RichTextVizPayload
  | MiniAppVizPayload
  | ShapeVizPayload;

export function getPayloadSchema(kind: ElementKind): z.ZodTypeAny {
  const base = kind.split('/')[0];
  switch (base) {
    case 'diagram': return DiagramVizPayloadSchema;
    case 'chart': return ChartVizPayloadSchema;
    case 'content': {
      const sub = kind.split('/')[1];
      if (sub === 'card' || sub === 'image') return CardVizPayloadSchema;
      if (sub === 'rich-text') return RichTextVizPayloadSchema;
      return z.record(z.string(), z.unknown());
    }
    case 'app': return MiniAppVizPayloadSchema;
    case 'shape': return ShapeVizPayloadSchema;
    default: return z.record(z.string(), z.unknown());
  }
}