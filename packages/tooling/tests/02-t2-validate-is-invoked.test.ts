/**
 * T2 — the registry has an assembly-time `validate()` and a real caller.
 *
 * The design is explicit that a validation nothing calls is decoration, so
 * this gate checks both halves: the assembly path structurally cannot skip
 * validation, and the production entry point actually rejects a bad assembly
 * when exercised through the public API (no mocks, no test-only path).
 *
 * Mutation proof: delete the `validate(snapshot, granted)` call from
 * `src/assemble.ts` — the "calls validate" test goes red, and the behaviour
 * test below stops throwing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ExtensionRegistryBuilder,
  ExtensionValidationError,
  allCapabilities,
  assembleExtensions,
} from '../src/index.js';
import type { ToolContributor } from '../src/index.js';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

function tool(id: string): ToolContributor {
  return {
    id: `contrib:${id}`,
    toolId: id,
    capabilities: ['tools'],
    definition: { name: id, description: id, inputSchema: {} },
  };
}

describe('T2 — assembly-time validate() has a real caller', () => {
  it('finds the package sources to scan (guard against an empty scan)', () => {
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(0);
  });

  it('assemble.ts calls validate()', () => {
    const assemble = readFileSync(join(SRC_DIR, 'assemble.ts'), 'utf8');
    expect(assemble).toMatch(/validate\s*\(\s*snapshot\s*,\s*granted\s*\)/);
  });

  it('constructs the registry only inside registry.ts', () => {
    const constructors: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('new ExtensionRegistry(') && !file.endsWith('registry.ts')) {
        constructors.push(file);
      }
    }
    expect(constructors).toEqual([]);
  });

  it('reaches ExtensionRegistry.create only through assemble.ts', () => {
    const callers: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const source = readFileSync(file, 'utf8');
      const calls = source.match(/ExtensionRegistry\.create\(/g) ?? [];
      const allowed = file.endsWith('registry.ts') || file.endsWith('assemble.ts');
      if (calls.length > 0 && !allowed) callers.push(file);
    }
    expect(callers).toEqual([]);
  });

  it('marks the internal create() so consumers cannot skip validation', () => {
    const registry = readFileSync(join(SRC_DIR, 'registry.ts'), 'utf8');
    expect(registry).toMatch(/@internal[\s\S]{0,400}static create\(/);
  });

  it('REJECTS a bad assembly through the public API (validate is really invoked)', () => {
    const builder = new ExtensionRegistryBuilder();
    builder.toolContributor(tool('dup'));
    builder.toolContributor(tool('dup'));

    let thrown: unknown;
    try {
      assembleExtensions(builder, allCapabilities());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ExtensionValidationError);
    const issues = (thrown as ExtensionValidationError).issues;
    expect(issues.some((issue) => issue.rule === 'duplicate-id')).toBe(true);
  });

  it('accepts a valid assembly through the same public API', () => {
    const builder = new ExtensionRegistryBuilder();
    builder.toolContributor(tool('alpha'));
    const registry = assembleExtensions(builder, allCapabilities());
    expect(registry.tools).toHaveLength(1);
    expect(registry.size()).toBe(1);
  });
});
