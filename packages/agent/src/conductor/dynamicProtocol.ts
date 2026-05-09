import { z } from "zod";

export const DynamicWidgetOutputSchema = z.object({
  kind: z.literal("dynamic"),
  title: z.string().min(1).max(200),
  renderMode: z.literal("iframe"),
  html: z.string().min(1).max(100000),
  dataSchema: z.record(z.string(), z.unknown()).optional(),
  defaultData: z.record(z.string(), z.unknown()).optional(),
});

export type DynamicWidgetOutput = z.infer<typeof DynamicWidgetOutputSchema>;

export interface PendingDynamicWidget {
  id: string;
  output: DynamicWidgetOutput;
  sourceBlock: string;
  parsedAt: number;
  status: "pending" | "previewed" | "confirmed" | "rejected" | "created";
  sanitizedHtml?: string;
  warnings?: string[];
  blocked?: Array<{ element: string; attribute?: string; reason: string }>;
  createdAt?: number;
}

export function createPendingWidget(
  output: DynamicWidgetOutput,
  sourceBlock: string,
): PendingDynamicWidget {
  return {
    id: `pending-dynamic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    output,
    sourceBlock,
    parsedAt: Date.now(),
    status: "pending",
  };
}

const DUYA_WIDGET_FENCE_START = /^```duya-widget\s*$/m;
const FENCE_END = /^```\s*$/m;

export interface CodeFenceParseResult {
  success: boolean;
  output?: DynamicWidgetOutput;
  rawContent?: string;
  errors: string[];
}

export function parseDuyaWidgetFence(text: string): CodeFenceParseResult {
  const errors: string[] = [];

  const startMatch = text.match(DUYA_WIDGET_FENCE_START);
  if (!startMatch || startMatch.index === undefined) {
    errors.push("No ```duya-widget code fence found");
    return { success: false, errors };
  }

  const contentStart = startMatch.index + startMatch[0].length;
  const remaining = text.slice(contentStart);

  const endMatch = remaining.match(FENCE_END);
  if (!endMatch || endMatch.index === undefined) {
    errors.push("Unclosed ```duya-widget code fence");
    return { success: false, errors };
  }

  const rawContent = remaining.slice(0, endMatch.index).trim();

  if (!rawContent) {
    errors.push("Empty duya-widget code fence");
    return { success: false, errors };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    errors.push(`Invalid JSON in duya-widget fence: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, errors, rawContent };
  }

  const result = DynamicWidgetOutputSchema.safeParse(parsed);

  if (!result.success) {
    const zodErrors = result.error.issues.map((issue) =>
      `${issue.path.join(".")}: ${issue.message}`
    );
    errors.push(...zodErrors);
    return { success: false, errors, rawContent };
  }

  return {
    success: true,
    output: result.data,
    rawContent,
    errors: [],
  };
}

export function extractAllDuyaWidgetFences(text: string): CodeFenceParseResult[] {
  const results: CodeFenceParseResult[] = [];

  let remaining = text;
  while (remaining.length > 0) {
    const startMatch = remaining.match(DUYA_WIDGET_FENCE_START);
    if (!startMatch || startMatch.index === undefined) break;

    const contentStart = startMatch.index + startMatch[0].length;
    const afterStart = remaining.slice(contentStart);

    const endMatch = afterStart.match(FENCE_END);
    if (!endMatch || endMatch.index === undefined) {
      const rawContent = afterStart.trim();
      results.push({
        success: false,
        errors: ["Unclosed ```duya-widget code fence"],
        rawContent,
      });
      break;
    }

    const rawContent = afterStart.slice(0, endMatch.index).trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      results.push({
        success: false,
        errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
        rawContent,
      });
      remaining = remaining.slice(contentStart + endMatch.index + endMatch[0].length);
      continue;
    }

    const result = DynamicWidgetOutputSchema.safeParse(parsed);

    if (!result.success) {
      const zodErrors = result.error.issues.map((issue) =>
        `${issue.path.join(".")}: ${issue.message}`
      );
      results.push({ success: false, errors: zodErrors, rawContent });
    } else {
      results.push({ success: true, output: result.data, rawContent, errors: [] });
    }

    remaining = remaining.slice(contentStart + endMatch.index + endMatch[0].length);
  }

  return results;
}
