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
  toolNames?: string[];
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
    };
    const timestamp = new Date().toISOString();
    const currentDate = timestamp.slice(0, 10);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
      dynamic_tools: (input.toolNames ?? []).map((name) => ({ type: 'function', name })),
    });
    this.write('world_state', {
      full: false,
      state: {
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

    const userText = textFromContent(input.userContent);
    this.write('response_item', {
      type: 'message',
      id: itemId('msg'),
      role: 'user',
      content: [{ type: 'input_text', text: userText }],
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
      output: result.result,
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
        internal_chat_message_metadata_passthrough: { turn_id: turn.id },
      });
      this.write('event_msg', { type: 'agent_message', turn_id: turn.id, text: assistantText, phase: 'final' });
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
