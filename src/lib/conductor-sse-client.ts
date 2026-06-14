import type { ConductorActionRequest, ConductorV2Snapshot } from "@duya/conductor/shared";

const SSE_LINE_REGEX = /^(event|id|data):\s*(.*)$/;
let cachedPort: number | null = null;

async function getPort(): Promise<number> {
  if (cachedPort !== null) return cachedPort;

  const api = window.electronAPI;
  if (!api?.getAgentServerPort) {
    throw new Error("Agent server port API not available");
  }

  const port = await api.getAgentServerPort();
  if (port === null) {
    throw new Error("Agent server not running");
  }

  cachedPort = port;
  return port;
}

function toConductorId(canvasId: string): string {
  return canvasId.startsWith("conductor-") ? canvasId : `conductor-${canvasId}`;
}

function parseEventData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface ConductorStreamHandlers {
  onConnected?: (data: { sessionId: string; state: string }) => void;
  onCanvasUpdate?: (data: { action?: string; canvasState?: ConductorV2Snapshot }) => void;
  onSubagentSpawn?: (data: Record<string, unknown>) => void;
  onSubagentEvent?: (data: Record<string, unknown>) => void;
  onSubagentDone?: (data: Record<string, unknown>) => void;
  onError?: (error: string) => void;
}

export async function openConductorStream(
  canvasId: string,
  handlers: ConductorStreamHandlers = {}
): Promise<() => void> {
  const port = await getPort();
  const conductorId = toConductorId(canvasId);
  const url = `http://127.0.0.1:${port}/conductor/${conductorId}/stream`;
  const controller = new AbortController();

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Failed to open conductor stream: ${response.status} ${errorBody}`);
  }

  if (!response.body) {
    throw new Error("Conductor stream has no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopped = false;

  const consume = async (): Promise<void> => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        let eventData = "";

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (line === "") {
            if (eventData) {
              const parsed = parseEventData(eventData);
              dispatchConductorEvent(eventType, parsed, handlers);
            }
            eventType = "";
            eventData = "";
            continue;
          }

          const match = line.match(SSE_LINE_REGEX);
          if (!match) continue;
          const [, field, valueText] = match;

          if (field === "event") {
            eventType = valueText;
          } else if (field === "data") {
            eventData += (eventData ? "\n" : "") + valueText;
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        handlers.onError?.((error as Error).message || "Conductor stream error");
      }
    } finally {
      reader.releaseLock();
    }
  };

  void consume();

  return () => {
    stopped = true;
    controller.abort();
  };
}

function dispatchConductorEvent(
  eventType: string,
  data: unknown,
  handlers: ConductorStreamHandlers
): void {
  const obj = (data || {}) as Record<string, unknown>;
  switch (eventType) {
    case "connected":
      handlers.onConnected?.({
        sessionId: String(obj.sessionId || ""),
        state: String(obj.state || ""),
      });
      break;
    case "canvas:update":
      handlers.onCanvasUpdate?.(obj as { action?: string; canvasState?: ConductorV2Snapshot });
      break;
    case "subagent:spawn":
      handlers.onSubagentSpawn?.(obj);
      break;
    case "subagent:event":
      handlers.onSubagentEvent?.(obj);
      break;
    case "subagent:done":
      handlers.onSubagentDone?.(obj);
      break;
    case "error":
      handlers.onError?.(String((obj.message as string) || "Conductor stream error"));
      break;
    default:
      break;
  }
}

export async function executeConductorTurn(
  canvasId: string,
  payload: {
    prompt: string;
    providerConfig: Record<string, unknown>;
    agentId?: string;
    agentName?: string;
    workingDirectory?: string;
    systemPrompt?: string;
  }
): Promise<void> {
  const port = await getPort();
  const conductorId = toConductorId(canvasId);
  const url = `http://127.0.0.1:${port}/conductor/${conductorId}/execute`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Failed to execute conductor turn: ${response.status} ${errorBody}`);
  }
}

export async function interruptConductorTurn(canvasId: string, agentId?: string): Promise<void> {
  const port = await getPort();
  const conductorId = toConductorId(canvasId);
  const url = `http://127.0.0.1:${port}/conductor/${conductorId}/execute`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agentId ? { agentId } : {}),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Failed to interrupt conductor turn: ${response.status} ${errorBody}`);
  }
}

export async function postConductorAction(
  canvasId: string,
  request: ConductorActionRequest & { actor?: string }
): Promise<void> {
  const port = await getPort();
  const conductorId = toConductorId(canvasId);
  const url = `http://127.0.0.1:${port}/conductor/${conductorId}/action`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Failed to post conductor action: ${response.status} ${errorBody}`);
  }
}

export interface ConductorStatusResponse {
  sessionId: string;
  canvasId: string;
  state: string;
  canvasState?: {
    canvas?: Record<string, unknown>;
    elements?: Record<string, unknown>[];
    conversationHistory?: Array<Record<string, unknown>>;
  };
  activeSubAgents?: Array<Record<string, unknown>>;
  completedSubAgents?: Array<Record<string, unknown>>;
}

export async function getConductorStatus(canvasId: string): Promise<ConductorStatusResponse> {
  const port = await getPort();
  const conductorId = toConductorId(canvasId);
  const url = `http://127.0.0.1:${port}/conductor/${conductorId}/status`;

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Failed to fetch conductor status: ${response.status} ${errorBody}`);
  }
  return response.json() as Promise<ConductorStatusResponse>;
}
