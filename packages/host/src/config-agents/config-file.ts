/**
 * config-file.ts — the `config.toml` document primitives.
 *
 * The file is the shared product configuration: the Desktop config store
 * writes it, the Host reads it, and the Host writes back the namespaces it
 * owns through {@link writeConfigNamespace} — `agents`, and since plan 632
 * moved the provider write side here, also `providers` and `model`.
 *
 * ## Why the write is a surgical edit
 *
 * `config.toml` is documented as hand-edited. A parse → stringify round trip
 * would keep every *value* but drop every comment, expand inline tables and
 * renumber large integers (`1700000000000` → `1_700_000_000_000`). The
 * Desktop config store already normalizes the file that way, but the Host has
 * no reason to.
 *
 * So a namespace write replaces **only that namespace in the raw
 * text** and copies every other byte through. The result is re-parsed and
 * compared against the intended table before it is written: if the edit
 * does not produce exactly the intended table, the write falls back to a full
 * document rewrite rather than landing something wrong.
 *
 * ## Atomicity
 *
 * The content lands in a sibling tmp file and is renamed over the target, so
 * a reader never sees a half-written config. On Windows a rename can be
 * refused (EPERM/EBUSY) when another holder opened the target without
 * `FILE_SHARE_DELETE`; the copy fallback then writes through the open handle.
 * Atomicity is lost in that case, but losing the user's configuration
 * entirely is worse.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, stringify } from '@iarna/toml';
import type { CustomAgentConfig } from './agent-config-schema.js';

/** A parsed `config.toml` document. */
export type ConfigTomlDocument = Record<string, unknown>;

/**
 * Read and parse `config.toml`.
 *
 * A missing file is an empty document (the first write creates it). A file
 * that does not parse is never overwritten: a copy is kept next to it and the
 * read fails, so the caller cannot silently replace a broken config with a
 * default one.
 */
export async function readConfigTomlDocument(configPath: string): Promise<ConfigTomlDocument> {
  const raw = await readRawConfig(configPath);
  if (raw === null) return {};
  try {
    return parse(raw) as ConfigTomlDocument;
  } catch (error) {
    throw await corruptConfigError(configPath, error);
  }
}

/**
 * The `[agents]` table of a parsed document.
 *
 * Throws when the table exists but is not a table — a malformed config must
 * not be silently replaced by an empty agent map.
 */
export function readAgentsTable(doc: ConfigTomlDocument): Record<string, CustomAgentConfig> {
  const raw = doc.agents;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.toml `agents` is not a table');
  }
  return raw as Record<string, CustomAgentConfig>;
}

/**
 * One root namespace of a parsed document, as a mutable shallow copy.
 *
 * Throws rather than returning `{}` when the namespace exists in a form that
 * cannot be replaced table by table (`[[model]]`, a scalar): an empty map
 * would read as "no providers configured", and the caller's write would then
 * delete what the file actually holds.
 */
export function readConfigNamespace(
  doc: ConfigTomlDocument,
  namespace: string,
): Record<string, unknown> {
  const raw = doc[namespace];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`config.toml \`${namespace}\` is not a table`);
  }
  return { ...(raw as Record<string, unknown>) };
}

/** Serialize a document and write it over `configPath` atomically. */
export async function writeConfigTomlDocument(
  configPath: string,
  doc: ConfigTomlDocument,
): Promise<void> {
  const content = stringify(doc as unknown as Parameters<typeof stringify>[0]);
  await writeFileAtomic(configPath, content);
}

/**
 * Replace one root namespace of `config.toml`, keeping every other byte as it
 * is, and return the edited text without touching the file.
 *
 * `expected` is what the caller believes it wrote; when the edit does not
 * re-parse to exactly that table, `verifyConfigNamespace` reports it and the
 * caller falls back to a full rewrite.
 */
