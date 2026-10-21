import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parsePolicy,
  serializePolicy,
  isAnchoredPolicy,
  migrateLegacyPolicy,
  normalizePolicy,
  applyPolicyEdits,
  readPolicyForPrompt,
  MAX_POLICY_BYTES,
  POLICY_SECTION_DEFS,
  type PolicyDocument,
} from '../stage1_policy_editor';

function makeEnv(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-editor-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ANCHORED = `# Stage 1 政策

> 固定骨架说明。

### S1: PROJECT & ENVIRONMENT TOPOLOGY

- [r:paths-verbatim] 路径按原文保留
- [r:toolchain] 工具链原样记录

### S9: GENERAL EXTRACTION RULES

- [r:absolute-dates] 保留绝对日期
`;

const LEGACY = `## Stage 1 政策

### 维度 1: PROJECT & ENVIRONMENT TOPOLOGY
- 必捕信号: 项目根路径
- 工具链 (cargo)

### 维度 9 不存在: 会被丢进 S9
- 任意规则

### 抽取硬规则补充
- 保留 absolute 日期
一段非 bullet 的说明文字。

### 维度 2: ACTIVE FOCUS
- 用户提问本身隐含目标
`;

describe('parsePolicy / serializePolicy', () => {
  it('round-trips an anchored document losslessly', () => {
    const doc = parsePolicy(ANCHORED);
    expect(doc).not.toBeNull();
    expect(serializePolicy(doc!)).toBe(ANCHORED);
  });

  it('extracts preamble, sections, notes and rules', () => {
    const doc = parsePolicy(ANCHORED)!;
    expect(doc.preamble).toContain('固定骨架说明');
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0].id).toBe('S1');
    expect(doc.sections[0].rules.map((r) => r.id)).toEqual(['paths-verbatim', 'toolchain']);
    expect(doc.sections[1].id).toBe('S9');
  });

  it('keeps non-bullet lines as section notes', () => {
    const content = `### S3: COMMUNICATION & INTERACTION STYLE\n\n一段说明。\n\n- [r:explicit] 明确时才记\n`;
    const doc = parsePolicy(content)!;
    expect(doc.sections[0].notes).toEqual(['一段说明。']);
    expect(doc.sections[0].rules).toHaveLength(1);
  });

  it('omits empty sections on serialize', () => {
    const doc: PolicyDocument = {
      preamble: '# p',
      sections: [{ id: 'S1', title: 'X', notes: [], rules: [] }],
    };
    expect(serializePolicy(doc)).toBe('# p\n');
  });

  it('returns null for non-anchored content', () => {
    expect(parsePolicy('# Focus\n\nWatch goals')).toBeNull();
    expect(parsePolicy('### 维度 1: X\n- y')).toBeNull();
  });

  it('isAnchoredPolicy distinguishes formats', () => {
    expect(isAnchoredPolicy(ANCHORED)).toBe(true);
    expect(isAnchoredPolicy(LEGACY)).toBe(false);
    expect(isAnchoredPolicy('')).toBe(false);
  });
});

