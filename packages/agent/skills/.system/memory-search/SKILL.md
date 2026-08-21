---
name: memory-search
description: "DUYA retrievable memory (RAG) + retrieval hook. 用户要求"配置记忆系统钩子 / 配 RAG / 开记忆检索 / 记忆搜不到 / 相关记忆不注入"时使用。Covers the UserPromptSubmit retrieval hook (hooks.json), memory index search, and the `duya memory search` CLI."
when-to-use: "Whenever the task involves DUYA's retrievable memory index, the memory-rag hook, short-message filtering, or searching the memory index directly."
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash]
---

# DUYA Retrievable Memory (RAG)

DUYA's memory system optionally ships a retrievable-memory (RAG) layer
(plan 428/430). After every successful curation run the memory worker
rebuilds a small SQLite index over the curated memory tree plus any
configured `scan_paths`:

- Index: `~/.duya/rag/memory-rag.db` (SQLite, FTS5 trigram keyword table +
  optional vector embeddings)
- Config: `[memory.rag]` in `~/.duya/config.toml` (or Settings → Memory →
  Retrieval), off by default
- Embeddings: reuse the provider framework — Anthropic has no embeddings
  API, retrieval degrades to keyword search

## Architecture

```
curation run ──▶ refreshMemoryRagIndex (full rebuild)
user prompt ──▶ [hooks] UserPromptSubmit ──▶ memory-rag-hook.mjs / memory-search.mjs
                ├─ filterPrompt: drop short / filler messages ("继续", "你好", "ok", …)
                ├─ vector search (best-effort) + FTS5 keyword fallback
                ├─ formatContext: title + path + full body (per-hit cap 6 KB,
                │                total cap 24 KB; lower-ranked hits are dropped
                │                whole when the union would exceed the cap)
                └─ stdout {"additionalContext": "### 相关记忆\n- …"}
                            │   wrapped in <system-reminder>
                            ▼
                  DuyaAgent._projectModelMessages drains this.promptContexts
                  into the first turn's provider messages (source='custom',
                  visibility='hidden') — same shape as loop-hook nudges.
```

The template hook is **synchronous by design** (no `async: true`, no
`asyncRewake: true`): retrieval is keyword-only or vector-cos over a tiny
SQLite index (typically well under 500 ms with a local embedding
provider, slower with hosted endpoints — the `timeoutMs: 5000` in
`hooks.json` bounds it). The agent blocks the first turn for that span
so the model sees the retrieved memory on the SAME turn as the user's
prompt. `DuyaAgent.streamChat` (see
`packages/agent/src/agent/DuyaAgent.ts:~548`) drains the hook's
`submitCtx.contexts` into the first `_projectModelMessages` projection as
`<system-reminder>` runtime_context messages (`source: 'custom'`). The
plan-430 sync-injection path closes the plan-87 "UserPromptSubmit
contexts only logged, never injected" gap that this file used to
document; the prior async + asyncRewake path was a workaround and
imposed a 4 KB cap (`DEFAULT_MAX_RESULT_CHARS`) that clipped every
retrieved body — see "Architecture changes" below.

Every retrieval run appends an event to the memory system log
(`~/.duya/memory-system-log/YYYY/MM/DD.jsonl`):
`rag_hook_retrieved` / `rag_hook_no_hits` / `rag_hook_error`, with the
mode (`vector` / `hybrid` / `keyword`) and the embedding fallback reason.

### Architecture changes (plan 430 follow-up)

The formatContext function used to emit a 220-char snippet + path per
hit. That is useless to a model that can't Read the file during the same
turn: only the path gave the agent any handle on the memory, and the
snippet often missed the part of the doc the user was asking about.
The hook now emits the **full body** (frontmatter-stripped), capped at
`FORMAT_PER_HIT_BODY_CHARS` (6 KB) per hit and `FORMAT_TOTAL_CHARS`
(24 KB) total. Lower-ranked hits are dropped whole — never half-clipped
mid-paragraph — when the union exceeds the total budget, so the highest-
scored memories always land intact. A truncated hit carries an HTML
comment marker so the model still knows the path points at the full
file: `<!-- read-full: this hit was truncated to 6000 chars; the path
above points at the full memory file -->`.

