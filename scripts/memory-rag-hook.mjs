#!/usr/bin/env node
/**
 * scripts/memory-rag-hook.mjs — UserPromptSubmit hook for the retrievable
 * memory index (plan 428).
 *
 * Thin entry over the shared core (`./memory-rag-lib.mjs`): reads the
 * plan-428 index built by the memory worker (`~/.duya/rag/memory-rag.db`),
 * skips short / filler prompts ("继续", "你好", "ok", …), retrieves the top
 * memories for the user's prompt, and emits them as
 * `{"additionalContext": "..."}` on stdout so the agent's UserPromptSubmit
 * hook injection can surface them in the first turn.
 *
 * Contract (plan 87 hooks):
 *   - stdin: JSON { session_id, cwd, hook_event_name, prompt }
 *   - stdout: JSON { additionalContext } (or empty — fail-open)
 *   - exit code: always 0; a failure degrades to empty context.
 *
 * Dependencies: Node built-ins + better-sqlite3 (resolved via
 * `DUYA_BETTER_SQLITE3_PATH` like the agent subprocess) + native fetch.
 * The embedding provider resolves through the provider framework config
 * (`[providers.<id>]` in `~/.duya/config.toml` + `~/.duya/secrets.json`),
 * mirroring `electron/memory/rag_embedding_client.ts`.
 */

import * as fs from 'node:fs';
import {
  resolveConfigDir,
  readRagSettings,
  resolveIndexPath,
  resolveProvider,
  retrieve,
  formatContext,
  appendSystemLog,
  filterPrompt,
} from './memory-rag-lib.mjs';

// ============================================================================
// Entry
// ============================================================================

/**
 * Read all of stdin as a single JSON object. Async with a 2s grace window:
 * some spawners close stdin immediately after writing, others leave the
 * pipe open — a sync blocking read would hang the hook forever in the
 * latter case.
 */
function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => finish(parseInput(raw)));
    process.stdin.on('error', () => finish(null));
    // If the pipe never closes (common on Windows test harnesses), proceed
    // with whatever was buffered rather than hanging.
    setTimeout(() => finish(parseInput(raw)), 2000);
  });
}

function parseInput(raw) {
  try {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function main() {
  const input = await readStdin();
  const rawPrompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const prompt = filterPrompt(rawPrompt);
  if (!prompt) {
    // Short / filler message — not worth a retrieval pass.
    process.exit(0);
  }

  const configDir = resolveConfigDir();
  const settings = readRagSettings(configDir);
  if (!settings) {
    process.exit(0);
  }

  const dbPath = resolveIndexPath(configDir, settings.indexPath);
  if (!fs.existsSync(dbPath)) {
    process.exit(0);
  }

  const provider = resolveProvider(configDir, settings);

  try {
    const started = Date.now();
    const { rows: hits, mode, fallbackReason } = await retrieve(dbPath, prompt, provider, settings);
    const durationMs = Date.now() - started;
    if (hits.length > 0) {
      appendSystemLog(configDir, {
        eventType: 'rag_hook_retrieved',
        level: 'info',
        message: 'RAG hook retrieved related memories',
        detail: {
          hits: hits.length,
          mode,
          durationMs,
          fallback: fallbackReason || null,
        },
        sessionId: input?.session_id,
      });
    } else {
      appendSystemLog(configDir, {
        eventType: 'rag_hook_no_hits',
        level: 'info',
        message: 'RAG hook found no related memories',
        detail: { mode, durationMs },
        sessionId: input?.session_id,
      });
    }
    const context = formatContext(hits);
    if (!context) {
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ additionalContext: context }));
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(configDir, {
      eventType: 'rag_hook_error',
      level: 'warn',
      message: 'RAG hook retrieval failed',
      detail: { error: message },
      sessionId: input?.session_id,
    });
    process.stderr.write(`memory-rag-hook: ${message}\n`);
    process.exit(0);
  }
}

main();
