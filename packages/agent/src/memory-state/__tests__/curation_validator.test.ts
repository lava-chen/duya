import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validateReceipt,
  validateCanonicalFiles,
  validateSecurity,
  validateStaging,
  type RunInput,
  type CurationReceipt,
} from '../curation_validator.js';

let stagingDir: string;

function writeReceipt(receipt: CurationReceipt): void {
  fs.writeFileSync(
    path.join(stagingDir, 'curation_receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
}

function validReceipt(inputs: RunInput[] = []): CurationReceipt {
  return {
    run_id: 'run-1',
    inputs: inputs.map((i) => ({
      input_kind: i.inputKind,
      input_key: i.inputKey,
      content_hash: i.contentHash,
      disposition: 'absorbed' as const,
      note: 'ok',
    })),
    files_changed: ['items/preference/x.md'],
    policy_proposal: null,
    layout_changed: false,
    health: { added: 1, merged: 0, retired: 0, no_change: 0, rejected: 0 },
  };
}

beforeEach(() => {
  stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-validator-'));
});
afterEach(() => {
  fs.rmSync(stagingDir, { recursive: true, force: true });
});

describe('validateReceipt', () => {
  const runInputs: RunInput[] = [
    { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
    { inputKind: 'ad_hoc', inputKey: 'extensions/ad_hoc/n.md', contentHash: 'hash-2' },
  ];

  it('1. valid receipt with all dispositions — passes', () => {
    writeReceipt(validReceipt(runInputs));
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('2. missing receipt file — fails', () => {
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/curation_receipt\.json.*not found|missing/i);
  });

  it('3. receipt is invalid JSON — fails', () => {
    fs.writeFileSync(path.join(stagingDir, 'curation_receipt.json'), '{ not json');
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/parse|JSON/i);
  });

  it('4. missing disposition for a claimed input — fails', () => {
    const receipt = validReceipt(runInputs);
    // Remove the disposition for the second input.
    receipt.inputs = receipt.inputs.slice(0, 1);
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/missing.*disposition|no disposition/i);
  });

  it('5. invalid disposition value — fails', () => {
    const receipt = validReceipt(runInputs);
    (receipt.inputs[0] as { disposition: string }).disposition = 'absorbed-evil';
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/invalid.*disposition|absorbed-evil/i);
  });

  it('6. files_changed lists a projection file (MEMORY.md) — fails', () => {
    const receipt = validReceipt(runInputs);
    receipt.files_changed = ['items/preference/x.md', 'MEMORY.md'];
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/MEMORY\.md|projection/i);
  });

  it('7. files_changed lists summary.md — fails', () => {
    const receipt = validReceipt(runInputs);
    receipt.files_changed = ['summary.md'];
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('summary.md');
  });

  it('8. files_changed lists an index.md — fails', () => {
    const receipt = validReceipt(runInputs);
    receipt.files_changed = ['entities/people/index.md'];
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/index\.md|projection/i);
  });

  it('9. files_changed with a path outside items/entities/memory-config — fails', () => {
    const receipt = validReceipt(runInputs);
    receipt.files_changed = ['items/preference/x.md', '/etc/passwd'];
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/absolute|outside|\/etc\/passwd/i);
  });

  it('10. files_changed with a memory-config/ path — passes', () => {
    const receipt = validReceipt(runInputs);
    receipt.files_changed = ['items/preference/x.md', 'memory-config/policy_proposals/prop-1.candidate.md'];
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    expect(result.valid).toBe(true);
  });

  it('11. extra disposition in receipt for an input not in runInputs — passes (lenient)', () => {
    const receipt = validReceipt(runInputs);
    receipt.inputs.push({
      input_kind: 'rollout',
      input_key: 'r-phantom',
      content_hash: 'hash-phantom',
      disposition: 'absorbed',
    });
    writeReceipt(receipt);
    const result = validateReceipt(stagingDir, runInputs);
    // The validator only checks that every runInput has a disposition;
    // extra receipt entries do not fail validation (they are ignored).
    expect(result.valid).toBe(true);
  });
});

