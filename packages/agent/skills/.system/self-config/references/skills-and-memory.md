# Skills and memory

Two related toggles: per-skill enable/disable and the retrievable
memory (RAG) subsystem. The CLI is the preferred write path; file
edits are acceptable for the RAG config because no dedicated
`duya memory` subcommand exists for that section.

## Enable / disable a skill

Use the Settings UI / skill manager when present. Underlying shape:
`{ name = "<skill>", enabled = false }` in the `skills` array (or
remove the entry to re-enable).

```toml
skills = [
  { name = "memory-search", enabled = true },
  { name = "obsidian-vault", enabled = false },
]
```

Disable takes effect immediately (skill is excluded from the skill
list). Re-enable may require a restart depending on how the skill
was loaded.

## Enable retrievable memory (RAG)

RAG (plan 428) lets the agent pull relevant notes into context
before answering. Toggle Settings → Memory → RAG, or set
`enabled = true` under `[memory.rag]`. A file edit is acceptable
here because no `duya memory` subcommand exists for this section.

```toml
[memory]
memory_enabled = true
user_profile_enabled = true
provider = "<embedding-provider-id>"
model = "<embedding-model-id>"

[memory.rag]
enabled = true
index_path = "~/.duya/rag/memory-rag.db"   # default
scan_paths = ["~/notes", "M:/Papers"]      # extra dirs to index
embedding_enabled = true
embedding_provider = "<embedding-provider-id>"
embedding_model = "<embedding-model-id>"
```

When enabled, DUYA rebuilds a SQLite index (`index_path`, FTS5
keyword search + optional vector embeddings) over the curated memory
tree plus `scan_paths` after each curation run.

### Register the retrieval hook

After enabling RAG, register the retrieval hook with the CLI — do
NOT hand-edit `config.toml` for hooks:

1. Use the `hooks.json` in the `memory-search` skill
   (`packages/agent/skills/.system/memory-search/`) — fix its
   `args[0]` to the absolute path of `scripts/memory-rag-hook.mjs`
   on this machine.
2. Register it: `duya hook add <path-to-that-hooks.json>` (validates
   the file before writing; `--yes` required in non-interactive
   mode).
   - `duya hook validate <path>` checks a file without writing.
   - `duya hook list` shows what is registered.

The template runs the retrieval in the **background** (`async: true`)
and delivers the result back into the session as a background
notification next turn (`asyncRewake: true`) — keep both fields; a
synchronous RAG hook would block the first turn and its stdout is
never injected into the model.

### Querying the index directly

```bash
duya memory search "<query>"
duya memory rebuild
```

See the `memory-search` skill for the full RAG overview and
`hook.json` schema.