/**
 * Phase 2 mock LLM. Hand-coded JSON responses keyed by request keyword.
 * Replaced by a real `ConductorRefineProfile` IPC call in Phase 3.
 */

import type { RefineLlmResponse } from "./types";

export interface MockLlmArgs {
  userRequest: string;
  widgetType: string;
  currentData: Record<string, unknown>;
  iteration: number;
  maxIterations: number;
  screenshotBase64: string;
}

export async function mockRefineLlm(args: MockLlmArgs): Promise<RefineLlmResponse> {
  const req = args.userRequest.toLowerCase();
  const data: Record<string, unknown> = { ...args.currentData };

  if (args.widgetType === "task-list") {
    const tasks = (data.tasks as Array<Record<string, unknown>>) ?? [];

    const addMatch = req.match(/add\s+(\d+)/);
    if (addMatch && req.includes("task")) {
      const n = parseInt(addMatch[1], 10);
      const seedTopics = extractTopics(req);
      for (let i = 0; i < n; i++) {
        const topic = seedTopics[i % Math.max(1, seedTopics.length)] ?? "new task";
        tasks.push({
          id: crypto.randomUUID(),
          title: `${topic} #${i + 1}`,
          completed: false,
          priority: "medium",
        });
      }
      data.tasks = tasks;
      return {
        done: true,
        rationale: `Added ${n} task${n === 1 ? "" : "s"}.`,
        data,
        warnings: [],
      };
    }

    if (req.includes("clear") || req.includes("empty")) {
      data.tasks = [];
      return {
        done: true,
        rationale: "Cleared all tasks.",
        data,
        warnings: [],
      };
    }

    if (req.includes("complete all") || req.includes("mark all done")) {
      for (const t of tasks) t.completed = true;
      data.tasks = tasks;
      return {
        done: true,
        rationale: "Marked all tasks as completed.",
        data,
        warnings: [],
      };
    }
  }

  if (args.widgetType === "note-pad") {
    const text = (data.content as string) ?? "";
    if (req.startsWith("append ")) {
      const addition = args.userRequest.slice(7);
      data.content = text ? `${text}\n${addition}` : addition;
      return {
        done: true,
        rationale: "Appended text to note.",
        data,
        warnings: [],
      };
    }
    if (req.includes("rename") || req.includes("title")) {
      const m = req.match(/to\s+["“]?([^"”\n]+)["”]?/);
      if (m) {
        data.title = m[1].trim();
        return {
          done: true,
          rationale: `Renamed note title to "${data.title}".`,
          data,
          warnings: [],
        };
      }
    }
  }

  if (args.widgetType === "pomodoro") {
    const m = req.match(/(\d+)\s*(min|minute)/);
    if (m) {
      data.duration = parseInt(m[1], 10);
      return {
        done: true,
        rationale: `Set pomodoro duration to ${data.duration} minutes.`,
        data,
        warnings: [],
      };
    }
  }

  if (args.widgetType === "metric-card") {
    if (req.includes("value") || req.includes("set")) {
      const m = req.match(/(?:to|=)\s+["“]?([^"”\n]+)["”]?/);
      if (m) {
        data.value = m[1].trim();
        return {
          done: true,
          rationale: `Updated metric value to "${data.value}".`,
          data,
          warnings: [],
        };
      }
    }
  }

  if (args.widgetType === "data-table") {
    const headers = (data.headers as string[]) ?? [];
    const rows = (data.rows as unknown[][]) ?? [];
    if (req.includes("add column")) {
      const m = req.match(/add column\s+["“]?([^"”\n]+)["”]?/);
      if (m) {
        const newCol = m[1].trim();
        headers.push(newCol);
        for (const row of rows) row.push("");
        data.headers = headers;
        data.rows = rows;
        return {
          done: true,
          rationale: `Added column "${newCol}".`,
          data,
          warnings: [],
        };
      }
    }
    if (req.includes("add row") || req.includes("add 1 row")) {
      const newRow = headers.map(() => "");
      rows.push(newRow);
      data.rows = rows;
      return {
        done: true,
        rationale: "Added a new empty row.",
        data,
        warnings: [],
      };
    }
  }

  if (args.widgetType === "news-board") {
    const articles = (data.articles as Array<Record<string, unknown>>) ?? [];
    const m = req.match(/add\s+(\d+)/);
    if (m && req.includes("article")) {
      const n = parseInt(m[1], 10);
      for (let i = 0; i < n; i++) {
        articles.push({
          id: crypto.randomUUID(),
          title: `New article #${articles.length + 1}`,
          source: "mock",
          publishedAt: new Date().toISOString(),
        });
      }
      data.articles = articles;
      data.lastUpdated = new Date().toISOString();
      return {
        done: true,
        rationale: `Added ${n} article(s).`,
        data,
        warnings: [],
      };
    }
  }

  return {
    done: true,
    rationale: "Mock LLM: no rule matched; returned current data unchanged.",
    data: args.currentData,
    warnings: ["Mock LLM has no rule for this request — change is a no-op."],
  };
}

function extractTopics(req: string): string[] {
  const m = req.match(/about\s+(.+)$/);
  if (m) {
    return m[1]
      .split(/[,\s]+(?:and\s+)?/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}