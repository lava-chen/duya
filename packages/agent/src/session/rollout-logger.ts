/**
 * Codex-style rollout ledger for a Duya agent session.
 *
 * This is an agent-event audit log, not a provider wire trace. It intentionally
 * records only the normalized conversation and tool lifecycle, so credentials,
 * HTTP headers, and attachment base64 never reach the JSONL file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { MessageContent } from '../types.js';

type RolloutType = 'session_meta' | 'world_state' | 'turn_context' | 'response_item' | 'event_msg';

interface RolloutEntry {
  timestamp: string;
  type: RolloutType;
  payload: Record<string, unknown>;
}

export interface RolloutTurn {
  id: string;
  startedAt: number;
  assistantText: string[];
  reasoning: string[];
  providerRequestCount: number;
}

export interface ProviderToolSnapshot {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentsMdSnapshot {
  directory: string;
  text: string;
}

export interface StartTurnInput {
  cwd: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  userContent: string | MessageContent[];
  permissionMode?: string;
  mode?: string;
  language?: string;
  tools?: ProviderToolSnapshot[];
  // Codex-compatible: AGENTS.md content is surfaced as a user message and in
  // world_state, not duplicated inside base_instructions.
  agentsMd?: AgentsMdSnapshot;
}

function toIsoDateFolder(now: Date): [string, string, string] {
  return [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ];
}

function textFromContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') return `[image attachment: ${block.source.media_type}]`;
    return `[attachment: ${block.type}]`;
  }).join('\n');
}

function itemId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

const loggers = new Map<string, RolloutLogger>();

export function getRolloutLogger(sessionId: string): RolloutLogger | null {
  if (process.env.DUYA_ROLLOUT_LOG === '0') return null;
  let logger = loggers.get(sessionId);
  if (!logger) {
    logger = new RolloutLogger(sessionId);
    loggers.set(sessionId, logger);
  }
  return logger;
}

export class RolloutLogger {
  private readonly filePath: string;
  private readonly completedTurns = new Set<string>();

  constructor(private readonly sessionId: string, rootDir = homedir()) {
    const now = new Date();
    const [year, month, day] = toIsoDateFolder(now);
    const dir = path.join(rootDir, '.duya', 'sessions', year, month, day);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  }

  getFilePath(): string {
    return this.filePath;
  }

  startTurn(input: StartTurnInput): RolloutTurn {
    const turn: RolloutTurn = {
      id: randomUUID(),
      startedAt: Date.now(),
      assistantText: [],
      reasoning: [],
      providerRequestCount: 0,
    };
    const timestamp = new Date().toISOString();
    const currentDate = timestamp.slice(0, 10);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Codex-compatible: AGENTS.md is surfaced as a user message and in
    // world_state. It is no longer duplicated inside base_instructions because
    // the agent now injects it as the first user message.
    const agentsMdText = input.agentsMd?.text;

    this.recordProviderRequest(turn, input);
    this.write('world_state', {
      full: true,
      state: {
        agents_md: input.agentsMd
          ? { directory: input.agentsMd.directory, text: input.agentsMd.text }
          : undefined,
        environments: {
          environments: { local: { cwd: input.cwd, status: 'available', shell: process.platform } },
          current_date: currentDate,
          timezone,
        },
        duya: { rollout_schema: 'codex-compatible-v1' },
      },
    });
    this.write('turn_context', {
      turn_id: turn.id,
      cwd: input.cwd,
      workspace_roots: [input.cwd],
      current_date: currentDate,
      timezone,
      model: input.model,
      permission_profile: { type: input.permissionMode ?? 'default' },
      collaboration_mode: { mode: input.mode ?? 'default' },
      language: input.language,
      summary: 'auto',
    });
    this.write('event_msg', {
      type: 'task_started',
      turn_id: turn.id,
      started_at: Math.floor(turn.startedAt / 1000),
    });

    // Codex-compatible: emit AGENTS.md as a user message before the actual user
    // request. The LLM still receives it via system prompt; this is an audit
    // representation that matches Codex's ledger structure.
    const userMessageBlocks: Array<{ type: 'input_text'; text: string }> = [];
    if (agentsMdText) {
      userMessageBlocks.push({ type: 'input_text', text: agentsMdText });
    }
    const userText = textFromContent(input.userContent);
    userMessageBlocks.push({ type: 'input_text', text: userText });

    this.write('response_item', {
      type: 'message',
      id: itemId('msg'),
      role: 'user',
      content: userMessageBlocks,
      internal_chat_message_metadata_passthrough: { turn_id: turn.id },
    });
    this.write('event_msg', {
      type: 'user_message',
      text_elements: [userText],
      message: userText,
      turn_id: turn.id,
    });
    return turn;
  }

  /**
   * Record the exact prompt and provider-visible tool surface for one actual
   * model request. `streamChat` calls this immediately before every provider
   * request, including follow-up turns after `tool_search` changes the set of
   * discoverable tools. This is an event-level audit snapshot, never an HTTP
   * request capture.
   *
   * The first request in a turn writes a full `session_meta` entry (with
   * `base_instructions` + `dynamic_tools`) so the complete system prompt is
   * captured once. Subsequent requests in the same turn write only a lightweight
   * `provider_request` event referencing the turn, avoiding multi-MB rollout
   * files when a single turn performs many round trips.
   */
  recordProviderRequest(turn: RolloutTurn, input: StartTurnInput): void {
    turn.providerRequestCount += 1;
    const timestamp = new Date().toISOString();
    if (turn.providerRequestCount === 1) {
      this.write('session_meta', {
        session_id: this.sessionId,
        id: this.sessionId,
        timestamp,
        cwd: input.cwd,
        originator: 'DUYA Desktop',
        cli_version: 'duya',
        source: 'duya',
        thread_source: 'user',
        model_provider: input.provider,
        base_instructions: { text: input.systemPrompt ?? '' },
        // Keep Codex's `dynamic_tools` field while preserving the complete
        // provider contract needed to compare tool exposure across requests.
        dynamic_tools: (input.tools ?? []).map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        })),
        duya_request_snapshot: {
          turn_id: turn.id,
          provider_request_index: turn.providerRequestCount,
          tool_count: input.tools?.length ?? 0,
        },
      });
    } else {
      // Lightweight snapshot for subsequent round trips in the same turn.
      // The full base_instructions and dynamic_tools are in the first
      // session_meta; repeating them per round trip bloats the file without
      // adding information (they only change when tool_search discovers new
      // tools, which is captured by tool_count here).
      this.write('event_msg', {
        type: 'provider_request',
        turn_id: turn.id,
        timestamp,
        provider_request_index: turn.providerRequestCount,
        tool_count: input.tools?.length ?? 0,
        model_provider: input.provider,
      });
    }
  }

  recordText(turn: RolloutTurn, text: string): void {
    if (text) turn.assistantText.push(text);
  }

  recordReasoning(turn: RolloutTurn, text: string): void {
    if (text) turn.reasoning.push(text);
  }

  recordToolUse(turn: RolloutTurn, toolUse: { id: string; name: string; input?: unknown }): void {
    const callId = toolUse.id || itemId('call');
    this.write('response_item', {
      type: 'function_call',
      id: itemId('fc'),
      call_id: callId,
      name: toolUse.name,
      arguments: JSON.stringify(toolUse.input ?? {}),
      internal_chat_message_metadata_passthrough: { turn_id: turn.id },
    });
  }

  recordToolResult(turn: RolloutTurn, result: { id: string; result: string; error?: boolean; duration_ms?: number }): void {
    this.write('response_item', {
      type: 'function_call_output',
      id: itemId('fco'),
      call_id: result.id,
      // Codex-compatible format: output is an array of content blocks,
      // not a raw string. Consumers parsing `output[0].text` would break
      // on a bare string.
      output: [{ type: 'input_text', text: result.result }],
      internal_chat_message_metadata_passthrough: { turn_id: turn.id, error: result.error === true, duration_ms: result.duration_ms },
    });
  }

  recordUsage(turn: RolloutTurn, usage: Record<string, unknown>): void {
    this.write('event_msg', { type: 'token_count', turn_id: turn.id, info: usage });
  }

  completeTurn(turn: RolloutTurn, error?: string): void {
    if (this.completedTurns.has(turn.id)) return;
    this.completedTurns.add(turn.id);
    const reasoning = turn.reasoning.join('');
    const assistantText = turn.assistantText.join('');
    if (reasoning) {
      this.write('response_item', {
        type: 'reasoning',
        id: itemId('rs'),
        summary: [{ type: 'summary_text', text: reasoning }],
        encrypted_content: null,
        internal_chat_message_metadata_passthrough: { turn_id: turn.id },
      });
      this.write('event_msg', { type: 'agent_reasoning', turn_id: turn.id, text: reasoning });
    }
    if (assistantText) {
      this.write('response_item', {
        type: 'message',
        id: itemId('msg'),
        role: 'assistant',
        content: [{ type: 'output_text', text: assistantText }],
        // Codex-compatible: phase distinguishes final answer from commentary.
        // duya currently only emits the final assembled text at turn end, so
        // all assistant messages are 'final'. If mid-turn commentary emission
        // is added later, those should use phase: 'commentary'.
        phase: 'final',
        internal_chat_message_metadata_passthrough: { turn_id: turn.id },
      });
      this.write('event_msg', { type: 'agent_message', turn_id: turn.id, message: assistantText, phase: 'final', memory_citation: null });
    }
    const completedAt = Date.now();
    this.write('event_msg', {
      type: 'task_complete',
      turn_id: turn.id,
      started_at: Math.floor(turn.startedAt / 1000),
      completed_at: Math.floor(completedAt / 1000),
      duration_ms: completedAt - turn.startedAt,
      ...(error ? { error } : {}),
    });
  }

  private write(type: RolloutType, payload: Record<string, unknown>): void {
    const entry: RolloutEntry = { timestamp: new Date().toISOString(), type, payload };
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Session observability must never interrupt a user turn.
    }
  }
}


