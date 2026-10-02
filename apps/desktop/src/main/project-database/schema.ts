import type Database from 'better-sqlite3';

const PROJECT_DATABASE_SCHEMA_VERSION = 1;

export function initializeProjectDatabaseSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS db_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS db_properties (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES db_sources(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      position TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS db_property_options (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      group_id TEXT,
      position TEXT NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS db_records (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES db_sources(id) ON DELETE CASCADE,
      title_plain TEXT NOT NULL DEFAULT '',
      title_rich_json TEXT,
      body_path TEXT,
      body_hash TEXT,
      icon_json TEXT,
      cover_json TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS db_values (
      record_id TEXT NOT NULL REFERENCES db_records(id) ON DELETE CASCADE,
      property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
      value_type TEXT NOT NULL,
      text_value TEXT,
      number_value REAL,
      boolean_value INTEGER,
      date_start TEXT,
      date_end TEXT,
      date_timezone TEXT,
      reference_value TEXT,
      json_value TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (record_id, property_id)
    );

    CREATE TABLE IF NOT EXISTS db_value_refs (
      record_id TEXT NOT NULL REFERENCES db_records(id) ON DELETE CASCADE,
      property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      position TEXT NOT NULL,
      PRIMARY KEY (record_id, property_id, target_kind, target_id)
    );

    CREATE TABLE IF NOT EXISTS db_views (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES db_sources(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      filter_json TEXT,
      sort_json TEXT,
      quick_filters_json TEXT,
      layout_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS db_view_record_positions (
      view_id TEXT NOT NULL REFERENCES db_views(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL REFERENCES db_records(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL DEFAULT '',
      rank TEXT NOT NULL,
      PRIMARY KEY (view_id, record_id, group_key)
    );

    CREATE TABLE IF NOT EXISTS db_relation_edges (
      property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
      source_record_id TEXT NOT NULL REFERENCES db_records(id) ON DELETE CASCADE,
      target_record_id TEXT NOT NULL REFERENCES db_records(id) ON DELETE CASCADE,
      rank TEXT,
      PRIMARY KEY (property_id, source_record_id, target_record_id)
    );

    CREATE TABLE IF NOT EXISTS db_events (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      record_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      inverse_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS db_operation_journal (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_properties_source
      ON db_properties(source_id, archived_at, position);
    CREATE INDEX IF NOT EXISTS idx_property_options_property
      ON db_property_options(property_id, archived_at, position);
    CREATE INDEX IF NOT EXISTS idx_records_source
      ON db_records(source_id, archived_at, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_values_text
      ON db_values(property_id, text_value);
    CREATE INDEX IF NOT EXISTS idx_values_number
      ON db_values(property_id, number_value);
    CREATE INDEX IF NOT EXISTS idx_values_date
      ON db_values(property_id, date_start);
    CREATE INDEX IF NOT EXISTS idx_values_boolean
      ON db_values(property_id, boolean_value);
    CREATE INDEX IF NOT EXISTS idx_value_refs_target
      ON db_value_refs(property_id, target_kind, target_id);
    CREATE INDEX IF NOT EXISTS idx_views_source
      ON db_views(source_id, archived_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_source
      ON db_events(source_id, created_at);
  `);

  const version = Number(db.pragma('user_version', { simple: true }));
  if (version < PROJECT_DATABASE_SCHEMA_VERSION) {
    db.pragma(`user_version = ${PROJECT_DATABASE_SCHEMA_VERSION}`);
  }
}

export { PROJECT_DATABASE_SCHEMA_VERSION };
