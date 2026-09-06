/**
 * Agent Management Tools (Plan 492 P4 — grok sand-agent-management-tools.ts
 * port, schema and self-teaching errors kept line-for-line where the duya
 * persistence model allows).
 *
 * CreateAgent: spawn a new teammate bot from a name + persona. The id is
 * derived from the name in the main process (slugify + collision-free
 * allocation, electron/config/agents.ts createConfigAgentFromName) and
 * returned so the caller can immediately DM it with SendToAgent. There is
 * deliberately no delete tool (grok parity) — deletion is a user action.
 *
 * UpdateAgent: patch an existing bot's name and/or description. Only the
 * provided fields change; model / workspace / tools / plugins / prompt
 * table are preserved by the main-process patch path
 * (patchConfigAgentIdentity). grok semantics: no way to clear fields or
 * delete the agent here.
 *
 * Both tools persist via db-client IPC (config:agents:create / update) —
 * the agent subprocess never writes config.toml itself.
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolResult, ToolUseContext } from "../../types.js";
import { configDb } from "../../ipc/db-client.js";
import { CREATE_AGENT_TOOL_NAME, UPDATE_AGENT_TOOL_NAME } from "./constants.js";

/** Input schema for create_agent (grok createAgentParameters). */
const CREATE_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "A short, human-readable name for the new agent.",
    },
    description: {
      type: "string",
      description:
        "The new agent's persona / instructions: what it is for and how it should behave. This becomes its profile and shapes its replies. Optional but strongly recommended.",
    },
  },
  required: ["name"],
};

/** Input schema for update_agent (grok updateAgentParameters). */
const UPDATE_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    agentId: {
      type: "string",
      description: "The id of the agent to update.",
    },
    name: {
      type: "string",
      description: "A new name for the agent. Omit to leave the name unchanged.",
    },
    description: {
      type: "string",
      description:
        "A new persona/description for the agent. Omit to leave it unchanged.",
    },
  },
  required: ["agentId"],
};

const CREATE_AGENT_DESCRIPTION = `Create a new agent (a new teammate assistant) for your user, with a name and an optional persona/description. Returns the new agent's id so you can immediately message it with send_to_agent. Use this to spin up a focused teammate for a job. You have no tool to delete an agent, so only create one when it is genuinely useful; the user can delete an agent themselves from the sidebar.`;

const UPDATE_AGENT_DESCRIPTION = `Edit an existing agent's profile: its name and/or description. Only the fields you provide are changed; the rest are left exactly as they were, and there is no way to clear or delete an agent through this tool. Use it to refine a teammate you (or the user) created.`;

type ExecResult = { id: string; name: string; result: string; error?: boolean };

function result(
  name: string,
  text: string,
  error?: boolean,
): ToolResult {
  return {
    id: randomUUID(),
    name,
    result: text,
    ...(error !== undefined ? { error } : {}),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class CreateAgentTool implements Tool {
  readonly name = CREATE_AGENT_TOOL_NAME;
  readonly description = CREATE_AGENT_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = CREATE_AGENT_SCHEMA;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const name = asString(input.name)?.trim();
    const description = asString(input.description);

    if (!name) {
      return result(
        this.name,
        "Error: name is required. Give the new agent a short, human-readable name.",
        true,
      );
    }

    try {
      const created = await configDb.agentCreate({
        name,
        ...(description !== undefined ? { description } : {}),
      });
      return result(
        this.name,
        `Created agent "${created.name}" (id: ${created.id}). Message it with send_to_agent using that id.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return result(this.name, `Failed to create agent: ${message}`, true);
    }
  }
}

export class UpdateAgentTool implements Tool {
  readonly name = UPDATE_AGENT_TOOL_NAME;
  readonly description = UPDATE_AGENT_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = UPDATE_AGENT_SCHEMA;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const agentId = asString(input.agentId)?.trim();
    const name = asString(input.name);
    const description = asString(input.description);
    const avatarEmoji = asString(input.emoji);

    if (!agentId) {
      return result(
        this.name,
        "Error: agentId is required. Use the id from your teammates list (roster).",
        true,
      );
    }

    // grok parity: an empty patch is a teaching message, not an error.
    if ((!name || !name.trim()) && (!description || !description.trim())) {
      return result(
        this.name,
        "Nothing to update: provide a new name and/or description.",
      );
    }

    try {
      const updated = await configDb.agentUpdate({
        agentId,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(avatarEmoji !== undefined ? { avatarEmoji } : {}),
      });
      return result(
        this.name,
        `Updated agent "${updated.name}" (id: ${updated.id}).`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return result(
          this.name,
          `No agent found with id ${agentId}. Check your teammates list for valid ids.`,
        );
      }
      return result(this.name, `Failed to update agent: ${message}`, true);
    }
  }
}

export const createAgentTool = new CreateAgentTool();
export const updateAgentTool = new UpdateAgentTool();