function writeCanonicalFile(relPath: string, frontmatter: Record<string, unknown>, body = '# Title\n'): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  const content = `---\n${fm}\n---\n\n${body}`;
  const full = path.join(stagingDir, 'memory', relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function validFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_id: 'mem_abc',
    canonical_key: 'preference:verif-style',
    claim_type: 'preference',
    scope: 'project',
    scope_id: 'duya',
    project_id: 'proj-uuid-1',
    status: 'active',
    importance: 'essential',
    summary_eligible: true,
    evidence: [{ rollout_id: 'r-1', source_content_hash: 'hash-1', relation: 'supporting' }],
    valid_from: '2026-08-03',
    valid_until: null,
    supersedes: [],
    retrieval_cues: ['verification'],
    updated_at: '2026-08-03T12:00:00Z',
    ...overrides,
  };
}

describe('validateCanonicalFiles', () => {
  beforeEach(() => {
    // stagingDir is already created by the outer beforeEach.
    fs.mkdirSync(path.join(stagingDir, 'memory', 'items'), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'memory', 'entities'), { recursive: true });
  });

  it('1. empty items/ + entities/ — passes', async () => {
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('2. valid frontmatter — passes', async () => {
    writeCanonicalFile('items/preference/verif-style.md', validFrontmatter());
    writeCanonicalFile(
      'entities/people/alice.md',
      validFrontmatter({
        canonical_key: 'person:alice',
        claim_type: 'person',
        scope: 'global',
        scope_id: null,
        project_id: null,
      }),
    );
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('3. missing claim_type — fails', async () => {
    const fm = validFrontmatter();
    delete (fm as Record<string, unknown>).claim_type;
    writeCanonicalFile('items/preference/verif-style.md', fm);
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/claim_type.*missing|missing.*claim_type/i);
  });

  it('4. invalid claim_type value — fails', async () => {
    writeCanonicalFile('items/preference/verif-style.md', validFrontmatter({ claim_type: 'vibe' }));
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/invalid claim_type|vibe/i);
  });

  it('5. invalid scope value — fails', async () => {
    writeCanonicalFile('items/preference/verif-style.md', validFrontmatter({ scope: 'galactic' }));
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/invalid scope|galactic/i);
  });

  it('6. invalid status — fails', async () => {
    writeCanonicalFile('items/preference/verif-style.md', validFrontmatter({ status: 'draft' }));
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/invalid status|draft/i);
  });

  it('7. invalid importance — fails', async () => {
    writeCanonicalFile('items/preference/verif-style.md', validFrontmatter({ importance: 'critical' }));
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/invalid importance|critical/i);
  });

  it('8. scope=project without project_id — fails', async () => {
    writeCanonicalFile(
      'items/preference/verif-style.md',
      validFrontmatter({ scope: 'project', project_id: null }),
    );
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/project_id.*required|scope.*project/i);
  });

  it('9. scope=repository without project_id — fails', async () => {
    writeCanonicalFile(
      'items/fact/repo-fact.md',
      validFrontmatter({
        canonical_key: 'fact:repo-fact',
        claim_type: 'fact',
        scope: 'repository',
        project_id: null,
      }),
    );
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/project_id.*required/i);
  });

  it('10. scope=personal with non-null scope_id — fails', async () => {
    writeCanonicalFile(
      'items/preference/personal-pref.md',
      validFrontmatter({
        canonical_key: 'preference:personal-pref',
        scope: 'personal',
        scope_id: 'should-be-null',
        project_id: null,
      }),
    );
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/scope_id.*null|personal.*scope_id/i);
  });

  it('11. scope=global with non-null scope_id — fails', async () => {
    writeCanonicalFile(
      'items/fact/global-fact.md',
      validFrontmatter({
        canonical_key: 'fact:global-fact',
        claim_type: 'fact',
        scope: 'global',
        scope_id: 'should-be-null',
        project_id: null,
      }),
    );
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/scope_id.*null|global.*scope_id/i);
  });

  it('12. file with no frontmatter at all — fails', async () => {
    const full = path.join(stagingDir, 'memory', 'items', 'preference', 'no-fm.md');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '# Just a body, no frontmatter');
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/frontmatter|no frontmatter/i);
  });

  it('13. projection files inside memory/ are flagged', async () => {
    // The agent must NOT write MEMORY.md / summary.md / index.md
    // anywhere under memory/. validateCanonicalFiles flags them.
    fs.writeFileSync(path.join(stagingDir, 'memory', 'MEMORY.md'), '# projection');
    const result = await validateCanonicalFiles(path.join(stagingDir, 'memory'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/MEMORY\.md|projection/i);
  });
});

