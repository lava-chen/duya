import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  ProjectDatabaseCommandSchema,
  type DatabaseFilterNode,
  type DatabaseProperty,
  type DatabasePropertyOption,
  type DatabasePropertyType,
  type DatabaseQueryResult,
  type DatabaseRecord,
  type DatabaseRecordSnapshot,
  type DatabaseSortRule,
  type DatabaseSource,
  type DatabaseSourceSnapshot,
  type DatabaseValue,
  type DatabaseView,
  type ProjectDatabaseCommand,
} from '../../packages/conductor/src/database/types';
import { initializeProjectDatabaseSchema } from './schema';

type Sqlite = Database.Database;

interface SourceRow {
  id: string;
  name: string;
  description: string | null;
  icon_json: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface PropertyRow {
  id: string;
  source_id: string;
  name: string;
  type: DatabasePropertyType;
  config_json: string;
  position: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface OptionRow {
  id: string;
  property_id: string;
  name: string;
  color: string | null;
  group_id: string | null;
  position: string;
  archived_at: number | null;
}

interface RecordRow {
  id: string;
  source_id: string;
  title_plain: string;
  body_path: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ViewRow {
  id: string;
  source_id: string;
  name: string;
  type: 'table';
  filter_json: string | null;
  sort_json: string | null;
  layout_json: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ValueRow {
  record_id: string;
  property_id: string;
  value_type: DatabasePropertyType;
  text_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
  date_start: string | null;
  date_end: string | null;
  date_timezone: string | null;
  reference_value: string | null;
  json_value: string | null;
}

export class ProjectDatabaseError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_VALUE' | 'INVALID_QUERY',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProjectDatabaseError';
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rankForIndex(index: number): string {
  return String((index + 1) * 1024).padStart(12, '0');
}

function mapSource(row: SourceRow): DatabaseSource {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: parseJson(row.icon_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapOption(row: OptionRow): DatabasePropertyOption {
  return {
    id: row.id,
    propertyId: row.property_id,
    name: row.name,
    color: row.color,
    groupId: row.group_id,
    position: row.position,
    archivedAt: row.archived_at,
  };
}

function mapProperty(row: PropertyRow, options: DatabasePropertyOption[]): DatabaseProperty {
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    type: row.type,
    config: parseJson(row.config_json, {}),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    options,
  };
}

function mapRecord(row: RecordRow): DatabaseRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    title: row.title_plain,
    bodyPath: row.body_path,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapView(row: ViewRow): DatabaseView {
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    type: row.type,
    filter: parseJson<DatabaseFilterNode | null>(row.filter_json, null),
    sorts: parseJson<DatabaseSortRule[]>(row.sort_json, []),
    layout: parseJson(row.layout_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function actor(command: ProjectDatabaseCommand): 'user' | 'agent' | 'system' {
  return 'actor' in command && command.actor ? command.actor : 'user';
}

function ensureSource(db: Sqlite, sourceId: string, includeArchived = false): SourceRow {
  const clause = includeArchived ? '' : ' AND archived_at IS NULL';
  const row = db.prepare(`SELECT * FROM db_sources WHERE id = ?${clause}`).get(sourceId) as SourceRow | undefined;
  if (!row) throw new ProjectDatabaseError(`Database source ${sourceId} not found`, 'NOT_FOUND');
  return row;
}

function propertyRows(db: Sqlite, sourceId: string): PropertyRow[] {
  return db.prepare(
    'SELECT * FROM db_properties WHERE source_id = ? AND archived_at IS NULL ORDER BY position, created_at',
  ).all(sourceId) as PropertyRow[];
}

function propertiesForSource(db: Sqlite, sourceId: string): DatabaseProperty[] {
  const rows = propertyRows(db, sourceId);
  if (rows.length === 0) return [];
  const optionRows = db.prepare(
    `SELECT o.* FROM db_property_options o
     JOIN db_properties p ON p.id = o.property_id
     WHERE p.source_id = ? AND o.archived_at IS NULL
     ORDER BY o.position`,
  ).all(sourceId) as OptionRow[];
  const optionsByProperty = new Map<string, DatabasePropertyOption[]>();
  for (const row of optionRows) {
    const list = optionsByProperty.get(row.property_id) ?? [];
    list.push(mapOption(row));
    optionsByProperty.set(row.property_id, list);
  }
  return rows.map((row) => mapProperty(row, optionsByProperty.get(row.id) ?? []));
}

function viewsForSource(db: Sqlite, sourceId: string): DatabaseView[] {
  return (db.prepare(
    'SELECT * FROM db_views WHERE source_id = ? AND archived_at IS NULL ORDER BY created_at, id',
  ).all(sourceId) as ViewRow[]).map(mapView);
}

function sourceSnapshot(db: Sqlite, sourceId: string): DatabaseSourceSnapshot {
  return {
    source: mapSource(ensureSource(db, sourceId)),
    properties: propertiesForSource(db, sourceId),
    views: viewsForSource(db, sourceId),
  };
}

function recordRow(db: Sqlite, sourceId: string, recordId: string): RecordRow {
  const row = db.prepare(
    'SELECT * FROM db_records WHERE id = ? AND source_id = ?',
  ).get(recordId, sourceId) as RecordRow | undefined;
  if (!row) throw new ProjectDatabaseError(`Record ${recordId} not found`, 'NOT_FOUND');
  return row;
}

function assertRevision(row: RecordRow, expectedRevision: number): void {
  if (row.revision !== expectedRevision) {
    throw new ProjectDatabaseError(
      `Record ${row.id} changed since it was loaded`,
      'CONFLICT',
      { expectedRevision, actualRevision: row.revision },
    );
  }
}

function propertyMap(db: Sqlite, sourceId: string): Map<string, DatabaseProperty> {
  return new Map(propertiesForSource(db, sourceId).map((property) => [property.id, property]));
}

function validateOption(property: DatabaseProperty, optionId: string): void {
  if (!property.options.some((option) => option.id === optionId)) {
    throw new ProjectDatabaseError(
      `Option ${optionId} does not belong to property ${property.id}`,
      'INVALID_VALUE',
    );
  }
}

function validateValue(property: DatabaseProperty, value: DatabaseValue): void {
  if (value === null) return;
  switch (property.type) {
    case 'title':
      throw new ProjectDatabaseError('The title property is updated through the record title', 'INVALID_VALUE');
    case 'text':
    case 'url':
      if (typeof value !== 'string') throw new ProjectDatabaseError(`${property.name} expects text`, 'INVALID_VALUE');
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProjectDatabaseError(`${property.name} expects a number`, 'INVALID_VALUE');
      return;
    case 'checkbox':
      if (typeof value !== 'boolean') throw new ProjectDatabaseError(`${property.name} expects a checkbox value`, 'INVALID_VALUE');
      return;
    case 'select':
    case 'status':
      if (typeof value !== 'string') throw new ProjectDatabaseError(`${property.name} expects an option ID`, 'INVALID_VALUE');
      validateOption(property, value);
      return;
    case 'multi_select':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new ProjectDatabaseError(`${property.name} expects option IDs`, 'INVALID_VALUE');
      }
      for (const optionId of value) validateOption(property, optionId);
      return;
    case 'date':
      if (typeof value !== 'object' || Array.isArray(value) || typeof value.start !== 'string') {
        throw new ProjectDatabaseError(`${property.name} expects a date range`, 'INVALID_VALUE');
      }
      return;
  }
}

function writeValue(
  db: Sqlite,
  recordId: string,
  property: DatabaseProperty,
  value: DatabaseValue,
  revision: number,
  now: number,
): void {
  validateValue(property, value);
  db.prepare('DELETE FROM db_value_refs WHERE record_id = ? AND property_id = ?').run(recordId, property.id);
  if (value === null) {
    db.prepare('DELETE FROM db_values WHERE record_id = ? AND property_id = ?').run(recordId, property.id);
    return;
  }

  const columns: {
    text: string | null;
    number: number | null;
    boolean: number | null;
    dateStart: string | null;
    dateEnd: string | null;
    timezone: string | null;
    reference: string | null;
    json: string | null;
  } = { text: null, number: null, boolean: null, dateStart: null, dateEnd: null, timezone: null, reference: null, json: null };

  if (property.type === 'text' || property.type === 'url') columns.text = value as string;
  if (property.type === 'number') columns.number = value as number;
  if (property.type === 'checkbox') columns.boolean = value ? 1 : 0;
  if (property.type === 'select' || property.type === 'status') columns.reference = value as string;
  if (property.type === 'multi_select') columns.json = JSON.stringify(value);
  if (property.type === 'date') {
    const date = value as { start: string; end?: string | null; timezone?: string | null };
    columns.dateStart = date.start;
    columns.dateEnd = date.end ?? null;
    columns.timezone = date.timezone ?? null;
  }

  db.prepare(`
    INSERT INTO db_values (
      record_id, property_id, value_type, text_value, number_value,
      boolean_value, date_start, date_end, date_timezone, reference_value,
      json_value, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id, property_id) DO UPDATE SET
      value_type = excluded.value_type,
      text_value = excluded.text_value,
      number_value = excluded.number_value,
      boolean_value = excluded.boolean_value,
      date_start = excluded.date_start,
      date_end = excluded.date_end,
      date_timezone = excluded.date_timezone,
      reference_value = excluded.reference_value,
      json_value = excluded.json_value,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).run(
    recordId,
    property.id,
    property.type,
    columns.text,
    columns.number,
    columns.boolean,
    columns.dateStart,
    columns.dateEnd,
    columns.timezone,
    columns.reference,
    columns.json,
    revision,
    now,
  );

  if (property.type === 'multi_select') {
    const insert = db.prepare(
      'INSERT INTO db_value_refs (record_id, property_id, target_kind, target_id, position) VALUES (?, ?, ?, ?, ?)',
    );
    (value as string[]).forEach((optionId, index) => insert.run(recordId, property.id, 'option', optionId, rankForIndex(index)));
  }
}

function valueFromRow(row: ValueRow): DatabaseValue {
  switch (row.value_type) {
    case 'text':
    case 'url':
      return row.text_value ?? '';
    case 'number':
      return row.number_value;
    case 'checkbox':
      return row.boolean_value === 1;
    case 'select':
    case 'status':
      return row.reference_value;
    case 'multi_select':
      return parseJson<string[]>(row.json_value, []);
    case 'date':
      return row.date_start ? { start: row.date_start, end: row.date_end, timezone: row.date_timezone } : null;
    default:
      return null;
  }
}

function recordSnapshots(db: Sqlite, sourceId: string, includeArchived: boolean): DatabaseRecordSnapshot[] {
  const rows = db.prepare(
    `SELECT * FROM db_records WHERE source_id = ?${includeArchived ? '' : ' AND archived_at IS NULL'} ORDER BY created_at, id`,
  ).all(sourceId) as RecordRow[];
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(',');
  const values = db.prepare(
    `SELECT * FROM db_values WHERE record_id IN (${placeholders})`,
  ).all(...rows.map((row) => row.id)) as ValueRow[];
  const valuesByRecord = new Map<string, Record<string, DatabaseValue>>();
  for (const row of values) {
    const current = valuesByRecord.get(row.record_id) ?? {};
    current[row.property_id] = valueFromRow(row);
    valuesByRecord.set(row.record_id, current);
  }
  return rows.map((row) => ({ record: mapRecord(row), values: valuesByRecord.get(row.id) ?? {} }));
}

function getRecordSnapshot(db: Sqlite, sourceId: string, recordId: string): DatabaseRecordSnapshot {
  const record = mapRecord(recordRow(db, sourceId, recordId));
  const values: Record<string, DatabaseValue> = {};
  for (const row of db.prepare('SELECT * FROM db_values WHERE record_id = ?').all(recordId) as ValueRow[]) {
    values[row.property_id] = valueFromRow(row);
  }
  return { record, values };
}

function addEvent(
  db: Sqlite,
  sourceId: string | null,
  recordId: string | null,
  actorType: 'user' | 'agent' | 'system',
  operation: string,
  payload: Record<string, unknown>,
  inverse: Record<string, unknown> | null,
  now: number,
): void {
  db.prepare(`
    INSERT INTO db_events (id, source_id, record_id, actor_type, actor_id, operation, payload_json, inverse_json, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(randomUUID(), sourceId, recordId, actorType, operation, JSON.stringify(payload), inverse ? JSON.stringify(inverse) : null, now);
}

function valueForProperty(snapshot: DatabaseRecordSnapshot, property: DatabaseProperty): DatabaseValue {
  return property.type === 'title' ? snapshot.record.title : snapshot.values[property.id] ?? null;
}

function assertFilterOperators(filter: DatabaseFilterNode, properties: Map<string, DatabaseProperty>): void {
  if ('and' in filter) return filter.and.forEach((node) => assertFilterOperators(node, properties));
  if ('or' in filter) return filter.or.forEach((node) => assertFilterOperators(node, properties));
  const property = properties.get(filter.propertyId);
  if (!property) throw new ProjectDatabaseError(`Unknown filter property ${filter.propertyId}`, 'INVALID_QUERY');
  const allowed = new Set<string>(['equals', 'not_equals', 'is_empty']);
  if (property.type === 'text' || property.type === 'url' || property.type === 'title' || property.type === 'multi_select') allowed.add('contains');
  if (property.type === 'number') { allowed.add('greater_than'); allowed.add('less_than'); }
  if (property.type === 'date') { allowed.add('before'); allowed.add('after'); }
  if (!allowed.has(filter.operator)) {
    throw new ProjectDatabaseError(`${filter.operator} is not valid for ${property.type}`, 'INVALID_QUERY');
  }
}

function comparable(value: DatabaseValue): string | number | boolean | null {
  if (value === null || Array.isArray(value)) return null;
  if (typeof value === 'object') return value.start;
  return value;
}

function filterMatches(snapshot: DatabaseRecordSnapshot, filter: DatabaseFilterNode, properties: Map<string, DatabaseProperty>): boolean {
  if ('and' in filter) return filter.and.every((node) => filterMatches(snapshot, node, properties));
  if ('or' in filter) return filter.or.some((node) => filterMatches(snapshot, node, properties));
  const property = properties.get(filter.propertyId)!;
  const actual = valueForProperty(snapshot, property);
  const expected = filter.value ?? null;
  switch (filter.operator) {
    case 'is_empty':
      return actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0);
    case 'equals':
      return JSON.stringify(actual) === JSON.stringify(expected);
    case 'not_equals':
      return JSON.stringify(actual) !== JSON.stringify(expected);
    case 'contains':
      return Array.isArray(actual)
        ? typeof expected === 'string' && actual.includes(expected)
        : String(actual ?? '').toLocaleLowerCase().includes(String(expected ?? '').toLocaleLowerCase());
    case 'greater_than':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'less_than':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'before':
      return typeof comparable(actual) === 'string' && typeof comparable(expected) === 'string' && String(comparable(actual)) < String(comparable(expected));
    case 'after':
      return typeof comparable(actual) === 'string' && typeof comparable(expected) === 'string' && String(comparable(actual)) > String(comparable(expected));
  }
}

function compareValues(left: DatabaseValue, right: DatabaseValue): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function queryDatabase(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'query' }>): DatabaseQueryResult {
  const snapshot = sourceSnapshot(db, command.sourceId);
  const properties = new Map(snapshot.properties.map((property) => [property.id, property]));
  const view = command.viewId
    ? snapshot.views.find((candidate) => candidate.id === command.viewId) ?? null
    : snapshot.views[0] ?? null;
  if (command.viewId && !view) throw new ProjectDatabaseError(`View ${command.viewId} not found`, 'NOT_FOUND');
  const filter = command.filter !== undefined ? command.filter : view?.filter ?? null;
  const sorts = command.sorts !== undefined ? command.sorts : view?.sorts ?? [];
  if (filter) assertFilterOperators(filter, properties);
  for (const sort of sorts) {
    if (!properties.has(sort.propertyId)) throw new ProjectDatabaseError(`Unknown sort property ${sort.propertyId}`, 'INVALID_QUERY');
  }

  let records = recordSnapshots(db, command.sourceId, command.includeArchived ?? false);
  if (filter) records = records.filter((record) => filterMatches(record, filter, properties));
  records.sort((left, right) => {
    for (const sort of sorts) {
      const property = properties.get(sort.propertyId)!;
      const comparison = compareValues(valueForProperty(left, property), valueForProperty(right, property));
      if (comparison !== 0) return sort.direction === 'asc' ? comparison : -comparison;
    }
    return left.record.id.localeCompare(right.record.id);
  });

  if (command.cursor) {
    const cursorIndex = records.findIndex((record) => record.record.id === command.cursor);
    if (cursorIndex >= 0) records = records.slice(cursorIndex + 1);
  }
  const hasMore = records.length > command.limit;
  records = records.slice(0, command.limit);
  if (command.projection) {
    const projection = new Set(command.projection);
    records = records.map((item) => ({
      record: item.record,
      values: Object.fromEntries(Object.entries(item.values).filter(([propertyId]) => projection.has(propertyId))),
    }));
  }

  return {
    ...snapshot,
    view,
    records,
    nextCursor: hasMore ? records.at(-1)?.record.id ?? null : null,
  };
}

export class ProjectDatabaseEngine {
  private readonly connections = new Map<string, Sqlite>();

  invoke(dbPath: string, rawCommand: unknown): unknown {
    const command = ProjectDatabaseCommandSchema.parse(rawCommand);
    const db = this.open(dbPath);
    switch (command.type) {
      case 'initialize':
        return { schemaVersion: Number(db.pragma('user_version', { simple: true })) };
      case 'source.list':
        return (db.prepare(
          `SELECT * FROM db_sources${command.includeArchived ? '' : ' WHERE archived_at IS NULL'} ORDER BY updated_at DESC, id`,
        ).all() as SourceRow[]).map(mapSource);
      case 'source.get':
        return sourceSnapshot(db, command.sourceId);
      case 'source.create':
        return this.createSource(db, command);
      case 'source.archive':
        return this.archiveSource(db, command);
      case 'property.create':
        return this.createProperty(db, command);
      case 'record.create':
        return this.createRecord(db, command);
      case 'record.update':
        return this.updateRecord(db, command);
      case 'record.archive':
        return this.archiveRecord(db, command);
      case 'view.list':
        ensureSource(db, command.sourceId);
        return viewsForSource(db, command.sourceId);
      case 'view.create':
        return this.createView(db, command);
      case 'view.update':
        return this.updateView(db, command);
      case 'query':
        return queryDatabase(db, command);
    }
  }

  closeAll(): void {
    for (const db of this.connections.values()) {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    }
    this.connections.clear();
  }

  private open(dbPath: string): Sqlite {
    const resolved = path.resolve(dbPath);
    const existing = this.connections.get(resolved);
    if (existing?.open) return existing;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    initializeProjectDatabaseSchema(db);
    this.connections.set(resolved, db);
    return db;
  }

  private createSource(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'source.create' }>): DatabaseSourceSnapshot {
    const sourceId = randomUUID();
    const titlePropertyId = randomUUID();
    const viewId = randomUUID();
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`INSERT INTO db_sources (id, name, description, icon_json, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, NULL, ?, ?, NULL)`).run(sourceId, command.name, command.description ?? null, now, now);
      db.prepare(`INSERT INTO db_properties (id, source_id, name, type, config_json, position, created_at, updated_at, archived_at)
        VALUES (?, ?, 'Name', 'title', '{"type":"title"}', ?, ?, ?, NULL)`).run(titlePropertyId, sourceId, rankForIndex(0), now, now);
      db.prepare(`INSERT INTO db_views (id, source_id, name, type, filter_json, sort_json, quick_filters_json, layout_json, created_at, updated_at, archived_at)
        VALUES (?, ?, 'Table', 'table', NULL, '[]', NULL, ?, ?, ?, NULL)`).run(
        viewId,
        sourceId,
        JSON.stringify({ visiblePropertyIds: [titlePropertyId], columnWidths: {} }),
        now,
        now,
      );
      addEvent(db, sourceId, null, actor(command), command.type, { sourceId, titlePropertyId, viewId }, null, now);
    })();
    return sourceSnapshot(db, sourceId);
  }

  private archiveSource(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'source.archive' }>): DatabaseSourceSnapshot {
    ensureSource(db, command.sourceId, true);
    const now = Date.now();
    const archivedAt = command.archived ? now : null;
    db.transaction(() => {
      db.prepare('UPDATE db_sources SET archived_at = ?, updated_at = ? WHERE id = ?').run(archivedAt, now, command.sourceId);
      addEvent(db, command.sourceId, null, actor(command), command.type, { archived: command.archived }, { archived: !command.archived }, now);
    })();
    const source = mapSource(ensureSource(db, command.sourceId, true));
    return { source, properties: propertiesForSource(db, command.sourceId), views: viewsForSource(db, command.sourceId) };
  }

  private createProperty(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'property.create' }>): DatabaseProperty {
    ensureSource(db, command.sourceId);
    const propertyId = randomUUID();
    const now = Date.now();
    const count = propertyRows(db, command.sourceId).length;
    const options = command.options ?? [];
    if (options.length > 0 && !['select', 'multi_select', 'status'].includes(command.propertyType)) {
      throw new ProjectDatabaseError(`${command.propertyType} properties cannot define options`, 'INVALID_VALUE');
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO db_properties (id, source_id, name, type, config_json, position, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
        propertyId,
        command.sourceId,
        command.name,
        command.propertyType,
        JSON.stringify(command.config ?? { type: command.propertyType }),
        rankForIndex(count),
        now,
        now,
      );
      const insertOption = db.prepare(`INSERT INTO db_property_options
        (id, property_id, name, color, group_id, position, archived_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`);
      options.forEach((option, index) => insertOption.run(
        randomUUID(), propertyId, option.name, option.color ?? null, option.groupId ?? null, rankForIndex(index),
      ));
      const views = viewsForSource(db, command.sourceId);
      for (const view of views) {
        const visible = Array.isArray(view.layout.visiblePropertyIds)
          ? view.layout.visiblePropertyIds.filter((id): id is string => typeof id === 'string')
          : [];
        db.prepare('UPDATE db_views SET layout_json = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify({ ...view.layout, visiblePropertyIds: [...visible, propertyId] }), now, view.id,
        );
      }
      addEvent(db, command.sourceId, null, actor(command), command.type, { propertyId, propertyType: command.propertyType }, null, now);
    })();
    return propertiesForSource(db, command.sourceId).find((property) => property.id === propertyId)!;
  }

  private createRecord(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'record.create' }>): DatabaseRecordSnapshot {
    ensureSource(db, command.sourceId);
    const properties = propertyMap(db, command.sourceId);
    const recordId = randomUUID();
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`INSERT INTO db_records
        (id, source_id, title_plain, title_rich_json, body_path, body_hash, icon_json, cover_json, revision, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, ?, ?, NULL)`).run(recordId, command.sourceId, command.title, now, now);
      for (const [propertyId, value] of Object.entries(command.values ?? {})) {
        const property = properties.get(propertyId);
        if (!property) throw new ProjectDatabaseError(`Unknown property ${propertyId}`, 'INVALID_VALUE');
        writeValue(db, recordId, property, value, 1, now);
      }
      for (const view of viewsForSource(db, command.sourceId)) {
        const countRow = db.prepare(
          'SELECT COUNT(*) AS count FROM db_view_record_positions WHERE view_id = ?',
        ).get(view.id) as { count: number };
        const count = Number(countRow.count);
        db.prepare('INSERT INTO db_view_record_positions (view_id, record_id, group_key, rank) VALUES (?, ?, ?, ?)')
          .run(view.id, recordId, '', rankForIndex(count));
      }
      addEvent(db, command.sourceId, recordId, actor(command), command.type, { recordId, changedPropertyIds: Object.keys(command.values ?? {}) }, null, now);
    })();
    return getRecordSnapshot(db, command.sourceId, recordId);
  }

  private updateRecord(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'record.update' }>): DatabaseRecordSnapshot {
    ensureSource(db, command.sourceId);
    const current = recordRow(db, command.sourceId, command.recordId);
    assertRevision(current, command.expectedRevision);
    const before = getRecordSnapshot(db, command.sourceId, command.recordId);
    const properties = propertyMap(db, command.sourceId);
    const now = Date.now();
    const revision = current.revision + 1;
    db.transaction(() => {
      db.prepare('UPDATE db_records SET title_plain = ?, revision = ?, updated_at = ? WHERE id = ?').run(
        command.title ?? current.title_plain, revision, now, command.recordId,
      );
      for (const [propertyId, value] of Object.entries(command.values ?? {})) {
        const property = properties.get(propertyId);
        if (!property) throw new ProjectDatabaseError(`Unknown property ${propertyId}`, 'INVALID_VALUE');
        writeValue(db, command.recordId, property, value, revision, now);
      }
      addEvent(
        db,
        command.sourceId,
        command.recordId,
        actor(command),
        command.type,
        { previousRevision: current.revision, revision, changedPropertyIds: Object.keys(command.values ?? {}), titleChanged: command.title !== undefined },
        { title: before.record.title, values: before.values, revision: before.record.revision },
        now,
      );
    })();
    return getRecordSnapshot(db, command.sourceId, command.recordId);
  }

  private archiveRecord(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'record.archive' }>): DatabaseRecordSnapshot {
    ensureSource(db, command.sourceId);
    const current = recordRow(db, command.sourceId, command.recordId);
    assertRevision(current, command.expectedRevision);
    const now = Date.now();
    const revision = current.revision + 1;
    db.transaction(() => {
      db.prepare('UPDATE db_records SET archived_at = ?, revision = ?, updated_at = ? WHERE id = ?').run(
        command.archived ? now : null, revision, now, command.recordId,
      );
      addEvent(db, command.sourceId, command.recordId, actor(command), command.type, { archived: command.archived, revision }, { archived: !command.archived }, now);
    })();
    return getRecordSnapshot(db, command.sourceId, command.recordId);
  }

  private createView(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'view.create' }>): DatabaseView {
    const snapshot = sourceSnapshot(db, command.sourceId);
    const propertyIds = new Set(snapshot.properties.map((property) => property.id));
    if (command.filter) assertFilterOperators(command.filter, new Map(snapshot.properties.map((property) => [property.id, property])));
    for (const sort of command.sorts ?? []) {
      if (!propertyIds.has(sort.propertyId)) throw new ProjectDatabaseError(`Unknown sort property ${sort.propertyId}`, 'INVALID_QUERY');
    }
    const viewId = randomUUID();
    const now = Date.now();
    const defaultLayout = { visiblePropertyIds: snapshot.properties.map((property) => property.id), columnWidths: {} };
    db.transaction(() => {
      db.prepare(`INSERT INTO db_views
        (id, source_id, name, type, filter_json, sort_json, quick_filters_json, layout_json, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`).run(
        viewId,
        command.sourceId,
        command.name,
        command.viewType,
        command.filter ? JSON.stringify(command.filter) : null,
        JSON.stringify(command.sorts ?? []),
        JSON.stringify({ ...defaultLayout, ...(command.layout ?? {}) }),
        now,
        now,
      );
      addEvent(db, command.sourceId, null, actor(command), command.type, { viewId, viewType: command.viewType }, null, now);
    })();
    return viewsForSource(db, command.sourceId).find((view) => view.id === viewId)!;
  }

  private updateView(db: Sqlite, command: Extract<ProjectDatabaseCommand, { type: 'view.update' }>): DatabaseView {
    const snapshot = sourceSnapshot(db, command.sourceId);
    const current = snapshot.views.find((view) => view.id === command.viewId);
    if (!current) throw new ProjectDatabaseError(`View ${command.viewId} not found`, 'NOT_FOUND');
    const properties = new Map(snapshot.properties.map((property) => [property.id, property]));
    if (command.filter) assertFilterOperators(command.filter, properties);
    for (const sort of command.sorts ?? []) {
      if (!properties.has(sort.propertyId)) throw new ProjectDatabaseError(`Unknown sort property ${sort.propertyId}`, 'INVALID_QUERY');
    }
    const now = Date.now();
    const next = {
      name: command.name ?? current.name,
      filter: command.filter !== undefined ? command.filter : current.filter,
      sorts: command.sorts ?? current.sorts,
      layout: command.layout !== undefined ? command.layout : current.layout,
    };
    db.transaction(() => {
      db.prepare('UPDATE db_views SET name = ?, filter_json = ?, sort_json = ?, layout_json = ?, updated_at = ? WHERE id = ? AND source_id = ?').run(
        next.name,
        next.filter ? JSON.stringify(next.filter) : null,
        JSON.stringify(next.sorts),
        JSON.stringify(next.layout),
        now,
        command.viewId,
        command.sourceId,
      );
      addEvent(db, command.sourceId, null, actor(command), command.type, { viewId: command.viewId }, { name: current.name, filter: current.filter, sorts: current.sorts, layout: current.layout }, now);
    })();
    return viewsForSource(db, command.sourceId).find((view) => view.id === command.viewId)!;
  }
}
