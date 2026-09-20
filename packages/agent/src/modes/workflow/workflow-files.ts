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

/**
 * Workflow scope (ZCode parity): `project` definitions live inside the
 * repository (`<project>/.duya/workflows/`) and travel with git; `global`
 * ones live under `~/.duya/workflows/` and are available from any project.
 * Lookup order: project wins over global on a name collision.
 */
export type WorkflowScope = 'project' | 'global';

export interface WorkflowDefinitionSummary {
  name: string;
  scope: WorkflowScope;
  description: string;
  whenToUse?: string;
  /** File path — the authoritative source (console shows it verbatim). */
  file: string;
  params: Array<{ name: string; type: string; required: boolean; default?: unknown }>;
  /** Trigger channels the definition declares (manual is implicit). */
  triggers: Array<'cron' | 'bot' | 'http'>;
  phaseCount: number;
  nodeCount: number;
  /** Only present when the file parsed AND validated. */
  valid: boolean;
  error?: string;
}

/** Classify a declared trigger object into its channel (or undefined). */
function triggerChannelOf(trigger: Record<string, unknown>): 'cron' | 'bot' | 'http' | undefined {
  if (typeof trigger.cron === 'string') return 'cron';
  if (trigger.bot && typeof trigger.bot === 'object') return 'bot';
  if (trigger.http && typeof trigger.http === 'object') return 'http';
  return undefined;
}

export class WorkflowFileRegistry {
  private readonly root: string;
  /** Optional project scope root (`<project>/.duya/workflows`); null = global only. */
  private readonly projectRoot: string | null;

  constructor(root?: string, projectDir?: string) {
    this.root = root ?? defaultWorkflowRoot();
    this.projectRoot = projectDir ? path.join(projectDir, '.duya', 'workflows') : null;
    fs.mkdirSync(this.root, { recursive: true });
    if (this.projectRoot) fs.mkdirSync(this.projectRoot, { recursive: true });
  }

  private rootsFor(scope: WorkflowScope): string {
    return scope === 'project' ? (this.projectRoot ?? this.root) : this.root;
  }

  /** Which scope a name resolves to (project shadows global). */
  scopeOf(name: string): WorkflowScope | undefined {
    if (this.projectRoot && fs.existsSync(path.join(this.projectRoot, `${name}.yaml`))) return 'project';
    if (fs.existsSync(path.join(this.root, `${name}.yaml`))) return 'global';
    return undefined;
  }

  /**
   * Save (or overwrite) a def as `<name>.yaml`. Scope defaults to
   * `global`; `project` requires the registry to have a project root.
   * Returns the file path.
   */
  save(def: WorkflowDef, scope: WorkflowScope = 'global'): string {
    const dir = this.rootsFor(scope);
    if (scope === 'project' && !this.projectRoot) {
      throw new Error('project scope requires a project directory');
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${assertName(def.name)}.yaml`);
    fs.writeFileSync(file, stringifyYaml(def), 'utf8');
    return file;
  }

  /**
   * Load + FULLY validate a named workflow. Throws on missing file or
   * any validation error (name conflict with the file is a warning only
   * — the YAML is authoritative).
   */
  load(name: string): WorkflowDef {
    const file = this.resolveFile(name);
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
    return parseYaml(fs.readFileSync(this.resolveFile(name), 'utf8'));
  }

  exists(name: string): boolean {
    return this.scopeOf(name) !== undefined;
  }

  /** Names from both scopes, project first; project shadows global. */
  list(): string[] {
    const names = new Set<string>();
    for (const dir of [this.projectRoot, this.root]) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.yaml') || f.endsWith('.yml')) names.add(f.replace(/\.ya?ml$/, ''));
      }
    }
    return [...names].sort();
  }

  /** Read-only summaries for the console definition library. */
  listDetailed(): WorkflowDefinitionSummary[] {
    return this.list().map((name) => {
      const scope = this.scopeOf(name) ?? 'global';
      const file = this.resolveFile(name);
      const base: WorkflowDefinitionSummary = {
        name,
        scope,
        description: '',
        file,
        params: [],
        triggers: [],
        phaseCount: 0,
        nodeCount: 0,
        valid: false,
      };
      try {
        const parsed = this.loadRaw(name);
        const result = validateWorkflow(parsed);
        if (parsed && typeof parsed === 'object') {
          const raw = parsed as {
            description?: unknown;
            when_to_use?: unknown;
            params?: unknown;
            triggers?: unknown;
            phases?: unknown;
          };
          base.description = typeof raw.description === 'string' ? raw.description : '';
          base.whenToUse = typeof raw.when_to_use === 'string' ? raw.when_to_use : undefined;
          if (Array.isArray(raw.params)) {
            base.params = (raw.params as Array<Record<string, unknown>>).map((p) => ({
              name: String(p.name ?? ''),
              type: String(p.type ?? 'string'),
              required: p.required === true,
              default: p.default,
            }));
          }
          if (Array.isArray(raw.triggers)) {
            base.triggers = (raw.triggers as Array<Record<string, unknown>>)
              .map(triggerChannelOf)
              .filter((c): c is 'cron' | 'bot' | 'http' => c !== undefined);
          }
          if (Array.isArray(raw.phases)) {
            base.phaseCount = raw.phases.length;
            for (const phase of raw.phases as Array<{ nodes?: unknown[] }>) {
              base.nodeCount += Array.isArray(phase.nodes) ? phase.nodes.length : 0;
            }
          }
        }
        base.valid = result.ok;
        if (!result.ok) {
          base.error = result.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
        }
      } catch (err) {
        base.error = err instanceof Error ? err.message : String(err);
      }
      return base;
    });
  }

  delete(name: string, scope?: WorkflowScope): boolean {
    const target = scope ?? this.scopeOf(name);
    if (!target) return false;
    const file = path.join(this.rootsFor(target), `${assertName(name)}.yaml`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  /** Resolve a name to a file: project first (shadows), then global. */
  private resolveFile(name: string): string {
    const safe = assertName(name);
    if (this.projectRoot) {
      const projectFile = path.join(this.projectRoot, `${safe}.yaml`);
      if (fs.existsSync(projectFile)) return projectFile;
    }
    return path.join(this.root, `${safe}.yaml`);
  }
}

/** Path-safety guard: only kebab-case names may become file names. */
function assertName(name: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid workflow name: ${name}`);
  return name;
}

/** Serialize a def to YAML text (used by save-as flows and previews). */
export function toYaml(def: WorkflowDef): string {
  return stringifyYaml(def);
}

export { parseWorkflowDef };
