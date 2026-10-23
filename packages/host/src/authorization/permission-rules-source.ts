/**
 * Where a run's permission rules come from, and what happens to the two
 * shapes the product has been carrying.
 *
 * ## The problem this module exists to solve
 *
 * `options.permissionRules` is read as TWO different shapes in the same
 * product:
 *
 *  - the host's turn path (`run-turn-overrides.ts`) reads it as the
 *    protocol's WIRE form — a flat `Record<source, readonly string[]>`;
 *  - the Desktop router (`mergeAdditionalRootsIntoPermissionRules`) reads it
 *    as the LEGACY permission-context blob —
 *    `{ permissions: { allow, deny, ask, additionalDirectories } }`.
 *
 * Neither reader is wrong on its own, but a field that means two things is a
 * field that will eventually be read the wrong way. The manifest is where
 * that mistake would become permanent — a run row that says "these rules
 * applied" when it is really holding the other shape.
 *
 * So the shapes are told apart HERE, by inspection, and each one is converted
 * explicitly. There is no cast, and no "convert after the cast" step: the
 * conversion is a function with a name, and the result says which shape it
 * came from.
 *
 * ## Why the behaviour split is preserved
 *
 * The legacy blob carries THREE lists — `allow`, `deny`, `ask` — and the wire
 * form has no dimension for behaviour: it is source to rule strings. Merging
 * the three into one bucket would put a value in the run row that no reader
 * could interpret, which is exactly the silent substitution this work exists
 * to prevent. So the conversion keeps the split in
 * {@link PermissionRuleTablesWire} and offers the merged projection only as
 * a convenience for readers that do not need the behaviour.
 *
 * ## Why the directories are roots, not rules
 *
 * `permissions.additionalDirectories` are WRITABLE ROOTS. The manifest
 * already has a field for those (`roots`), and a directory masquerading as a
 * rule string would be unreadable. So the conversion returns them
 * separately, and the factory merges them into the roots.
 */

import type {
  PermissionRuleSource,
  PermissionRulesWire,
  PermissionRuleTablesWire,
} from '@duya/agent-protocol';

/**
 * The protocol's rule-source the legacy blob's rules are recorded under.
 *
 * The legacy blob is the settings-shaped permission document: the worker
 * itself parses it as a single source (`settingsJsonToRules(blob, 'userSettings')`),
 * so recording it under one protocol source is the faithful mapping. The
 * conversion records the mapping explicitly rather than leaving a reader to
 * guess which source a rule came from.
 */
export const LEGACY_RULE_SOURCE: PermissionRuleSource = 'settings';

/** The legacy permission-context shape, as the product actually carries it. */
export interface LegacyPermissionContext {
  readonly permissions?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    readonly ask?: readonly string[];
    readonly additionalDirectories?: readonly string[];
  };
  readonly defaultMode?: string;
}

/** What a legacy blob turned into. */
export interface LegacyPermissionConversion {
  /** The behaviour split, in wire form. */
  readonly ruleTables: PermissionRuleTablesWire;
  /** The merged projection, in wire form. */
  readonly rules: PermissionRulesWire;
  /** The writable roots the blob carried. They are roots, not rules. */
  readonly additionalRoots: readonly string[];
  /** The keys the conversion did not understand. */
  readonly dropped: readonly string[];
}

/** The four things a permission-rules input can be. */
export type PermissionRulesInput =
  /** Already the protocol's wire form. */
  | { readonly kind: 'wire'; readonly rules: PermissionRulesWire }
  /** The legacy blob, converted explicitly. */
  | { readonly kind: 'legacy_context'; readonly conversion: LegacyPermissionConversion }
  /** No rules were supplied at all. */
  | { readonly kind: 'absent' }
  /** Something was supplied that is neither shape. */
  | { readonly kind: 'invalid'; readonly reason: string };

const PERMISSION_RULE_SOURCES: readonly PermissionRuleSource[] = [
  'workspace',
  'project',
  'settings',
  'session',
  'cli',
  'runtime',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) return null;
    out.push(entry);
  }
  return out;
}

/**
 * Read the protocol's wire form, checking the shape instead of casting it.
 *
 * A rule table that is a `Map` serialises to `{}`, and a manifest whose
 * `rules` are `{}` says "no rule allows anything" while looking like "the
 * rules were lost". A value that is not the shape is refused, because a rule
 * table nobody can read is worse than no rule table.
 */
