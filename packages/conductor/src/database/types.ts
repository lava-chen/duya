import { z } from 'zod';

export const DATABASE_PROPERTY_TYPES = [
  'title',
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
] as const;

export type DatabasePropertyType = (typeof DATABASE_PROPERTY_TYPES)[number];
export type DatabaseViewType = 'table';

export interface DatabaseSource {
  id: string;
  name: string;
  description: string | null;
  icon: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface DatabasePropertyOption {
  id: string;
  propertyId: string;
  name: string;
  color: string | null;
  groupId: string | null;
  position: string;
  archivedAt: number | null;
}

export interface DatabaseProperty {
  id: string;
  sourceId: string;
  name: string;
  type: DatabasePropertyType;
  config: Record<string, unknown>;
  position: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  options: DatabasePropertyOption[];
}

export type DatabaseValue =
  | string
  | number
  | boolean
  | string[]
  | { start: string; end?: string | null; timezone?: string | null }
  | null;

export interface DatabaseRecord {
  id: string;
  sourceId: string;
  title: string;
  bodyPath: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface DatabaseRecordSnapshot {
  record: DatabaseRecord;
  values: Record<string, DatabaseValue>;
}

export interface DatabaseView {
  id: string;
  sourceId: string;
  name: string;
  type: DatabaseViewType;
  filter: DatabaseFilterNode | null;
  sorts: DatabaseSortRule[];
  layout: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type DatabaseFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'is_empty'
  | 'greater_than'
  | 'less_than'
  | 'before'
  | 'after';

export type DatabaseFilterNode =
  | { and: DatabaseFilterNode[] }
  | { or: DatabaseFilterNode[] }
  | { propertyId: string; operator: DatabaseFilterOperator; value?: DatabaseValue };

export interface DatabaseSortRule {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export interface DatabaseSourceSnapshot {
  source: DatabaseSource;
  properties: DatabaseProperty[];
  views: DatabaseView[];
}

export interface DatabaseQueryResult {
  source: DatabaseSource;
  properties: DatabaseProperty[];
  view: DatabaseView | null;
  records: DatabaseRecordSnapshot[];
  nextCursor: string | null;
}

export const DatabaseValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
  z.object({
    start: z.string().min(1),
    end: z.string().min(1).nullable().optional(),
    timezone: z.string().min(1).nullable().optional(),
  }),
  z.null(),
]);

const FilterNodeSchema: z.ZodType<DatabaseFilterNode> = z.lazy(() => z.union([
  z.object({ and: z.array(FilterNodeSchema).min(1) }).strict(),
  z.object({ or: z.array(FilterNodeSchema).min(1) }).strict(),
  z.object({
    propertyId: z.string().min(1),
    operator: z.enum([
      'equals',
      'not_equals',
      'contains',
      'is_empty',
      'greater_than',
      'less_than',
      'before',
      'after',
    ]),
    value: DatabaseValueSchema.optional(),
  }).strict(),
]));

export const DatabaseFilterNodeSchema = FilterNodeSchema;

export const DatabaseSortRuleSchema = z.object({
  propertyId: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
}).strict();

const ValuePatchSchema = z.record(z.string().min(1), DatabaseValueSchema);

export const ProjectDatabaseCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('initialize') }).strict(),
  z.object({ type: z.literal('source.list'), includeArchived: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('source.get'), sourceId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('source.create'),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('source.archive'),
    sourceId: z.string().min(1),
    archived: z.boolean().default(true),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('property.create'),
    sourceId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    propertyType: z.enum(DATABASE_PROPERTY_TYPES).exclude(['title']),
    config: z.record(z.string(), z.unknown()).optional(),
    options: z.array(z.object({
      name: z.string().trim().min(1).max(120),
      color: z.string().nullable().optional(),
      groupId: z.string().nullable().optional(),
    }).strict()).max(200).optional(),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('record.create'),
    sourceId: z.string().min(1),
    title: z.string().max(10_000).default(''),
    values: ValuePatchSchema.optional(),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('record.update'),
    sourceId: z.string().min(1),
    recordId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    title: z.string().max(10_000).optional(),
    values: ValuePatchSchema.optional(),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('record.archive'),
    sourceId: z.string().min(1),
    recordId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    archived: z.boolean().default(true),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('view.list'),
    sourceId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('view.create'),
    sourceId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    viewType: z.literal('table').default('table'),
    filter: FilterNodeSchema.nullable().optional(),
    sorts: z.array(DatabaseSortRuleSchema).max(20).optional(),
    layout: z.record(z.string(), z.unknown()).optional(),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('view.update'),
    sourceId: z.string().min(1),
    viewId: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    filter: FilterNodeSchema.nullable().optional(),
    sorts: z.array(DatabaseSortRuleSchema).max(20).optional(),
    layout: z.record(z.string(), z.unknown()).optional(),
    actor: z.enum(['user', 'agent', 'system']).optional(),
  }).strict(),
  z.object({
    type: z.literal('query'),
    sourceId: z.string().min(1),
    viewId: z.string().min(1).optional(),
    filter: FilterNodeSchema.nullable().optional(),
    sorts: z.array(DatabaseSortRuleSchema).max(20).optional(),
    projection: z.array(z.string().min(1)).max(100).optional(),
    limit: z.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).optional(),
    includeArchived: z.boolean().optional(),
  }).strict(),
]);

export type ProjectDatabaseCommand = z.infer<typeof ProjectDatabaseCommandSchema>;

export const ProjectDatabaseRequestSchema = z.object({
  projectPath: z.string().min(1),
  command: ProjectDatabaseCommandSchema,
}).strict();

export type ProjectDatabaseRequest = z.infer<typeof ProjectDatabaseRequestSchema>;

export interface ProjectDatabaseChangeEvent {
  operation: ProjectDatabaseCommand['type'];
  sourceId?: string;
  recordId?: string;
  viewId?: string;
}

export interface NativeDatabaseElementConfig {
  sourceId: string;
  viewId: string;
  displayMode: 'embedded';
  showTitle: boolean;
  previewLimit: number;
  interactionMode: 'canvas' | 'database';
}