describe('migrateLegacyPolicy', () => {
  it('maps 维度 N headers to S1..S8 keeping titles', () => {
    const doc = migrateLegacyPolicy(LEGACY);
    const ids = doc.sections.map((s) => s.id);
    expect(ids).toEqual(['S1', 'S9', 'S9', 'S2']);
    expect(doc.sections[0].title).toBe('PROJECT & ENVIRONMENT TOPOLOGY');
    expect(doc.sections[3].title).toBe('ACTIVE FOCUS');
  });

  it('derives stable hash ids for legacy bullets', () => {
    const doc1 = migrateLegacyPolicy(LEGACY);
    const doc2 = migrateLegacyPolicy(LEGACY);
    const r1 = doc1.sections[0].rules[0];
    const r2 = doc2.sections[0].rules[0];
    expect(r1.id).toBe(r2.id);
    expect(r1.id).toMatch(/^r-[a-f0-9]{10}$/);
    expect(r1.text).toBe('必捕信号: 项目根路径');
  });

  it('preserves non-bullet lines as notes and preamble', () => {
    const doc = migrateLegacyPolicy(LEGACY);
    expect(doc.preamble).toContain('## Stage 1 政策');
    const s9 = doc.sections.find((s) => s.title === '抽取硬规则补充')!;
    expect(s9.notes).toContain('一段非 bullet 的说明文字。');
  });

  it('folds headerless content into S9', () => {
    const doc = migrateLegacyPolicy('# Focus\n\n- watch goals\n- keep dates absolute');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].id).toBe('S9');
    expect(doc.sections[0].rules).toHaveLength(2);
    expect(doc.preamble).toBe('');
  });

  it('normalizePolicy converts legacy to canonical and is idempotent', () => {
    const once = normalizePolicy(LEGACY);
    expect(isAnchoredPolicy(once)).toBe(true);
    expect(normalizePolicy(once)).toBe(once);
    expect(normalizePolicy(ANCHORED)).toBe(ANCHORED);
  });
});

