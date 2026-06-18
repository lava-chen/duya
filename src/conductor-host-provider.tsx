/**
 * App-side ConductorHost provider.
 *
 * Supplies the host application implementation to the
 * `@duya/conductor/renderer` module. The renderer never reaches
 * into `src/lib/*` itself; the host (this file) imports
 * `listProvidersIPC` from `src/lib/ipc-client` and wraps
 * `AgentServerClient` from `src/lib/agent-http-client` into the
 * `ConductorHost` shape, then hands it to the renderer via
 * `<ConductorHostProvider host={…}>`.
 *
 * Mount this once near the top of the app, above any conductor
 * surface (`<AppShell>` or higher). The host also calls
 * `setConductorHostScope` on mount so the conductor store can
 * read `listProviders()` from non-React code paths.
 */
"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import {
  ConductorHostContext,
  setConductorHostScope,
  type ConductorHost,
} from "@duya/conductor/renderer";
import { listProvidersIPC } from "@/lib/ipc-client";
import { AgentServerClient } from "@/lib/agent-http-client";

interface ConductorHostProviderProps {
  children: ReactNode;
  /**
   * Optional override; when omitted we wire the defaults from
   * `src/lib/ipc-client` and `src/lib/agent-http-client`.
   */
  host?: ConductorHost;
}

export function ConductorHostProvider({
  children,
  host,
}: ConductorHostProviderProps) {
  const resolved = useMemo<ConductorHost>(() => {
    if (host) return host;
    return {
      listProviders: listProvidersIPC,
      agent: createConductorAgent(),
      settings: createConductorSettings(),
    };
  }, [host]);

  useEffect(() => {
    setConductorHostScope(resolved);
    return () => setConductorHostScope(null);
  }, [resolved]);

  return (
    <ConductorHostContext.Provider value={resolved}>
      {children}
    </ConductorHostContext.Provider>
  );
}

/**
 * Default host `settings` — wraps `window.electronAPI.settingsDb`
 * behind the `ConductorHostSettings` interface.
 */
function createConductorSettings() {
  return {
    async getJson<T>(key: string, defaultValue: T): Promise<T> {
      return window.electronAPI.settingsDb.getJson<T>(key, defaultValue);
    },
    async setJson<T>(key: string, value: T): Promise<void> {
      await window.electronAPI.settingsDb.setJson<T>(key, value);
    },
    async getString(key: string): Promise<string | null> {
      return window.electronAPI.settingsDb.get(key);
    },
    async setString(key: string, value: string): Promise<void> {
      await window.electronAPI.settingsDb.set(key, value);
    },
  };
}

/**
 * Default host `agent` — wraps the existing AgentServerClient
 * with the same call shape the old `realRefineLlm` produced.
 *
 * The transport is owned by the host; the renderer sees only the
 * typed callback.
 */
function createConductorAgent() {
  return {
    async callRefine(args: {
      sessionId: string;
      userRequest: string;
      widgetType: string;
      currentData: Record<string, unknown>;
      iteration: number;
      maxIterations: number;
      screenshotBase64: string;
    }) {
      const client = new AgentServerClient();
      const baseUrl = await client.getBaseUrl();
      if (!baseUrl) {
        throw new Error(
          "Agent Server is not running. Start it (npm run electron:dev) to use real LLM refine.",
        );
      }

      const WIDGET_TYPE_HINTS: Record<string, string> = {
        "task-list":
          'task-list data shape: { tasks: Array<{ id, title, completed, priority? }> }',
        "note-pad": "note-pad data shape: { content, title }",
        pomodoro: "pomodoro data shape: { duration } (minutes)",
        "data-table":
          "data-table data shape: { headers, rows, caption? }",
        "metric-card":
          'metric-card data shape: { value, label, trend?, trendValue?, description? }',
        "image-card":
          'image-card data shape: { src, alt, caption, fit, rounded }',
        "news-board": "news-board data shape: { articles, lastUpdated }",
        "quick-action":
          "quick-action data shape: { actions: Array<{ id, label, icon, color, completed }> }",
        divider:
          'divider data shape: { label, thickness, style, color }',
        "group-box":
          "group-box data shape: { label, collapsed, accentColor }",
      };

      const hint =
        WIDGET_TYPE_HINTS[args.widgetType] ??
        "Generic widget data: arbitrary JSON the widget renders.";

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

      const accumulated: string[] = [];
      const handler = (event: { type: string; content?: unknown }) => {
        if (event.type === "text" && typeof event.content === "string") {
          accumulated.push(event.content);
        }
      };
      const unsubscribe = client.onEvent(args.sessionId, handler);
      try {
        await client.startChat(args.sessionId, promptText, {
          agentProfileId: "conductor-refine",
          systemPrompt: CONDUCTOR_REFINE_SYSTEM_PROMPT,
          files: [
            {
              id: crypto.randomUUID(),
              name: `widget-${args.widgetType}.png`,
              type: "image/png",
              url: `data:image/png;base64,${args.screenshotBase64}`,
              size: Math.floor((args.screenshotBase64.length * 3) / 4),
              imageChunks: [
                { base64: args.screenshotBase64, mediaType: "image/png" },
              ],
            },
          ],
        });
      } finally {
        unsubscribe();
      }

      return parseRefineResponse(accumulated.join(""));
    },
  };
}

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

function parseRefineResponse(raw: string): {
  done: boolean;
  rationale: string;
  data: Record<string, unknown>;
  warnings: string[];
} {
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
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Refine response is not an object");
  }
  const obj = parsed as Record<string, unknown>;
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
}