The hook path is synchronous so the model sees the body on the first
turn instead of on the turn-after-the-async-task-completes. With sync
execution the rendered additionalContext streams directly into the
provider messages (no 4 KB task-notification cap); the 24 KB total
ceiling is the only hard limit on what reaches the model.

## CLI: `duya memory search <query>`

Query the index directly from a terminal (or via the CLI API
`POST /v1/memory/search`):

```bash
duya memory search "dam crest elevation"
# → {ok, hits: [{title, path, snippet, score}]}
```

The CLI keeps the snippet-only output (one 220-char window per hit plus
path) because it's a human-readable tool, not an injected context. Use
`--json` to get snippet + path + score as JSON.

Returns 400 when `[memory.rag]` is not enabled. Use `duya memory status`
to inspect config + index state, `duya memory rebuild` to rebuild the
index on demand, `duya memory doctor` / `duya memory setup` to configure
the embedding provider.

## Hook registration (duya hook CLI)

The `[hooks]` section of `~/.duya/config.toml` only records **hook.json
file paths** — the hook content itself lives in the JSON files (the
ecosystem shape shared with Claude Code / ZCode). Register hooks through
the CLI, never by hand-editing config.toml:

```bash
duya hook list                 # what is registered + per-file parse status
duya hook validate <path>      # check a hook.json without writing
duya hook add <path>           # validate + register (--yes in non-interactive mode)
duya hook remove <path>        # unregister
```

`duya hook add` refuses to register a file that is unreadable or has a
malformed `hooks` object, so a broken hook.json can never land in the
config. The stored path may be absolute, `~`-prefixed, or relative to
`~/.duya`.

To wire the RAG hook:

1. Use this skill's `hooks.json` template (same directory as this file).
   First fix its `args[0]` — the retrieval script's **absolute path** on
   the user's machine:
   - dev: the duya repo path, e.g. `C:/Projects/duya/scripts/memory-rag-hook.mjs`;
   - packaged: resolve the runtime path (check `electron-builder.yml`
     resource layout, then verify the file exists with `ls`/`Get-Item`
     before writing it — never guess a path that does not exist).
2. Register THIS skill's `hooks.json` (the file you just fixed, right
   here in the skill directory) — do NOT copy it elsewhere:
   `duya hook add <path-to-this-file>`

Schema notes (strict — a violation WARNs and contributes nothing):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "process", "command": "node", "args": ["<abs-path-to-script>"],
          "timeoutMs": 5000 }
      ] }
    ]
  }
}
```

- No `async` / `asyncRewake`: synchronous execution, drained into the
  first turn's provider messages by `DuyaAgent._projectModelMessages`.
- `timeoutMs: 5000` bounds the slowest embedding endpoint so a hung
  provider never blocks the first turn past five seconds. Keyword-only
  (no embedding) is sub-100 ms on real indexes; vector cos is bounded
  by the embedding roundtrip.
- `matcher` is optional; without it the hook fires on every prompt.
- Hook changes hot-reload on the next run (config is read fresh per
  streamChat) — no restart needed.
- Fail-open: a missing / unreadable / invalid hook file is logged and
  skipped, never breaking the agent loop.

## Short-message filtering

Before any retrieval, `filterPrompt` drops prompts that are:

- empty, or shorter than 3 characters after trimming;
- known filler phrases even when longer (`继续`, `继续继续`, `你好`, `好的`,
  `谢谢`, `ok`, `hi`, `hello`, `continue`, `thanks`, …).

Filtered prompts exit 0 with empty context — no index read, no system-log
event. This keeps the hook quiet for "继续" / "你好" style turns.

## When to use / not to use

- Use the hook for passive injection; use the CLI or this skill's script
  when the user explicitly asks to search their memory.
- The index is rebuilt only after curation runs — new memory files are not
  searchable until the next refresh (or `duya memory rebuild`).
- The injected context (`### 相关记忆`) reaches the model on the first
  turn through `DuyaAgent._projectModelMessages` (sync path; plan 430).
  Pre-plan-430 docs called this an "async + asyncRewake" pipeline; that
  pipeline is gone — see "Architecture changes" above for the why.
