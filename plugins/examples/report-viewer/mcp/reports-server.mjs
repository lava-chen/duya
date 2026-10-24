import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RESOURCE_URI = "ui://reports/overview";
const RESOURCE_PATH = new URL("../resources/overview.html", import.meta.url);
const resourceHtml = readFileSync(fileURLToPath(RESOURCE_PATH), "utf8");
const EVENT_TOOLS = [
  {
    name: "duya_ui_select",
    description: "Select a report row in the Report overview surface.",
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: { type: "string", const: "report-overview" },
        payload: {
          type: "object",
          properties: { recordId: { type: "string" } },
          required: ["recordId"],
          additionalProperties: false,
        },
      },
      required: ["surfaceId", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "duya_ui_highlight",
    description: "Highlight a report row in the Report overview surface.",
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: { type: "string", const: "report-overview" },
        payload: {
          type: "object",
          properties: { recordId: { type: "string" } },
          required: ["recordId"],
          additionalProperties: false,
        },
      },
      required: ["surfaceId", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "duya_ui_refresh",
    description: "Refresh the visible Report overview surface.",
    inputSchema: {
      type: "object",
      properties: { surfaceId: { type: "string", const: "report-overview" } },
      required: ["surfaceId"],
      additionalProperties: false,
    },
  },
];

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim()) void handleLine(line);
  }
});

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return;
  if (request.id === undefined) return;

  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { resources: {}, tools: {} },
        serverInfo: { name: "duya-report-viewer", version: "0.1.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "resources/list":
      result = {
        resources: [{ uri: RESOURCE_URI, name: "Report overview", mimeType: "text/html; charset=utf-8" }],
      };
      break;
    case "resources/read":
      if (request.params?.uri !== RESOURCE_URI) {
        return write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32002, message: "Resource not found" },
        });
      }
      result = {
        contents: [{ uri: RESOURCE_URI, mimeType: "text/html; charset=utf-8", text: resourceHtml }],
      };
      break;
    case "tools/list":
      result = { tools: EVENT_TOOLS };
      break;
    case "tools/call": {
      const tool = EVENT_TOOLS.find((candidate) => candidate.name === request.params?.name);
      if (!tool || request.params?.arguments?.surfaceId !== "report-overview") {
        return write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unknown tool or surface" },
        });
      }
      result = { content: [{ type: "text", text: "UI event accepted for the Report overview surface." }] };
      break;
    }
    default:
      return write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }

  write({ jsonrpc: "2.0", id: request.id, result });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