export function editConfigNamespace(
  raw: string,
  namespace: string,
  table: Record<string, unknown>,
): string | null {
  return replaceNamespace(raw, namespace, serializeNamespaceBlock(namespace, table));
}

/**
 * True when `text` carries exactly the intended `namespace` table.
 *
 * The comparison is on the parsed table, not on the text: the editor is free
 * to lay the namespace out differently (expanded tables instead of inline
 * ones) as long as the values are the same.
 */
export function verifyConfigNamespace(
  text: string,
  namespace: string,
  table: Record<string, unknown>,
): boolean {
  let parsed: ConfigTomlDocument;
  try {
    parsed = parse(text) as ConfigTomlDocument;
  } catch {
    return false;
  }
  try {
    return canonicalTable(readConfigNamespace(parsed, namespace)) === canonicalTable(table);
  } catch {
    // The namespace came back in a form that is not a table — the edit did not
    // produce what was asked, whatever the reason.
    return false;
  }
}

/**
 * Replace the `[agents]` namespace of `config.toml`, keeping every other byte
 * of the file as it is.
 *
 * The edit is verified before it is written: the result is re-parsed and its
 * agent map must equal `agents` exactly. When the surgical edit cannot be
 * applied or does not verify (a root-level `agents = { … }` inline table, a
 * file the parser rejects), the write falls back to a full document rewrite —
 * lossy for comments, but always semantically correct.
 */
export async function writeConfigAgentsTable(
  configPath: string,
  agents: Record<string, CustomAgentConfig>,
): Promise<void> {
  await writeConfigNamespace(configPath, 'agents', agents);
}

/**
 * Replace one root namespace (`agents`, `providers`, `model`, …) in place.
 *
 * Same contract as {@link writeConfigAgentsTable}: surgical edit, verified by
 * re-parse, full-document rewrite as the fallback. The verification is what
 * makes this safe to point at a namespace the caller cares about — a provider
 * table that came back wrong would take every configured model with it.
 */
export async function writeConfigNamespace(
  configPath: string,
  namespace: string,
  table: Record<string, unknown>,
): Promise<void> {
  const raw = (await readRawConfig(configPath)) ?? '';
  const edited = editConfigNamespace(raw, namespace, table);
  if (edited !== null && verifyConfigNamespace(edited, namespace, table)) {
    await writeFileAtomic(configPath, edited);
    return;
  }
  const doc = await readConfigTomlDocument(configPath);
  await writeConfigTomlDocument(configPath, { ...doc, [namespace]: table });
}

// ==== the surgical namespace edit ====

/**
 * The TOML lines for a namespace table, or an empty list when it is empty (an
 * empty map would serialize as an inline `agents = { }` root key, which is not
 * what the rest of the product expects).
 */
function serializeNamespaceBlock(namespace: string, table: Record<string, unknown>): string[] {
  if (Object.keys(table).length === 0) return [];
  return stringify({ [namespace]: table } as unknown as Parameters<typeof stringify>[0]).split('\n');
}

/**
 * Replace every `[namespace…]` table in `raw` with `block`, keeping the rest
 * of the text byte for byte.
 *
 * Returns null when the document stores the table as a root-level key
 * (`agents = { … }`) — that form cannot be replaced table by table, and the
 * caller falls back to a full rewrite.
 */
function replaceNamespace(raw: string, namespace: string, block: string[]): string | null {
  const lines = raw.split('\n');
  if (hasRootLevelNamespaceKey(lines, namespace)) return null;

  const regions = findNamespaceRegions(lines, namespace);
  if (regions.length === 0) {
    if (block.length === 0) return raw;
    const tail = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines.slice();
    const separator = tail.length === 0 || tail[tail.length - 1] === '' ? [] : [''];
    return [...tail, ...separator, ...block, ''].join('\n');
  }

  const out: string[] = [];
  let cursor = 0;
  regions.forEach((region, index) => {
    out.push(...lines.slice(cursor, region.start));
    if (index === 0 && block.length > 0) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(...block);
      out.push('');
    }
    cursor = region.end;
  });
  out.push(...lines.slice(cursor));
  return out.join('\n');
}

