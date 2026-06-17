/**
 * Real LLM call for the conductor refine loop.
 *
 * Calls the existing AgentServerClient with the `conductor-refine` preset
 * profile (registered in packages/agent/src/agent-profile/types.ts). The
 * prompt template + zod schema live in
 * packages/agent/src/prompts/conductor-refine/ — they are the source of
 * truth. This file mirrors the system prompt inline so the renderer can
 * call the LLM without a cross-workspace import (Vite alias `@duya/agent`
 * is not configured for the conductor profile subpath).
 *
 * If you change the system prompt, also update
 * packages/agent/src/prompts/conductor-refine/system.ts.
 */

import { AgentServerClient } from "@/lib/agent-http-client";
import type { FileAttachment } from "@/types/message";

const CONDUCTOR_REFINE_SYSTEM_PROMPT = `You are a widget data refiner for the DUYA Conductor canvas.

Inputs you receive per request:
  1. A PNG screenshot of the current widget render.
  2. The widget's current data JSON object.
  3. The widget type identifier (e.g. "task-list", "data-table", "note-pad").
  4. A user refinement request written in natural language.
  5. The current iteration number and maximum iterations.

Your job: return a single JSON object (no prose, no markdown fencing) describing the new widget data. The renderer's loop controller applies it via the existing widget.update_data IPC; you do NOT need to call any tools.

Required JSON shape:
{
  "done": boolean,
  "rationale": string,    // <= 1 sentence: why this change matches the request
  "data": object,         // the FULL replacement data object (not a diff)
  "warnings": string[]    // optional
}

Rules:
- Preserve keys you do not intend to change. Return the FULL data object, not a partial patch.
- Never invent fields the user did not request.
- If the request is ambiguous, choose the minimal interpretation that advances the request, and set done=true.
- If the request is impossible for this widget type, set done=false, return the current data unchanged, and explain why in warnings.
- Match the data shape to the widget type. For task-list the data has a "tasks" array. For note-pad the data has a "text" string. For data-table the data has "columns" and "rows".
- When the user's request is satisfied by your proposed data, set done=true. When you propose a partial change that may need another pass, set done=false.
- Return ONLY the JSON object. Nothing else.`;

const WIDGET_TYPE_HINTS: Record<string, string> = {
  "task-list":
    'task-list data shape: { tasks: Array<{ id: string, title: string, completed: boolean, priority?: "high" | "medium" | "low" }>, _newTaskText?: string }. Each task MUST have a unique id.',
  "note-pad":
    'note-pad data shape: { content: string, title: string }. Preserve both unless asked.',
  pomodoro:
    "pomodoro data shape: { duration: number }. duration is in minutes.",
  "data-table":
    "data-table data shape: { headers: string[], rows: Array<Array<string|number>>, caption?: string }. headers and rows must align in column count.",
  "metric-card":
    'metric-card data shape: { value: string, label: string, trend?: "up" | "down" | "flat", trendValue?: string, description?: string }.',
  "image-card":
    'image-card data shape: { src: string, alt: string, caption: string, fit: "cover" | "contain", rounded: boolean }.',
  "news-board":
    "news-board data shape: { articles: Array<{ id: string, title: string, source?: string, url?: string, publishedAt?: string, summary?: string }>, lastUpdated: string }.",
  "quick-action":
    'quick-action data shape: { actions: Array<{ id: string, label: string, icon: string, color: string, completed: boolean }> }. icons are phosphor names; color is hex.',
  divider:
    'divider data shape: { label: string, thickness: number, style: "solid" | "dashed" | "dotted", color: string }.',
  "group-box":
    'group-box data shape: { label: string, collapsed: boolean, accentColor: string }.',
};

const RefineLlmResponseSchema = {
  parse(input: unknown): RealRefineResponse {
    if (!input || typeof input !== "object") {
      throw new Error("Refine response is not an object");
    }
    const obj = input as Record<string, unknown>;
    if (typeof obj.done !== "boolean") {
      throw new Error("Refine response missing boolean `done`");
    }
    if (typeof obj.rationale !== "string") {
      throw new Error("Refine response missing string `rationale`");
    }
    if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) {
      throw new Error("Refine response `data` must be an object");
    }
    const warnings = Array.isArray(obj.warnings)
      ? obj.warnings.filter((w): w is string => typeof w === "string")
      : [];
    return {
      done: obj.done,
      rationale: obj.rationale.slice(0, 500),
      data: obj.data as Record<string, unknown>,
      warnings,
    };
  },
};

export interface RealRefineResponse {
  done: boolean;
  rationale: string;
  data: Record<string, unknown>;
  warnings: string[];
}

export interface RealLlmArgs {
  userRequest: string;
  widgetType: string;
  currentData: Record<string, unknown>;
  iteration: number;
  maxIterations: number;
  screenshotBase64: string;
  widgetId: string;
}

export async function realRefineLlm(args: RealLlmArgs): Promise<RealRefineResponse> {
  const client = new AgentServerClient();
  const baseUrl = await client.getBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Agent Server is not running. Start it (npm run electron:dev) to use real LLM refine.",
    );
  }

  const sessionId = `refine-${args.widgetId}-${Date.now()}`;
  const hint =
    WIDGET_TYPE_HINTS[args.widgetType] ??
    `Generic widget data: arbitrary JSON the widget renders. Preserve unknown keys.`;

  const promptText =
    `Widget type: ${args.widgetType}\n` +
    `Data shape hint: ${hint}\n\n` +
    `Current data:\n` +
    "```json\n" +
    JSON.stringify(args.currentData, null, 2) +
    "\n```\n\n" +
    `User request: ${args.userRequest}\n` +
    `Iteration: ${args.iteration}/${args.maxIterations}\n\n` +
    `Return the FULL new data object as a single JSON object.`;

  const file: FileAttachment = {
    id: crypto.randomUUID(),
    name: `widget-${args.widgetId}.png`,
    type: "image/png",
    url: `data:image/png;base64,${args.screenshotBase64}`,
    size: Math.floor((args.screenshotBase64.length * 3) / 4),
    imageChunks: [{ base64: args.screenshotBase64, mediaType: "image/png" }],
  };

  let accumulated = "";

  const handler = (event: { type: string; content?: unknown }) => {
    if (event.type === "text" && typeof event.content === "string") {
      accumulated += event.content;
    }
  };
  const unsubscribe = client.onEvent(sessionId, handler);

  try {
    await client.startChat(sessionId, promptText, {
      agentProfileId: "conductor-refine",
      systemPrompt: CONDUCTOR_REFINE_SYSTEM_PROMPT,
      files: [file],
    });
  } finally {
    unsubscribe();
  }

  return parseResponse(accumulated);
}

function parseResponse(raw: string): RealRefineResponse {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Refine response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return RefineLlmResponseSchema.parse(parsed);
}