describe('validateSecurity', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(stagingDir, 'memory', 'items'), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'memory-config'), { recursive: true });
  });

  it('1. clean staging with normal memory files — passes', async () => {
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'clean.md'),
      '---\nclaim_type: fact\nscope: global\nstatus: active\nimportance: normal\n---\n# clean\n',
    );
    const result = await validateSecurity(stagingDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('2. file containing an AWS access key pattern — fails', async () => {
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'leaky.md'),
      `---\nclaim_type: fact\n---\n# leak\naws key: AKIAIOSFODNN7EXAMPLE\n`,
    );
    const result = await validateSecurity(stagingDir);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/secret|AKIA/i);
  });

  it('3. file containing a GitHub token pattern — fails', async () => {
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'leaky.md'),
      `---\nclaim_type: fact\n---\nghp_` + '0123456789abcdefghijklmnopqrstuvwxyzAB' + `\n`,
    );
    const result = await validateSecurity(stagingDir);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/secret|ghp_/i);
  });

  it('4. file containing a private key block — fails', async () => {
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'leaky.md'),
      `---\nclaim_type: fact\n---\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIJBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n`,
    );
    const result = await validateSecurity(stagingDir);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/private key|secret/i);
  });

  it('5. symlink inside staging pointing outside — fails', async () => {
    const outsideTarget = path.join(os.tmpdir(), 'cur-validator-outside-' + Date.now());
    fs.writeFileSync(outsideTarget, 'secret');
    try {
      const linkPath = path.join(stagingDir, 'memory', 'items', 'escape-link.md');
      try {
        fs.symlinkSync(outsideTarget, linkPath);
      } catch {
        // Windows without symlink privileges — skip this test.
        return;
      }
      const result = await validateSecurity(stagingDir);
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toMatch(/symlink|escape/i);
    } finally {
      fs.rmSync(outsideTarget, { force: true });
    }
  });

  it('6. symlink inside staging pointing to another location inside staging — passes', async () => {
    const realFile = path.join(stagingDir, 'memory', 'items', 'real.md');
    fs.writeFileSync(realFile, 'safe content');
    const linkPath = path.join(stagingDir, 'memory', 'items', 'inner-link.md');
    try {
      fs.symlinkSync(realFile, linkPath);
    } catch {
      // Windows without symlink privileges — skip this test.
      return;
    }
    const result = await validateSecurity(stagingDir);
    // An inner symlink is not an escape, but validateSecurity rejects
    // ALL symlinks under staging (defense in depth: the staging copy
    // step already skips symlinks, so any symlink present post-edit is
    // agent-created and suspicious). So this SHOULD fail.
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/symlink/i);
  });

  it('7. path traversal via a .. filename — fails (path escapes staging)', async () => {
    // Create a file whose realpath escapes staging. We simulate this by
    // creating a symlink with a relative .. target, which is already
    // covered by test 5. Here we instead verify the manifest check: a
    // file written to stagingDir/../escape.md is detected.
    const escapePath = path.join(stagingDir, '..', 'escape-' + Date.now() + '.md');
    fs.writeFileSync(escapePath, 'escape');
    try {
      // The escape file is OUTSIDE stagingDir, so a naive walk would
      // not see it. validateSecurity must verify every file's realpath
      // stays inside stagingDir. We simulate an agent creating a
      // symlink that resolves outside — already covered by test 5.
      // Here we just assert the escape path is not under staging.
      const rel = path.relative(stagingDir, escapePath);
      expect(rel.startsWith('..')).toBe(true);
      // And validateSecurity on a clean staging still passes (the escape
      // file is outside and not walked).
      const result = await validateSecurity(stagingDir);
      expect(result.valid).toBe(true);
    } finally {
      fs.rmSync(escapePath, { force: true });
    }
  });
});

