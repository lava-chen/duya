/**
 * config-file.ts — the `config.toml` document primitives.
 *
 * The file is the shared product configuration: the Desktop config store
 * writes it, the Host reads it, and (since the config-agents write side moved
 * here) the Host writes the `[agents]` namespace too.
 *
 * ## Why the write is a surgical edit
 *
 * `config.toml` is documented as hand-edited. A parse → stringify round trip
 * would keep every *value* but drop every comment, expand inline tables and
 * renumber large integers (`1700000000000` → `1_700_000_000_000`). The
 * Desktop config store already normalizes the file that way, but the Host has
 * no reason to.
 *
 * So the agents write replaces **only the `[agents]` namespace in the raw
 * text** and copies every other byte through. The result is re-parsed and
 * compared against the intended agent map before it is written: if the edit
 * does not produce exactly the intended map, the write falls back to a full
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

/** Serialize a document and write it over `configPath` atomically. */
export async function writeConfigTomlDocument(
  configPath: string,
  doc: ConfigTomlDocument,
): Promise<void> {
  const content = stringify(doc as unknown as Parameters<typeof stringify>[0]);
  await writeFileAtomic(configPath, content);
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
  const raw = (await readRawConfig(configPath)) ?? '';
  const edited = replaceAgentsNamespace(raw, serializeAgentsBlock(agents));
  if (edited !== null && agentsMatch(edited, agents)) {
    await writeFileAtomic(configPath, edited);
    return;
  }
  const doc = await readConfigTomlDocument(configPath);
  await writeConfigTomlDocument(configPath, { ...doc, agents });
}

// ==== the surgical namespace edit ====

/**
 * The TOML lines for the agent map, or an empty list when there are no
 * agents (an empty map would serialize as an inline `agents = { }` root key,
 * which is not what the rest of the product expects).
 */
function serializeAgentsBlock(agents: Record<string, CustomAgentConfig>): string[] {
  if (Object.keys(agents).length === 0) return [];
  return stringify({ agents } as unknown as Parameters<typeof stringify>[0]).split('\n');
}

/**
 * Replace every `[agents…]` table in `raw` with `block`, keeping the rest of
 * the text byte for byte.
 *
 * Returns null when the document stores the agent map as a root-level key
 * (`agents = { … }`) — that form cannot be replaced table by table, and the
 * caller falls back to a full rewrite.
 */
function replaceAgentsNamespace(raw: string, block: string[]): string | null {
  const lines = raw.split('\n');
  if (hasRootLevelAgentsKey(lines)) return null;

  const regions = findAgentsRegions(lines);
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
interface AgentsRegion {
  start: number;
  end: number;
}

/**
 * The line ranges of every `[agents…]` table.
 *
 * A table owns the lines from its header up to the next table header, so the
 * region of an agents table ends where the next non-agents table begins.
 */
function findAgentsRegions(lines: string[]): AgentsRegion[] {
  const regions: AgentsRegion[] = [];
  let current: AgentsRegion | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const path = tablePath(lines[index]!);
    if (path === null) continue;
    if (path[0] === 'agents') {
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
 * True when the root table carries an `agents` key.
 *
 * Root keys must appear before the first table header, so only the preamble
 * is scanned.
 */
function hasRootLevelAgentsKey(lines: string[]): boolean {
  for (const line of lines) {
    if (tablePath(line) !== null) return false;
    if (/^\s*(?:agents|"agents"|'agents')\s*=/.test(line)) return true;
  }
  return false;
}

/**
 * True when the parsed text carries exactly the intended agent map.
 *
 * The comparison is on the parsed map, not on the text: the editor is free
 * to lay the namespace out differently (expanded tables instead of inline
 * ones) as long as the values are the same.
 */
function agentsMatch(text: string, agents: Record<string, CustomAgentConfig>): boolean {
  let parsed: ConfigTomlDocument;
  try {
    parsed = parse(text) as ConfigTomlDocument;
  } catch {
    return false;
  }
  let table: Record<string, CustomAgentConfig>;
  try {
    table = readAgentsTable(parsed);
  } catch {
    return false;
  }
  return canonicalAgents(table) === canonicalAgents(agents);
}

/** A stable, undefined-free rendering of an agent map. */
function canonicalAgents(agents: Record<string, CustomAgentConfig>): string {
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
  for (const id of Object.keys(agents).sort()) sorted[id] = normalize(agents[id]);
  return JSON.stringify(sorted);
}

// ==== file primitives ====

async function readRawConfig(configPath: string): Promise<string | null> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
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
