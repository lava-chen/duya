/**
 * dwf-store.test.ts — dwf saved-workflow 契约/编解码/存储层的门禁测试：
 * frontmatter 往返（逐字节保真）、四种 parse 失败各有其名、坏文件不炸列表、
 * 原子保存与删除、名字即路径穿越防线，以及 plan 583 (c) 的核心不变量：
 * **项目档不是定义来源**（克隆来的 `.duya/workflows/*.dwf.ts` 解析不到、列不出，
 * 往里写/删会响亮报错）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  SAVED_WORKFLOW_SENTINEL,
  isValidSavedWorkflowName,
  parseSavedWorkflow,
  serializeSavedWorkflow,
  SavedWorkflowStore,
  savedWorkflowRoots,
  savedWorkflowShadowing,
  savedWorkflowDraftsDir,
  type SavedWorkflowMeta,
} from '../dwf/index.js';

// ─── fixtures ───

const META: SavedWorkflowMeta = {
  description: 'Review a pull request end to end.',
  whenToUse: 'When the user asks to review a PR.',
  args: {
    pr: { type: 'string', required: true, description: 'PR number or URL' },
    depth: { type: 'number', default: 2 },
  },
};

const SCRIPT = `export default async function (wf) {
  const diff = await wf.tool("Bash", { cmd: "git diff" });
  return diff;
}`;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-dwf-'));
}

function projectWorkflow(cwd: string, name: string, meta: SavedWorkflowMeta, script: string): string {
  const dir = path.join(cwd, '.duya', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}${SAVED_WORKFLOW_FILE_EXTENSION}`);
  fs.writeFileSync(file, serializeSavedWorkflow(meta, script), 'utf8');
  return file;
}

// ─── contracts ───

describe('dwf contracts', () => {
  it('extension is .dwf.ts so scanning never opens the file', () => {
    expect(SAVED_WORKFLOW_FILE_EXTENSION).toBe('.dwf.ts');
  });

  it('kebab-case name pattern doubles as the path-traversal guard', () => {
    expect(isValidSavedWorkflowName('morning-digest')).toBe(true);
    expect(isValidSavedWorkflowName('a')).toBe(true);
    expect(isValidSavedWorkflowName('')).toBe(false);
    expect(isValidSavedWorkflowName('Morning')).toBe(false);
    expect(isValidSavedWorkflowName('../etc/passwd')).toBe(false);
    expect(isValidSavedWorkflowName('has space')).toBe(false);
    expect(isValidSavedWorkflowName('x'.repeat(65))).toBe(false);
  });

  it('the global root is the ONLY root — project scope is not a definition source', () => {
    // plan 583 (c): `.duya/workflows/` travels with a cloned repository, so it
    // is not a lookup root. This assertion is the guard — put the project root
    // back and it goes red.
    const roots = savedWorkflowRoots('/repo', { homeDir: '/home/u' });
    expect(roots.map((r) => r.scope)).toEqual(['global']);
    expect(roots[0]!.dir).toBe(path.join('/home/u', '.duya', 'workflows'));
    // cwd must not leak into resolution any more: same answer for any repo.
    expect(savedWorkflowRoots('/some/cloned/repo', { homeDir: '/home/u' })).toEqual(roots);
  });

  it('drafts dir is a sibling of the saved dir', () => {
    expect(savedWorkflowDraftsDir('/repo')).toBe(path.join('/repo', '.duya', 'workflow-drafts'));
  });
});

// ─── frontmatter ───

describe('dwf frontmatter codec', () => {
  it('serialize → parse is byte-faithful for meta and script', () => {
    const source = serializeSavedWorkflow(META, SCRIPT);
    const parsed = parseSavedWorkflow(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta).toEqual(META);
    expect(parsed.script).toBe(SCRIPT);
  });

  it('serialize is deterministic (same input, byte-identical output)', () => {
    expect(serializeSavedWorkflow(META, SCRIPT)).toBe(serializeSavedWorkflow(META, SCRIPT));
  });

  it('the file is still valid TypeScript shape-wise: sentinel is a block comment', () => {
    const source = serializeSavedWorkflow(META, SCRIPT);
    expect(source.startsWith(`${SAVED_WORKFLOW_SENTINEL}\n`)).toBe(true);
    expect(source).toContain('*/\nexport default');
  });

  it('script is preserved byte-for-byte including trailing whitespace', () => {
    const script = 'const x = 1;   \n\n';
    const parsed = parseSavedWorkflow(serializeSavedWorkflow(META, script));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.script).toBe(script);
  });

  it('bodyLineOffset maps body lines back to file lines', () => {
    const parsed = parseSavedWorkflow(serializeSavedWorkflow(META, SCRIPT));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 第一行脚本在文件里的行号 = bodyLineOffset。
    const source = serializeSavedWorkflow(META, SCRIPT);
    const firstScriptLine = source.split('\n')[parsed.bodyLineOffset];
    expect(firstScriptLine).toBe(SCRIPT.split('\n')[0]);
  });

  it('missing frontmatter fails with its own reason', () => {
    const parsed = parseSavedWorkflow('export default 1;\n');
    expect(parsed).toMatchObject({ ok: false, reason: 'missing_frontmatter' });
  });

  it('unterminated frontmatter fails with its own reason', () => {
    const parsed = parseSavedWorkflow(`${SAVED_WORKFLOW_SENTINEL}\ndescription: x\n`);
    expect(parsed).toMatchObject({ ok: false, reason: 'unterminated_frontmatter' });
  });

  it('invalid yaml fails with its own reason', () => {
    const body = `${SAVED_WORKFLOW_SENTINEL}\ndescription: [unclosed\n*/\nconst x = 1;\n`;
    const parsed = parseSavedWorkflow(body);
    expect(parsed).toMatchObject({ ok: false, reason: 'invalid_yaml' });
  });

  it('schema violations fail with invalid_metadata naming the field', () => {
    const body = `${SAVED_WORKFLOW_SENTINEL}\ndescription: x\ntypo_field: 1\n*/\n`;
    const parsed = parseSavedWorkflow(body);
    expect(parsed).toMatchObject({ ok: false, reason: 'invalid_metadata' });
    if (parsed.ok) return;
    expect(parsed.detail).toContain('typo_field');
  });

  it('meta without optional fields is valid', () => {
    const parsed = parseSavedWorkflow(serializeSavedWorkflow({ description: 'only' }, ''));
    expect(parsed.ok).toBe(true);
  });
});

