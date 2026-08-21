#!/usr/bin/env node
/**
 * packages/agent/skills/.system/memory-search/scripts/memory-search.mjs
 *
 * Thin entry over the shared RAG core (scripts/memory-rag-lib.mjs) with two
 * invocation modes:
 *
 *   1. Hook mode (no argv): reads the plan-87 UserPromptSubmit JSON from
 *      stdin ({ session_id, cwd, hook_event_name, prompt }) and prints
 *      {"additionalContext": "### 相关记忆 …"} on stdout — identical to
 *      scripts/memory-rag-hook.mjs.
 *   2. CLI mode (--query / -q "<text>", optional --json): searches the
 *      index for one query and prints a human-readable hit list, or a JSON
 *      document with --json.
 *
 * Fail-open in both modes: empty output and exit 0 on any problem. Use it
 * from the [hooks] UserPromptSubmit config:
 *
 *   [hooks]
 *   UserPromptSubmit = [{ hooks = [{ type = "process", command = "node",
 *     args = ["C:/path/to/duya/packages/agent/skills/.system/memory-search/scripts/memory-search.mjs"],
 *     timeoutMs = 30000 }] }]
 *
 * The shared core (`memory-rag-lib.mjs`) ships in the same scripts/ dir;
 * keep the two copies in sync with `scripts/memory-rag-lib.mjs` when
 * changing the core (they are byte-identical today).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================================
// Shared core resolution
// ============================================================================
//
// memory-rag-lib.mjs ships NEXT TO this file (same scripts/ dir) so the
// skill is self-contained and works from any install location
// (`~/.duya/skills/.system/memory-search/scripts/`, bundled resources, or a
// dev checkout). The old dev-only layout (lib at repo-root `scripts/`, six
// `../` up) is kept as a fallback so pre-fix checkouts keep working.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const libCandidates = [
  path.join(scriptDir, 'memory-rag-lib.mjs'),
  path.resolve(scriptDir, '../../../../../../scripts/memory-rag-lib.mjs'),
];
const libPath = libCandidates.find((p) => fs.existsSync(p));
if (!libPath) {
  process.stderr.write(
    `memory-search: cannot find memory-rag-lib.mjs next to ${scriptDir}\n` +
      '  Reinstall the memory-search skill (duya skill sync) to restore it.\n',
  );
  process.exit(1);
}
const {
  resolveConfigDir,
  readRagSettings,
  resolveIndexPath,
  resolveProvider,
  retrieve,
  formatContext,
  buildSnippet,
  appendSystemLog,
  filterPrompt,
} = await import(pathToFileURL(libPath).href);

// ============================================================================
// Hook mode (plan 87 contract)
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

// ============================================================================
// CLI mode
// ============================================================================

function parseArgv(argv) {
  const out = { query: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      out.json = true;
    } else if (a === '--query' || a === '-q') {
      out.query = argv[i + 1] ?? '';
      i += 1;
    } else if (!a.startsWith('-') && !out.query) {
      out.query = a;
    }
  }
  return out;
}

/** Human-readable hit list for CLI mode. */
function formatCliHits(hits) {
  const lines = [];
  for (const h of hits) {
    lines.push(`- ${h.title}`);
    const summary = buildSnippet(h.content, h.matched_terms);
    if (summary) lines.push(`  ${summary}`);
    lines.push(`  path: ${h.root ? `${h.root}/` : ''}${h.rel_path}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Entry
// ============================================================================

async function searchAndReport(prompt, sessionId, configDir) {
  const settings = readRagSettings(configDir);
  if (!settings) return { hits: [], mode: 'keyword' };

  const dbPath = resolveIndexPath(configDir, settings.indexPath);
  const provider = resolveProvider(configDir, settings);

  const started = Date.now();
  const { rows: hits, mode, fallbackReason } = await retrieve(dbPath, prompt, provider, settings);
  const durationMs = Date.now() - started;
  appendSystemLog(configDir, {
    eventType: hits.length > 0 ? 'rag_hook_retrieved' : 'rag_hook_no_hits',
    level: 'info',
    message:
      hits.length > 0
        ? 'RAG search retrieved related memories'
        : 'RAG search found no related memories',
    detail: {
      hits: hits.length,
      mode,
      durationMs,
      fallback: fallbackReason || null,
    },
    sessionId: sessionId ?? null,
  });
  return { hits, mode };
}

async function main() {
  const args = process.argv.slice(2);

  // CLI mode: --query/-q (or a bare positional) plus optional --json.
  if (args.length > 0 && (args[0] === '--query' || args[0] === '-q' || args[0] === '--json' || !args[0].startsWith('-'))) {
    const opts = parseArgv(args);
    const prompt = filterPrompt(opts.query);
    if (!prompt) {
      if (opts.json) process.stdout.write(JSON.stringify({ ok: true, hits: [], skipped: true }));
      process.exit(0);
    }
    const configDir = resolveConfigDir();
    try {
      const { hits, mode } = await searchAndReport(prompt, null, configDir);
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, mode, hits: hits.map((h) => ({ title: h.title, path: h.rel_path, snippet: buildSnippet(h.content, h.matched_terms) })) }),
        );
      } else {
        const out = formatCliHits(hits);
        process.stdout.write(out ? `${out}\n` : '(no related memories found)\n');
      }
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendSystemLog(configDir, {
        eventType: 'rag_hook_error',
        level: 'warn',
        message: 'RAG search failed',
        detail: { error: message },
      });
      process.stderr.write(`memory-search: ${message}\n`);
      process.exit(0);
    }
  }

  // Hook mode: plan-87 stdin JSON contract.
  const input = await readStdin();
  const rawPrompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const prompt = filterPrompt(rawPrompt);
  if (!prompt) {
    process.exit(0);
  }

  const configDir = resolveConfigDir();
  try {
    const { hits } = await searchAndReport(prompt, input?.session_id, configDir);
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
      message: 'RAG search failed',
      detail: { error: message },
      sessionId: input?.session_id ?? null,
    });
    process.stderr.write(`memory-search: ${message}\n`);
    process.exit(0);
  }
}

main();
