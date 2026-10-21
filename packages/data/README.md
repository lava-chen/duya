# @duya/data

Electron-independent filesystem and SQLite contracts for Duya's local data
layer.

- `resolveDataRoot()` defaults to `~/.duya`, supports `DUYA_DATA_ROOT`, and
  keeps namespaced test runs under `.duya/test-namespaces/`.
- `resolveDatabasePaths()` keeps the main, core, and memory-state SQLite files
  beside one another, including when `storage.database_path` is configured.
- `migratePreviousDefaultDatabases()` copies the prior Electron-default DB set
  and SQLite WAL/SHM files while retaining the old files as recovery copies.
- `openSqliteDatabase()` owns the common SQLite open settings (directory
  creation, WAL, busy timeout, and foreign keys). Both Desktop's
  `duya-main.db` adapter and `CoreDatabase` use it. The main `duya-main.db`
  schema and numbered migrations also live here; `MainSchemaPorts` lets the
  Host supply connection-slug derivation without making Data depend on
  plugin-core. Data owns the main database connection/schema/checkpoint/close
  lifecycle through `DatabaseHost`, which owns the main and core handles for
  one process. Desktop supplies the logger adapter and constructs the host;
  configured path selection, safe-mode policy, compatibility accessors, and
  shutdown ordering remain in Desktop during this migration.
- `CoreDatabase` opens `duya-core.db`, applies the supplied migrations, and
  owns its WAL checkpoint lifecycle.
- `RunStore` owns the `runs` and `run_events` schema migrations and durable
  run/event persistence operations.
- Durable Task, PermissionLedger, Lock, Goal, SpawnEdge, Attachment, ModeState,
  Session, Mailbox, Project, Research, Conductor, and PendingWake stores are
  shared here. Desktop's `db/core/stores.ts`, `session-store.ts`, `mailbox.ts`,
  `project-store.ts`, `research-store.ts`, `conductor-store.ts`, and
  `pending-wakes.ts` paths remain compatibility exports.
- Tool approval and SendMessage side-state persistence are also implemented
  here. Their old Desktop Main module paths remain compatibility exports while
  existing IPC handlers and schema initialization keep their current callers.
- Workbench data-source and handler persistence is shared here as well; the
  Desktop conductor service remains the caller during this migration.
- `createCoreDataStores()` builds those stores over a Host-owned SQLite handle;
  `collectCoreDataMigrations()` returns their sorted migration set.
- `MessageLog` owns append-only rollout JSONL, the `message_index` projection,
  rebase handling, text search, archive rotation, and crash-repair behavior.
  The persisted message and timeline contract comes from
  `@duya/agent-protocol/message-timeline`; logger and bot-session paths are
  injected through `MessageLogPorts`.
- `LegacyImport` reads the previous `duya-main.db` strictly read-only and
  idempotently imports core rows into `CoreDataHostStores`. It is Electron-free
  and uses the Protocol message-ingest codec; Desktop retains a compatibility
  export and still calls it during its current startup flow.

The Desktop `duya-main.db` compatibility accessor, memory-state
connection/migrations, path policy, and CoreStores adapter still live in Main.
Desktop's old MessageLog module is a compatibility adapter; Main still
composes it, and CLI has not yet been wired to the durable session writer.
These remaining responsibilities will move behind the standalone Host/Data
boundary incrementally.