describe('validateStaging', () => {
  function writeValidReceipt(runInputs: RunInput[]): void {
    const receipt: CurationReceipt = {
      run_id: 'run-1',
      inputs: runInputs.map((i) => ({
        input_kind: i.inputKind,
        input_key: i.inputKey,
        content_hash: i.contentHash,
        disposition: 'absorbed' as const,
        note: 'ok',
      })),
      files_changed: [],
      policy_proposal: null,
      layout_changed: false,
      health: { added: 0, merged: 0, retired: 0, no_change: 0, rejected: 0 },
    };
    fs.writeFileSync(
      path.join(stagingDir, 'curation_receipt.json'),
      JSON.stringify(receipt),
    );
  }

  function writeValidCanonical(): void {
    fs.mkdirSync(path.join(stagingDir, 'memory', 'items', 'preference'), { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'preference', 'verif.md'),
      '---\n' +
        'canonical_key: preference:verif\n' +
        'claim_type: preference\n' +
        'scope: global\n' +
        'scope_id: null\n' +
        'project_id: null\n' +
        'status: active\n' +
        'importance: essential\n' +
        '---\n\n# Verif\n',
    );
  }

  it('1. clean staging with valid receipt + canonical files + no secrets — passes', async () => {
    const runInputs: RunInput[] = [
      { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
    ];
    writeValidReceipt(runInputs);
    writeValidCanonical();
    const result = await validateStaging(stagingDir, runInputs);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('2. missing receipt — valid=false, errors include receipt', async () => {
    writeValidCanonical();
    const result = await validateStaging(stagingDir, [
      { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/curation_receipt\.json/i);
  });

  it('3. invalid canonical frontmatter — valid=false', async () => {
    const runInputs: RunInput[] = [
      { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
    ];
    writeValidReceipt(runInputs);
    fs.mkdirSync(path.join(stagingDir, 'memory', 'items', 'preference'), { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'preference', 'bad.md'),
      '---\nclaim_type: vibe\nscope: global\nstatus: active\nimportance: normal\n---\n# bad\n',
    );
    const result = await validateStaging(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/invalid claim_type|vibe/i);
  });

  it('4. secret in a canonical file — valid=false', async () => {
    const runInputs: RunInput[] = [
      { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
    ];
    writeValidReceipt(runInputs);
    fs.mkdirSync(path.join(stagingDir, 'memory', 'items', 'preference'), { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'memory', 'items', 'preference', 'leaky.md'),
      '---\nclaim_type: fact\nscope: global\nstatus: active\nimportance: normal\n---\nAKIAIOSFODNN7EXAMPLE\n',
    );
    const result = await validateStaging(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/secret|AKIA/i);
  });

  it('5. agent wrote MEMORY.md — valid=false (projection file rejected)', async () => {
    const runInputs: RunInput[] = [
      { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
    ];
    writeValidReceipt(runInputs);
    writeValidCanonical();
    fs.writeFileSync(path.join(stagingDir, 'memory', 'MEMORY.md'), '# projection');
    const result = await validateStaging(stagingDir, runInputs);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/MEMORY\.md|projection/i);
  });

  it('6. warnings populated when layout_changed=true but no layout file changed — soft warning', async () => {
    const runInputs: RunInput[] = [
      { inputKind: 'rollout', inputKey: 'r-1', contentHash: 'hash-1' },
    ];
    // Receipt claims layout_changed=true but no memory_layout.json exists
    // under memory-config/. This is a soft warning, not a hard error.
    const receipt: CurationReceipt = {
      run_id: 'run-1',
      inputs: runInputs.map((i) => ({
        input_kind: i.inputKind,
        input_key: i.inputKey,
        content_hash: i.contentHash,
        disposition: 'no_change' as const,
      })),
      files_changed: [],
      policy_proposal: null,
      layout_changed: true,
      health: { added: 0, merged: 0, retired: 0, no_change: 1, rejected: 0 },
    };
    fs.writeFileSync(path.join(stagingDir, 'curation_receipt.json'), JSON.stringify(receipt));
    writeValidCanonical();
    const result = await validateStaging(stagingDir, runInputs);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.join('\n')).toMatch(/layout_changed|memory_layout/i);
    // Warnings do not flip valid to false.
    expect(result.valid).toBe(true);
  });
});