// ─── store ───

describe('SavedWorkflowStore', () => {
  it('a .dwf.ts in the session project dir is NOT resolvable (plan 583 (c))', () => {
    // 这是 (c) 的安全断言本身：一个 `git clone` 进来的 `.duya/workflows/*.dwf.ts`
    // 绝不能因为会话 cwd 落在那个仓库里就变成可解析、可执行的定义。
    // 把 project 档加回查找根，这条立刻红。
    const cwd = tmpRoot();
    const home = tmpRoot();
    try {
      const store = new SavedWorkflowStore();
      const planted = projectWorkflow(cwd, 'from-clone', { description: 'shipped by a repo' }, 'const p = 1;');
      expect(fs.existsSync(planted)).toBe(true); // 文件确实在磁盘上

      // 名字解析不到，且 list 也看不到它。
      expect(store.resolve(cwd, 'from-clone', { homeDir: home })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(store.list(cwd, { homeDir: home }).entries).toEqual([]);

      // 同名定义放进全局档就能解析 —— 区别只在档位，不在名字。
      store.save(cwd, 'from-clone', { description: 'user approved it' }, 'const g = 1;', 'global', { homeDir: home });
      const hit = store.resolve(cwd, 'from-clone', { homeDir: home });
      expect(hit.ok).toBe(true);
      if (!hit.ok) return;
      expect(hit.scope).toBe('global');
      expect(hit.meta.description).toBe('user approved it');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolve failure four states match the contract', () => {
    const cwd = tmpRoot();
    try {
      const store = new SavedWorkflowStore();
      expect(store.resolve(cwd, '../evil', { homeDir: cwd })).toMatchObject({ ok: false, reason: 'invalid_name' });
      expect(store.resolve(cwd, 'no-such-wf', { homeDir: cwd })).toMatchObject({ ok: false, reason: 'not_found' });
      // 坏 frontmatter → parse_error，带文件路径。
      const dir = path.join(cwd, '.duya', 'workflows');
      fs.mkdirSync(dir, { recursive: true });
      const bad = path.join(dir, `broken${SAVED_WORKFLOW_FILE_EXTENSION}`);
      fs.writeFileSync(bad, 'not a workflow\n', 'utf8');
      const hit = store.resolve(cwd, 'broken', { homeDir: cwd });
      expect(hit).toMatchObject({ ok: false, reason: 'parse_error', path: bad });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('list never fails on one bad file — it names it in invalid', () => {
    const cwd = tmpRoot();
    const home = tmpRoot();
    try {
      const store = new SavedWorkflowStore();
      const dir = path.join(home, '.duya', 'workflows');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `good-wf${SAVED_WORKFLOW_FILE_EXTENSION}`), serializeSavedWorkflow({ description: 'fine' }, 'const a = 1;'), 'utf8');
      fs.writeFileSync(path.join(dir, 'bad-wf.dwf.ts'), 'garbage\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'Not-kebab.dwf.ts'), 'x\n', 'utf8');

      const result = store.list(cwd, { homeDir: home });
      expect(result.entries.map((e) => e.name)).toEqual(['good-wf']);
      expect(result.invalid).toHaveLength(2);
      // dirs 只回全局档那一个（即使目录不存在也回，GUI 的 watch 靠它）。
      expect(result.dirs).toEqual([path.join(home, '.duya', 'workflows')]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('save round-trips through resolve; shadowing is reported', () => {
    const cwd = tmpRoot();
    const home = tmpRoot();
    try {
      const store = new SavedWorkflowStore();
      const saved = store.save(cwd, 'deploy-check', { description: 'Check deploy health.' }, 'const s = 1;', 'global', { homeDir: home });
      expect(saved.path).toBe(path.join(home, '.duya', 'workflows', `deploy-check${SAVED_WORKFLOW_FILE_EXTENSION}`));
      expect(saved.shadowing).toBeNull();

      const hit = store.resolve(cwd, 'deploy-check', { homeDir: home });
      expect(hit.ok).toBe(true);
      if (!hit.ok) return;
      expect(hit.scope).toBe('global');
      expect(hit.meta.description).toBe('Check deploy health.');
      expect(hit.source).toBe(fs.readFileSync(saved.path, 'utf8'));

      // 单一档之后没有遮蔽可言：shadowing 恒为 null（协议面保留，恒 null 是明账）。
      const again = store.save(cwd, 'deploy-check', { description: 'v2' }, 'const s2 = 1;', 'global', { homeDir: home });
      expect(again.shadowing).toBeNull();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('save rejects invalid names instead of writing outside the root', () => {
    const cwd = tmpRoot();
    try {
      const store = new SavedWorkflowStore();
      expect(() => store.save(cwd, '../evil', { description: 'x' }, '', 'global', { homeDir: cwd })).toThrow(/invalid workflow name/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('save and delete into project scope throw instead of writing to a dead directory', () => {
    // 写进没人读的目录是最坏的一种失败：用户以为存下了，下次运行却是 not_found。
    // 所以这里必须**响亮地**失败（fail-loud），不能静默重定向。
    const cwd = tmpRoot();
    const home = tmpRoot();
    try {
      const store = new SavedWorkflowStore();
      expect(() => store.save(cwd, 'x', { description: 'x' }, 'const a = 1;', 'project', { homeDir: home })).toThrow(
        /not a definition source/,
      );
      expect(() => store.delete(cwd, 'x', 'project', { homeDir: home })).toThrow(/not a definition source/);
      // 拒绝时不得留下任何文件。
      expect(fs.existsSync(path.join(cwd, '.duya', 'workflows'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('delete removes the entry and then reports it gone', () => {
    const cwd = tmpRoot();
    const home = tmpRoot();
    try {
      const store = new SavedWorkflowStore();
      store.save(cwd, 'gone-soon', { description: 'g' }, '', 'global', { homeDir: home });

      expect(store.delete(cwd, 'gone-soon', 'global', { homeDir: home })).toBe(true);
      expect(store.resolve(cwd, 'gone-soon', { homeDir: home })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(store.delete(cwd, 'gone-soon', 'global', { homeDir: home })).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('shadowing helper reports null in the single-scope world', () => {
    const cwd = tmpRoot();
    try {
      expect(savedWorkflowShadowing(cwd, 'project', 'lonely-wf', { homeDir: cwd })).toBeNull();
      expect(savedWorkflowShadowing(cwd, 'global', 'lonely-wf', { homeDir: cwd })).toBeNull();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