/** A half-open line range `[start, end)` of the file. */
interface NamespaceRegion {
  start: number;
  end: number;
}

/**
 * The line ranges of every `[namespace…]` table.
 *
 * A table owns the lines from its header up to the next table header, so the
 * region of a namespace table ends where the next foreign table begins.
 */
function findNamespaceRegions(lines: string[], namespace: string): NamespaceRegion[] {
  const regions: NamespaceRegion[] = [];
  let current: NamespaceRegion | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const path = tablePath(lines[index]!);
    if (path === null) continue;
    if (path[0] === namespace) {
      if (current === null) current = { start: index, end: index + 1 };
      else current.end = index + 1;
      continue;
    }
    if (current !== null) {
      current.end = index;
      regions.push(current);
      current = null;
    }
  }
  if (current !== null) {
    current.end = lines.length;
    regions.push(current);
  }
  return regions;
}

/**
 * The path of a table header line, or null when the line is not a header.
 *
 * Quotes are stripped so `["agents.b"]` and `[agents.b]` are the same table.
 */
function tablePath(line: string): string[] | null {
  const match = /^\s*\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(line);
  if (match === null) return null;
  const raw = (match[1] ?? '').replace(/["']/g, '').trim();
  if (raw === '') return [];
  return raw.split('.').map((segment) => segment.trim());
}

/**
 * True when the root table carries a `namespace` key.
 *
 * Root keys must appear before the first table header, so only the preamble
 * is scanned.
 */
function hasRootLevelNamespaceKey(lines: string[], namespace: string): boolean {
  const pattern = new RegExp(`^\\s*(?:"${namespace}"|'${namespace}'|${namespace})\\s*=`);
  for (const line of lines) {
    if (tablePath(line) !== null) return false;
    if (pattern.test(line)) return true;
  }
  return false;
}

/** A stable, undefined-free rendering of a namespace table. */
function canonicalTable(table: Record<string, unknown>): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined) continue;
        out[key] = normalize(entry);
      }
      return out;
    }
    return value;
  };
  const sorted: Record<string, unknown> = {};
  for (const id of Object.keys(table).sort()) sorted[id] = normalize(table[id]!);
  return JSON.stringify(sorted);
}

// ==== file primitives ====

/** Read the raw text of `config.toml`, or null when it does not exist. */
export async function readRawConfig(configPath: string): Promise<string | null> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write `content` over `target` through a sibling tmp file. */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmpPath, content, { mode: 0o600 });
  } catch (error) {
    await unlinkQuietly(tmpPath);
    throw error;
  }
  try {
    await fs.rename(tmpPath, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY') {
      await unlinkQuietly(tmpPath);
      throw error;
    }
    // Atomic rename refused — fall through to the copy fallback.
    try {
      await fs.copyFile(tmpPath, target);
    } catch {
      throw error;
    } finally {
      await unlinkQuietly(tmpPath);
    }
  }
}

async function unlinkQuietly(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // Best effort: a leftover tmp file is harmless.
  }
}

/**
 * Keep a copy of a config file that does not parse, then refuse the write.
 *
 * The copy is what makes the refusal recoverable: without it, the next
 * successful write would replace a hand-repairable file with a default one.
 */
async function corruptConfigError(configPath: string, cause: unknown): Promise<Error> {
  const backupPath = `${configPath}.corrupt-${Date.now()}`;
  let kept = false;
  try {
    await fs.copyFile(configPath, backupPath);
    kept = true;
  } catch {
    // Best effort: the refusal to write is the important part.
  }
  return new Error(
    `config.toml at ${configPath} could not be parsed${
      kept ? `; a copy was kept at ${backupPath}` : ''
    }; the write was refused`,
    { cause },
  );
}