describe('applyPolicyEdits', () => {
  let env: { dir: string; cleanup: () => void };
  let policyPath: string;
  beforeEach(() => {
    env = makeEnv();
    policyPath = path.join(env.dir, 'stage1_policy.md');
  });
  afterEach(() => env.cleanup());

  const versionPath = (p: string) => `${p}.version`;

  it('upserts a new rule into an existing section and bumps version', async () => {
    fs.writeFileSync(policyPath, ANCHORED, 'utf8');
    fs.writeFileSync(versionPath(policyPath), '5', 'utf8');

    const res = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S1', rule_id: 'env-constraints', text: '硬约束记录为 invariant' },
    ]);

    expect(res.changed).toBe(true);
    expect(res.version).toBe(6);
    expect(res.errors).toEqual([]);
    const content = fs.readFileSync(policyPath, 'utf8');
    expect(content).toContain('- [r:env-constraints] 硬约束记录为 invariant');
    expect(content).toContain('- [r:paths-verbatim] 路径按原文保留'); // untouched
  });

  it('upsert replaces an existing rule in place (no duplicate)', async () => {
    fs.writeFileSync(policyPath, ANCHORED, 'utf8');
    const res = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S1', rule_id: 'toolchain', text: '新工具链表述' },
    ]);
    expect(res.changed).toBe(true);
    const doc = parsePolicy(fs.readFileSync(policyPath, 'utf8'))!;
    const s1 = doc.sections.find((s) => s.id === 'S1')!;
    expect(s1.rules).toHaveLength(2);
    expect(s1.rules.find((r) => r.id === 'toolchain')!.text).toBe('新工具链表述');
  });

  it('remove_rule deletes by id', async () => {
    fs.writeFileSync(policyPath, ANCHORED, 'utf8');
    const res = await applyPolicyEdits(policyPath, [
      { op: 'remove_rule', section: 'S1', rule_id: 'toolchain' },
    ]);
    expect(res.changed).toBe(true);
    const doc = parsePolicy(fs.readFileSync(policyPath, 'utf8'))!;
    const s1 = doc.sections.find((s) => s.id === 'S1')!;
    expect(s1.rules.map((r) => r.id)).toEqual(['paths-verbatim']);
  });

  it('records errors for unknown section/rule and writes nothing', async () => {
    fs.writeFileSync(policyPath, ANCHORED, 'utf8');
    fs.writeFileSync(versionPath(policyPath), '2', 'utf8');

    const res = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S99', rule_id: 'x', text: 'bad section' },
      { op: 'remove_rule', section: 'S1', rule_id: 'missing-rule' },
      { op: 'upsert_rule', section: 'S1', rule_id: 'ok', text: 'fine' },
    ]);

    expect(res.changed).toBe(true); // the valid edit still lands
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0]).toMatch(/unknown section S99/);
    expect(res.errors[1]).toMatch(/not found/);
    expect(fs.readFileSync(policyPath, 'utf8')).toContain('- [r:ok] fine');
  });

  it('rejects empty/oversized rule text', async () => {
    fs.writeFileSync(policyPath, ANCHORED, 'utf8');
    const empty = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S1', rule_id: 'x', text: '   ' },
    ]);
    expect(empty.errors[0]).toMatch(/empty text/);

    const big = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S1', rule_id: 'big', text: 'a'.repeat(501) },
    ]);
    expect(big.errors[0]).toMatch(/exceeds 500/);
  });

  it('no-ops (no version bump) when content is unchanged', async () => {
    fs.writeFileSync(policyPath, ANCHORED, 'utf8');
    fs.writeFileSync(versionPath(policyPath), '9', 'utf8');

    const res = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S1', rule_id: 'paths-verbatim', text: '路径按原文保留' },
    ]);
    expect(res.changed).toBe(false);
    expect(res.version).toBe(9);
    expect(fs.readFileSync(versionPath(policyPath), 'utf8').trim()).toBe('9');
  });

  it('rejects a batch that exceeds MAX_POLICY_BYTES without writing', async () => {
    // Seed a file just under the cap via a large preamble, then a single
    // small edit pushes the total over MAX_POLICY_BYTES.
    const nearCap = 'x'.repeat(7800) + '\n\n' + ANCHORED;
    expect(nearCap.length).toBeLessThan(MAX_POLICY_BYTES);
    fs.writeFileSync(policyPath, nearCap, 'utf8');
    const res = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S1', rule_id: 'push-over', text: 'y'.repeat(300) },
    ]);
    expect(res.changed).toBe(false);
    expect(res.errors[0]).toMatch(/exceeds 8192 bytes/);
    expect(fs.readFileSync(policyPath, 'utf8')).toBe(nearCap);
  });

  it('migrates a legacy file on disk when edits land', async () => {
    fs.writeFileSync(policyPath, LEGACY, 'utf8');
    fs.writeFileSync(versionPath(policyPath), '4', 'utf8');

    const res = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S1', rule_id: 'new-rule', text: '新增规则' },
    ]);

    expect(res.changed).toBe(true);
    expect(res.version).toBe(5);
    const content = fs.readFileSync(policyPath, 'utf8');
    expect(isAnchoredPolicy(content)).toBe(true);
    expect(content).toContain('- [r:new-rule] 新增规则');
  });

  it('creates the file when missing', async () => {
    const res = await applyPolicyEdits(policyPath, [
      { op: 'upsert_rule', section: 'S2', rule_id: 'first', text: '第一条规则' },
    ]);
    expect(res.changed).toBe(true);
    expect(res.version).toBe(1);
    expect(fs.readFileSync(versionPath(policyPath), 'utf8').trim()).toBe('1');
    const doc = parsePolicy(fs.readFileSync(policyPath, 'utf8'))!;
    expect(doc.sections[0].id).toBe('S2');
  });
});

describe('readPolicyForPrompt', () => {
  let env: { dir: string; cleanup: () => void };
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => env.cleanup());

  it('returns null when the policy file does not exist', async () => {
    expect(await readPolicyForPrompt(path.join(env.dir, 'nope.md'))).toBeNull();
  });

  it('returns anchored content + version, normalizing legacy files', async () => {
    const policyPath = path.join(env.dir, 'stage1_policy.md');
    fs.writeFileSync(policyPath, LEGACY, 'utf8');
    fs.writeFileSync(`${policyPath}.version`, '7', 'utf8');

    const result = await readPolicyForPrompt(policyPath);
    expect(result!.version).toBe(7);
    expect(isAnchoredPolicy(result!.content)).toBe(true);
    expect(result!.content).toContain('### S1:');
  });
});

describe('POLICY_SECTION_DEFS', () => {
  it('defines exactly S1..S9 in order', () => {
    expect(POLICY_SECTION_DEFS.map((s) => s.id)).toEqual([
      'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9',
    ]);
  });
});
