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
                └─ stdout {"additionalContext": "### 相关记忆 …"}
```

The template hook is **asynchronous by design** (`async: true` +
`asyncRewake: true`): the retrieval script runs in the background — the
agent loop never blocks — and when it finishes, its `additionalContext` is
delivered back into the session as a background notification (`<task-notification>`
mailbox row, same channel as background bash tasks) that the model picks up
at the next turn checkpoint. The task also appears under Settings → Hooks →
"Background hook tasks" while it runs.

Every retrieval run appends an event to the memory system log
(`~/.duya/memory-system-log/YYYY/MM/DD.jsonl`):
`rag_hook_retrieved` / `rag_hook_no_hits` / `rag_hook_error`, with the
mode (`vector` / `hybrid` / `keyword`) and the embedding fallback reason.

## CLI: `duya memory search <query>`

Query the index directly from a terminal (or via the CLI API
`POST /v1/memory/search`):

```bash
duya memory search "dam crest elevation"
# → {ok, hits: [{title, path, snippet, score}]}
```

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
          "async": true, "asyncRewake": true }
      ] }
    ]
  }
}
```

- `async: true` runs the retrieval in the background (no first-turn block;
  output streams to `%TEMP%/duya-hook-<uuid>.log`).
- `asyncRewake: true` delivers the retrieved memories back into the session
  as a background notification the next turn — the model sees `### 相关记忆`
  without the agent having waited.
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
- The injected context (`### 相关记忆`) reaches the model through the
  background-notification path (see the template's `async` +
  `asyncRewake`). Do NOT drop back to a synchronous hook here: a sync
  UserPromptSubmit hook's stdout is logged but never injected into the
  model (known gap, plan 430) and it blocks the first turn for up to its
  timeout.