export function readPermissionRulesWire(value: unknown): PermissionRulesWire | null {
  if (!isPlainRecord(value)) return null;
  const out: Record<string, readonly string[]> = {};
  for (const [source, tools] of Object.entries(value)) {
    if (!PERMISSION_RULE_SOURCES.includes(source as PermissionRuleSource)) return null;
    const list = readStringArray(tools);
    if (list === null) return null;
    out[source] = list;
  }
  return out as PermissionRulesWire;
}

/**
 * Tell the two shapes apart, and convert the legacy one explicitly.
 *
 * The legacy shape is recognised by its `permissions` member. A flat record
 * of source to arrays is the wire shape. Anything else is refused with a
 * reason, rather than being coerced into one of them.
 */
export function readPermissionRulesInput(value: unknown): PermissionRulesInput {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (!isPlainRecord(value)) {
    return { kind: 'invalid', reason: 'must be an object' };
  }

  // The legacy blob: it carries a `permissions` member.
  if (isPlainRecord(value.permissions)) {
    return { kind: 'legacy_context', conversion: convertLegacyPermissionContext(value) };
  }

  // The wire form: a flat record of source to rule strings.
  const wire = readPermissionRulesWire(value);
  if (wire === null) {
    return {
      kind: 'invalid',
      reason: 'must be a record of rule source to rule strings, or a legacy permission context',
    };
  }
  return { kind: 'wire', rules: wire };
}

/**
 * Convert the legacy permission-context blob into wire form.
 *
 * The conversion is explicit about three things:
 *
 *  1. the behaviour split is preserved (`ruleTables`), because the wire form
 *     cannot carry it;
 *  2. `additionalDirectories` become ROOTS, because that is what they are;
 *  3. anything the conversion does not understand is listed in `dropped`,
 *     because silently ignoring a key is how a value goes missing.
 */
export function convertLegacyPermissionContext(value: unknown): LegacyPermissionConversion {
  const source = isPlainRecord(value) ? value : {};
  const permissions = isPlainRecord(source.permissions) ? source.permissions : {};

  const allow = readStringArray(permissions.allow) ?? [];
  const deny = readStringArray(permissions.deny) ?? [];
  const ask = readStringArray(permissions.ask) ?? [];
  const additionalRoots = readStringArray(permissions.additionalDirectories) ?? [];

  const allowTable = allow.length > 0 ? { [LEGACY_RULE_SOURCE]: allow } as PermissionRulesWire : undefined;
  const denyTable = deny.length > 0 ? { [LEGACY_RULE_SOURCE]: deny } as PermissionRulesWire : undefined;
  const askTable = ask.length > 0 ? { [LEGACY_RULE_SOURCE]: ask } as PermissionRulesWire : undefined;

  const ruleTables: PermissionRuleTablesWire = {
    ...(allowTable === undefined ? {} : { allow: allowTable }),
    ...(denyTable === undefined ? {} : { deny: denyTable }),
    ...(askTable === undefined ? {} : { ask: askTable }),
  };

  // The merged projection: every rule the blob carried, under one source.
  // Readers that need the behaviour read `ruleTables`; readers that only
  // need "the rules" read this.
  const merged = [...allow, ...deny, ...ask];
  const rules = merged.length > 0 ? { [LEGACY_RULE_SOURCE]: merged } as PermissionRulesWire : {};

  const dropped: string[] = [];
  for (const key of Object.keys(source)) {
    if (key === 'permissions' || key === 'defaultMode') continue;
    dropped.push(key);
  }
  for (const key of Object.keys(permissions)) {
    if (
      key === 'allow' || key === 'deny' || key === 'ask' || key === 'additionalDirectories'
    ) {
      continue;
    }
    dropped.push(`permissions.${key}`);
  }

  return { ruleTables, rules, additionalRoots, dropped };
}

/**
 * Merge the three behaviour tables into one wire table.
 *
 * Used when a caller wants the flat view. The behaviour split is lost in the
 * result BY CONSTRUCTION, which is why the manifest keeps `ruleTables`
 * beside it.
 */
export function mergeRuleTables(tables: PermissionRuleTablesWire): PermissionRulesWire {
  const merged: Record<string, readonly string[]> = {};
  for (const table of [tables.allow, tables.deny, tables.ask]) {
    if (table === undefined) continue;
    for (const [source, rules] of Object.entries(table)) {
      const existing = merged[source] ?? [];
      merged[source] = [...existing, ...rules];
    }
  }
  return merged as PermissionRulesWire;
}
