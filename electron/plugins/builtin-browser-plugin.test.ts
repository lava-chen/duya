// electron/plugins/builtin-browser-plugin.test.ts
// Plan 583 Phase 3 (seam B) — the `browser` builtin plugin.
//
// Unlike catalog-builtin.test.ts, which builds throwaway fixtures, this test
// reads the REAL on-disk plugin. The point is that the shipped artifact stays
// valid: a malformed plugin.json, a policy.json field that is not the name the
// reader looks for, or a skill frontmatter that the loader would reject all
// fail here rather than at install time on a user's machine.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BROWSER_TOOL_NAME, getAllActions } from '@duya/browser';
import { readPluginManifest } from './manifest.js';
import { discoverSkills } from '../../packages/plugin-core/src/plugins/loader/capability-discovery.js';

const BUILTIN_ROOT = path.resolve(
  __dirname,
  '../../packages/plugin-core/src/plugins/builtin',
);
const BROWSER_DIR = path.join(BUILTIN_ROOT, 'browser');

/**
 * snake_case backticked tokens that are NOT browser operations.
 * Keep this list tiny — every entry is a real tool or parameter name that
 * happens to look like an operation.
 */
const NON_OPERATION_IDENTIFIERS = new Set([
  'tool_catalog', // real tool name (TOOL_CATALOG_NAME)
  'tool_id', // tool_catalog parameter
  'usage_guide', // field on a tool_catalog detail response
]);

function readSkill(name: string): string {
  return fs.readFileSync(path.join(BROWSER_DIR, 'skills', name, 'SKILL.md'), 'utf8');
}

function frontmatter(md: string): Record<string, string> {
  const block = md.split('---')[1];
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^(name|description|allowed-tools):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const SKILL_NAMES = ['browser-automation', 'browser-research'] as const;

describe('browser builtin plugin — manifest', () => {
  const manifest = readPluginManifest(BROWSER_DIR);

  it('parses identity and the automation category', () => {
    expect(manifest.name).toBe('browser');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.interface?.displayName).toBe('Browser');
    // Must stay inside the PluginCategory union in src/lib/plugin-types.ts.
    expect(manifest.interface?.category).toBe('automation');
  });

  it('reads the permission tier defaults from permissions/policy.json', () => {
    // These three are the only fields the reader actually honours. Asserted
    // by value (not just presence) so a typo in the key name — which the
    // reader silently drops to `undefined` — shows up as a failure here.
    expect(manifest.permissionPolicy).toEqual({
      defaultMode: 'read',
      writeActionsRequireApproval: true,
      destructiveActionsRequireApproval: true,
    });
  });

  it('declares no capability permission requests', () => {
    // Navigation blocking is driven by the settings-backed DomainBlocker, not
    // by a static `domains` list here, so the plugin declares none.
    expect(manifest.permissions).toEqual([]);
  });
});

describe('browser builtin plugin — skills', () => {
  it('discovers exactly the two scenario skills', () => {
    const skills = discoverSkills(BROWSER_DIR).map((s) => s.name).sort();
    expect(skills).toEqual([...SKILL_NAMES].sort());
  });

  it.each(SKILL_NAMES)('%s frontmatter fits the skill loader limits', (name) => {
    const fm = frontmatter(readSkill(name));
    // Mirrors the hard caps in packages/agent/src/skills/loader.ts.
    expect(fm.name).toBe(name);
    expect(fm.name.length).toBeLessThanOrEqual(64);
    expect(fm.description.length).toBeGreaterThan(0);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    expect(fm['allowed-tools'].split(',').map((t) => t.trim())).toContain(
      BROWSER_TOOL_NAME,
    );
  });
});

describe('browser builtin plugin — skills only cite real operations', () => {
  const real = new Set(getAllActions().map((a) => a.operation));

  /**
   * SKILL.md files are model-facing prose, so an operation name can rot
   * silently: nothing type-checks it, and the model only discovers the typo
   * when the call fails mid-task. These two assertions catch both the
   * call-shaped and the prose-shaped references against the engine's real
   * operation list.
   */
  it.each(SKILL_NAMES)('%s cites only operations the engine implements', (name) => {
    const md = readSkill(name);

    const fromJson = [...md.matchAll(/"operation"\s*:\s*"([a-z0-9_]+)"/g)].map(
      (m) => m[1],
    );
    expect(fromJson.length).toBeGreaterThan(0);
    for (const op of fromJson) {
      expect(real, `"${op}" in ${name}`).toContain(op);
    }

    const fromProse = [...md.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]*)`/g)]
      .map((m) => m[1])
      .filter((token) => !NON_OPERATION_IDENTIFIERS.has(token));
    for (const token of fromProse) {
      expect(real, `\`${token}\` in ${name}`).toContain(token);
    }
  });

  it('still describes the two deliberately schema-hidden publish operations', () => {
    // browser-automation tells the model that `post` / `twitter_post` exist
    // even though they are absent from the operation enum. That claim is only
    // true while the engine keeps them registered-but-hidden.
    const hidden = new Set(
      getAllActions()
        .filter((a) => a.hidden)
        .map((a) => a.operation),
    );
    expect([...hidden].sort()).toEqual(['post', 'twitter_post']);

    const md = readSkill('browser-automation');
    for (const op of hidden) {
      expect(md, `${op} documented in browser-automation`).toContain(op);
    }
  });
});
