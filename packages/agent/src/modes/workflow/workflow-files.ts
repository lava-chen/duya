/**
 * workflow-files.ts — the workflow registry: named, reusable YAML files
 * (plan 415 §7.1 save-as + 552 §6.4 version semantics).
 *
 * Root defaults to `~/.duya/workflows/` (single authoritative store,
 * TOML-config style); tests inject a temp dir. Every load re-validates
 * the YAML against the schema + static checks — a file tampered with or
 * written by an older schema version fails LOUD instead of executing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseWorkflowDef, type WorkflowDef } from './schema.js';
import { validateWorkflow } from './validate.js';

export function defaultWorkflowRoot(): string {
  return path.join(os.homedir(), '.duya', 'workflows');
}

export class WorkflowFileRegistry {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? defaultWorkflowRoot();
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Save (or overwrite) a def as `<name>.yaml`. Returns the file path. */
  save(def: WorkflowDef): string {
    const file = this.pathFor(def.name);
    fs.writeFileSync(file, stringifyYaml(def), 'utf8');
    return file;
  }

  /**
   * Load + FULLY validate a named workflow. Throws on missing file or
   * any validation error (name conflict with the file is a warning only
   * — the YAML is authoritative).
   */
  load(name: string): WorkflowDef {
    const file = this.pathFor(name);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseYaml(raw);
    const result = validateWorkflow(parsed);
    if (!result.ok || !result.def) {
      const detail = result.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
      throw new Error(`workflow "${name}" failed validation: ${detail}`);
    }
    return result.def;
  }

  /** Raw parse without semantic validation — for previews. */
  loadRaw(name: string): unknown {
    return parseYaml(fs.readFileSync(this.pathFor(name), 'utf8'));
  }

  exists(name: string): boolean {
    return fs.existsSync(this.pathFor(name));
  }

  list(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map((f) => f.replace(/\.ya?ml$/, ''))
      .sort();
  }

  delete(name: string): boolean {
    const file = this.pathFor(name);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  private pathFor(name: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid workflow name: ${name}`);
    return path.join(this.root, `${name}.yaml`);
  }
}

/** Serialize a def to YAML text (used by save-as flows and previews). */
export function toYaml(def: WorkflowDef): string {
  return stringifyYaml(def);
}

export { parseWorkflowDef };
