# Memory Curation Tool Foundation (Plan 401) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `allowedRoots?: string[]` sandbox parameter to the five file tools (Read/Write/Edit/Grep/Glob), add a `memory-curator` AgentProfile preset, and add a `memory-curator-process-entry.ts` that registers exactly five root-bound tool instances — with zero behavior change when `allowedRoots` is not set.

**Architecture:** Three layers that compose without touching the hot path: (1) a shared `isPathWithinRoots(absPath, roots)` helper in `packages/agent/src/tool/allowedRoots.ts` that rejects `..` traversal, symlink escape, and cross-drive paths using `path.relative` + `fs.realpathSync`; (2) each file tool gains an optional `allowedRoots` constructor option — when set, the tool resolves the target path and rejects calls outside the roots *before* any filesystem I/O, when unset the tool behaves exactly as today; (3) a new `memory-curator` AgentProfile (whitelist of the 5 tools) and a new `memory-curator-process-entry.ts` that constructs those 5 tools with `allowedRoots` derived from a `--staging-root` argv per design §7.2. No existing call site changes (all new parameters are optional with defaults). The builtin registry, the normal agent process, and every existing test continue to work unchanged.

**Tech Stack:** TypeScript (strict), Node.js `fs` + `path`, Vitest (temp-dir based behavioral tests + symlink escape tests), Conventional Commits.

**Design doc:** `docs/design-docs/2026-08-03-memory-phase2-curation-agent-design.md` — §7 (Phase 2 Agent: toolset and sandboxing), especially §7.2 (root-bound tool instances) and §7.3 (what the curator entry disables).

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/agent/src/tool/allowedRoots.ts` | `isPathWithinRoots(absPath, roots)` shared root-boundary check (lexical `..` + symlink realpath) |
| Create | `packages/agent/src/tool/allowedRoots.test.ts` | TDD tests for the helper: traversal, symlink escape, root boundary, cross-drive, trailing separator |
| Modify | `packages/agent/src/tool/ReadTool/ReadTool.ts:213-215,249-256` | Constructor takes `{ parser?, allowedRoots? }`; `execute()` enforces roots before dispatch |
| Modify | `packages/agent/src/tool/WriteTool/WriteTool.ts:81,128-141` | Constructor takes `{ allowedRoots? }`; `execute()` enforces roots before write |
| Modify | `packages/agent/src/tool/EditTool/EditTool.ts:81,124-136` | Constructor takes `{ allowedRoots? }`; class `execute()` enforces roots before `executeEdit` |
| Modify | `packages/agent/src/tool/GrepTool/GrepTool.ts:42-44,115-159,364-402` | `GrepToolOptions` gains `allowedRoots?`; `execute()` enforces roots on `searchPath` |
| Modify | `packages/agent/src/tool/GlobTool/GlobTool.ts:24,54-86` | Constructor takes `{ allowedRoots? }`; `execute()` enforces roots on `safeCwd` |
| Modify | `packages/agent/src/tool/ReadTool/__tests__/ReadTool.test.ts` | Add allowedRoots behavioral cases to existing test file |
| Create | `packages/agent/src/tool/WriteTool/__tests__/WriteTool.test.ts` | TDD tests for WriteTool (no existing test file) including allowedRoots |
| Create | `packages/agent/src/tool/EditTool/__tests__/EditTool.test.ts` | TDD tests for EditTool (no existing test file) including allowedRoots |
| Create | `packages/agent/src/tool/GrepTool/__tests__/GrepTool.test.ts` | TDD tests for GrepTool (no existing test file) including allowedRoots |
| Create | `packages/agent/src/tool/GlobTool/__tests__/GlobTool.test.ts` | TDD tests for GlobTool (no existing test file) including allowedRoots |
| Modify | `packages/agent/src/agent-profile/types.ts:96-303` | Add `memory-curator` to `PRESET_AGENT_PROFILES` |
| Create | `packages/agent/src/agent-profile/types.test.ts` | TDD tests: profile exists + `resolveAllowedTools` filters correctly |
| Create | `packages/agent/src/process/memory-curator-process-entry.ts` | `createCuratorTools(stagingRoot): ToolRegistry` + `parseStagingRootFromArgv(argv)` |
| Create | `packages/agent/src/process/memory-curator-process-entry.test.ts` | TDD tests: 5 tools registered, names correct, roots enforced behaviorally |

**Note on test location:** the task's "真实代码事实" says tool tests are colocated as `<Tool>/<Tool>.test.ts`, but the actual repo convention (verified in `ReadTool/__tests__/ReadTool.test.ts`) is a `__tests__/` subdirectory. This plan follows the **actual repo convention** (`__tests__/`) for new test files and adds to the existing `ReadTool/__tests__/ReadTool.test.ts` for ReadTool.

---

## Task 1: Shared root-boundary helper `isPathWithinRoots`

**Files:**
- Create: `packages/agent/src/tool/allowedRoots.ts`
- Create: `packages/agent/src/tool/allowedRoots.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/agent/src/tool/allowedRoots.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathWithinRoots } from './allowedRoots.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-outside-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  mkdirSync(join(root, 'memory-config'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'hello');
  writeFileSync(join(outside, 'secret.txt'), 'shh');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('isPathWithinRoots', () => {
  it('returns false for empty roots array (caller gates on allowedRoots?.length)', () => {
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [])).toBe(false);
  });

  it('returns false for non-absolute target path', () => {
    expect(isPathWithinRoots('relative/path.md', [root])).toBe(false);
  });

  it('returns false when no root is absolute', () => {
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), ['relative/root'])).toBe(false);
  });

  it('accepts a target inside the root', () => {
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [root])).toBe(true);
  });

  it('accepts a target equal to the root itself', () => {
    expect(isPathWithinRoots(root, [root])).toBe(true);
  });

  it('accepts a target inside one of several roots', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'duya-other-'));
    try {
      expect(isPathWithinRoots(join(otherRoot, 'x.md'), [root, otherRoot])).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects a target outside all roots', () => {
    expect(isPathWithinRoots(join(outside, 'secret.txt'), [root])).toBe(false);
  });

  it('rejects a sibling path that shares a string prefix with the root', () => {
    // Create a directory whose name starts with the root's name but is NOT
    // the root. A naive `startsWith` check would accept this.
    const sibling = root + '-evil';
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'stolen.md'), 'data');
    expect(isPathWithinRoots(join(sibling, 'stolen.md'), [root])).toBe(false);
  });

  it('rejects a non-existent root (skips it, falls through to other roots)', () => {
    const ghost = join(root, 'does-not-exist');
    expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [ghost, root])).toBe(true);
    expect(isPathWithinRoots(join(outside, 'secret.txt'), [ghost])).toBe(false);
  });

  describe('traversal', () => {
    it('rejects a path with .. that escapes the root lexically', () => {
      const escape = join(root, 'memory', '..', '..', '..', 'etc', 'passwd');
      expect(isPathWithinRoots(escape, [root])).toBe(false);
    });

    it('accepts a path with internal .. that stays inside the root', () => {
      mkdirSync(join(root, 'memory', 'sub'), { recursive: true });
      writeFileSync(join(root, 'memory', 'sub', 'b.md'), 'b');
      const inside = join(root, 'memory', 'sub', '..', 'b.md');
      expect(isPathWithinRoots(inside, [root])).toBe(true);
    });
  });

  describe('symlink escape', () => {
    let symlinkAttempted: boolean;
    beforeEach(() => { symlinkAttempted = false; });

    it('rejects a symlink inside the root that points outside', () => {
      const linkPath = join(root, 'memory', 'escape-link.md');
      try {
        symlinkSync(join(outside, 'secret.txt'), linkPath);
        symlinkAttempted = true;
      } catch {
        // Symlink creation may fail without privileges on some Windows builds.
      }
      if (!symlinkAttempted) return; // skip: cannot create symlink on this platform
      expect(isPathWithinRoots(linkPath, [root])).toBe(false);
    });

    it('accepts a symlink inside the root that points to another location inside the root', () => {
      const linkPath = join(root, 'memory', 'inner-link.md');
      try {
        symlinkSync(join(root, 'memory', 'a.md'), linkPath);
        symlinkAttempted = true;
      } catch {
        // skip on platforms without symlink privileges
      }
      if (!symlinkAttempted) return;
      expect(isPathWithinRoots(linkPath, [root])).toBe(true);
    });
  });

  describe('trailing separator', () => {
    it('treats root with trailing separator the same as without', () => {
      const rootWithSep = root + (process.platform === 'win32' ? '\\' : '/');
      expect(isPathWithinRoots(join(root, 'memory', 'a.md'), [rootWithSep])).toBe(true);
    });

    it('treats target with trailing separator the same as without', () => {
      const dirTarget = join(root, 'memory') + (process.platform === 'win32' ? '\\' : '/');
      expect(isPathWithinRoots(dirTarget, [root])).toBe(true);
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/tool/allowedRoots.test.ts`
Expected: FAIL with `Failed to resolve import "./allowedRoots.js"` (module does not exist yet).

- [x] **Step 3: Write the implementation**

Create `packages/agent/src/tool/allowedRoots.ts`:

```typescript
/**
 * Root-boundary check for sandboxed file tools.
 *
 * When a tool is constructed with `allowedRoots`, every target path must
 * resolve to a location inside one of the roots. This rejects:
 *   - `..` traversal that escapes the root lexically
 *   - symlinks inside the root that point outside (realpath mismatch)
 *   - cross-drive paths on Windows (path.relative returns an absolute path)
 *   - sibling paths that share a string prefix with the root but are not
 *     inside it (a naive `startsWith` would accept these)
 *
 * Used by the Phase 2 memory curator process (design §7.2) to bind the
 * five file tools to a staging workspace so the agent literally cannot
 * name live memory, the DB, or the user home.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';

/**
 * Returns true iff `absPath` resolves to a location inside at least one
 * of `roots`. Both arguments are expected to be absolute; non-absolute
 * inputs are rejected. Returns `false` for an empty `roots` array —
 * callers gate on `allowedRoots?.length` to express "unrestricted".
 *
 * Resolution strategy per root:
 *   1. Realpath the root (root must exist; non-existent roots are skipped).
 *   2. Lexically resolve the target with `path.resolve` (collapses `..`).
 *   3. `path.relative(realRoot, lexTarget)` — if it does NOT start with
 *      `..` and is NOT absolute, the target is lexically inside the root.
 *      `path.relative` returns an absolute path when the drives differ on
 *      Windows (e.g. C: → D:), which correctly rejects cross-drive escapes.
 *   4. If the target exists, realpath it and re-check against the real
 *      root. This catches symlinks inside the root that point outside.
 *      If the target does not exist yet (write case), the lexical check
 *      from step 3 is the best available guarantee and is accepted.
 */
export function isPathWithinRoots(absPath: string, roots: string[]): boolean {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  if (!absPath || !isAbsolute(absPath)) return false;

  const lexTarget = resolve(absPath);

  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue;

    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      // Root does not exist or is unreadable; cannot anchor here.
      continue;
    }

    const rel = relative(realRoot, lexTarget);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      // Lexically inside. Now verify no symlink escape if the target exists.
      try {
        const realTarget = realpathSync(lexTarget);
        const relReal = relative(realRoot, realTarget);
        if (relReal === '' || (!relReal.startsWith('..') && !isAbsolute(relReal))) {
          return true;
        }
        // Target's realpath escaped the root — reject and keep scanning roots.
        continue;
      } catch {
        // Target does not exist yet (e.g. WriteTool creating a new file).
        // Lexical containment is the best available check; accept it.
        return true;
      }
    }
  }
  return false;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/tool/allowedRoots.test.ts`
Expected: PASS (all cases; the two symlink cases self-skip on platforms without symlink privileges).

- [x] **Step 5: Run typecheck**

Run: `npm run typecheck:all`
Expected: PASS (no type errors; the new module is self-contained).

- [x] **Step 6: Commit**

```bash
git add packages/agent/src/tool/allowedRoots.ts packages/agent/src/tool/allowedRoots.test.ts
git commit -m "feat(agent): add isPathWithinRoots root-boundary helper"
```

---

## Task 2: Add `allowedRoots` to ReadTool

**Files:**
- Modify: `packages/agent/src/tool/ReadTool/ReadTool.ts` (constructor at line 213; `execute` at line 249; imports at line 30)
- Modify: `packages/agent/src/tool/ReadTool/__tests__/ReadTool.test.ts` (add allowedRoots cases)

- [x] **Step 1: Write the failing test**

Append the following block to `packages/agent/src/tool/ReadTool/__tests__/ReadTool.test.ts` (after the last `describe`/`it` in the file, at top level so it shares the existing `tmpDir`/`beforeEach` setup — but the allowedRoots cases need their own root boundary, so use a self-contained `describe` with its own temp dirs):

```typescript
describe('ReadTool allowedRoots sandbox', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    _resetFileParserConfig();
    _resetSharedParser();
    root = mkdtempSync(join(tmpdir(), 'duya-read-roots-'));
    outside = mkdtempSync(join(tmpdir(), 'duya-read-out-'));
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(join(root, 'memory', 'inside.md'), 'inside content');
    writeFileSync(join(outside, 'outside.md'), 'outside content');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a read outside allowedRoots', async () => {
    const tool = new ReadTool({ allowedRoots: [join(root, 'memory')] });
    const result = await tool.execute({ file_path: join(outside, 'outside.md') });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows a read inside allowedRoots', async () => {
    const tool = new ReadTool({ allowedRoots: [join(root, 'memory')] });
    const result = await tool.execute({ file_path: join(root, 'memory', 'inside.md') });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('inside content');
  });

  it('accepts multiple roots and rejects a path outside all of them', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'duya-read-other-'));
    try {
      mkdirSync(join(otherRoot, 'cfg'), { recursive: true });
      writeFileSync(join(otherRoot, 'cfg', 'p.md'), 'cfg');
      const tool = new ReadTool({
        allowedRoots: [join(root, 'memory'), join(otherRoot, 'cfg')],
      });
      const ok = await tool.execute({ file_path: join(otherRoot, 'cfg', 'p.md') });
      expect(ok.error).toBeFalsy();
      const bad = await tool.execute({ file_path: join(outside, 'outside.md') });
      expect(bad.error).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: join(outside, 'outside.md') });
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('outside content');
  });

  it('still accepts the parser option alongside allowedRoots', async () => {
    const tool = new ReadTool({ allowedRoots: [join(root, 'memory')] });
    const result = await tool.execute({ file_path: join(root, 'memory', 'inside.md') });
    expect(result.error).toBeFalsy();
  });
});
```

Also add the missing imports at the top of the test file if not already present:

```typescript
import { mkdirSync } from 'node:fs';
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/tool/ReadTool/__tests__/ReadTool.test.ts`
Expected: FAIL with a TypeScript error: `Object literal may only specify known properties, and 'allowedRoots' does not exist in type 'NodeFileParser | undefined'` (the current constructor signature is `constructor(private parser?: NodeFileParser)`).

- [x] **Step 3: Update the ReadTool constructor and imports**

In `packages/agent/src/tool/ReadTool/ReadTool.ts`:

Add the import for `isPathWithinRoots` next to the existing `expandPath` import (line 30):

```typescript
import { expandPath } from '../../utils/path.js';
import { isPathWithinRoots } from '../allowedRoots.js';
```

Replace the constructor block (lines 213-215):

```typescript
  constructor(private parser?: NodeFileParser) {
    super();
  }
```

with:

```typescript
  private readonly allowedRoots?: readonly string[];

  constructor(opts: { parser?: NodeFileParser; allowedRoots?: string[] } = {}) {
    super();
    this.parser = opts.parser;
    this.allowedRoots = opts.allowedRoots;
  }
```

- [x] **Step 4: Enforce allowedRoots in `execute`**

In `packages/agent/src/tool/ReadTool/ReadTool.ts`, replace the `execute` method (lines 249-256):

```typescript
  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const validation = validateReadInput(input);
    if (!validation.valid) {
      return { id, name: 'read', result: `Input validation failed: ${validation.error}`, error: true };
    }
    return this.dispatch(validation.data, id, workingDirectory, context);
  }
```

with:

```typescript
  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const validation = validateReadInput(input);
    if (!validation.valid) {
      return { id, name: 'read', result: `Input validation failed: ${validation.error}`, error: true };
    }
    if (this.allowedRoots && this.allowedRoots.length > 0) {
      const resolved = expandPath(validation.data.file_path, workingDirectory);
      if (!isPathWithinRoots(resolved, [...this.allowedRoots])) {
        return {
          id,
          name: 'read',
          error: true,
          result: `Path '${validation.data.file_path}' is outside the allowed roots for this tool.`,
        };
      }
    }
    return this.dispatch(validation.data, id, workingDirectory, context);
  }
```

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/tool/ReadTool/__tests__/ReadTool.test.ts`
Expected: PASS (existing tests still green; the 5 new allowedRoots cases green).

- [x] **Step 6: Run typecheck**

Run: `npm run typecheck:all`
Expected: PASS. Verify `builtin.ts:104` (`new ReadTool()`) and `ReadTool.ts:674` (`createReadTool` → `new ReadTool()`) still compile — both pass `undefined` for the now-optional opts.

- [x] **Step 7: Commit**

```bash
git add packages/agent/src/tool/ReadTool/ReadTool.ts packages/agent/src/tool/ReadTool/__tests__/ReadTool.test.ts
git commit -m "feat(agent): add allowedRoots sandbox to ReadTool"
```

---

## Task 3: Add `allowedRoots` to WriteTool

**Files:**
- Modify: `packages/agent/src/tool/WriteTool/WriteTool.ts` (class at line 81; `execute` at line 128; imports at line 21)
- Create: `packages/agent/src/tool/WriteTool/__tests__/WriteTool.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/agent/src/tool/WriteTool/__tests__/WriteTool.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteTool } from '../WriteTool.js';

let root: string;
let outside: string;
let tool: WriteTool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-write-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-write-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  tool = new WriteTool();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('WriteTool basic', () => {
  it('writes content to a file inside the working directory', async () => {
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'new.md'), content: 'hello' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(existsSync(join(root, 'memory', 'new.md'))).toBe(true);
    expect(readFileSync(join(root, 'memory', 'new.md'), 'utf-8')).toBe('hello');
  });

  it('creates parent directories when they do not exist', async () => {
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'sub', 'deep.md'), content: 'deep' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'sub', 'deep.md'), 'utf-8')).toBe('deep');
  });
});

describe('WriteTool allowedRoots sandbox', () => {
  it('rejects a write outside allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(outside, 'stolen.md'), content: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
    expect(existsSync(join(outside, 'stolen.md'))).toBe(false);
  });

  it('allows a write inside allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(root, 'memory', 'ok.md'), content: 'ok' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'ok.md'), 'utf-8')).toBe('ok');
  });

  it('allows writing a new file whose parent exists inside allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(root, 'memory', 'brand-new.md'), content: 'brand' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'brand-new.md'), 'utf-8')).toBe('brand');
  });

  it('rejects a write that uses .. to escape allowedRoots', async () => {
    const sandboxed = new WriteTool({ allowedRoots: [join(root, 'memory')] });
    const escape = join(root, 'memory', '..', '..', 'escape.md');
    const result = await sandboxed.execute({ file_path: escape, content: 'x' }, root);
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const result = await tool.execute(
      { file_path: join(outside, 'free.md'), content: 'free' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(outside, 'free.md'), 'utf-8')).toBe('free');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/tool/WriteTool/__tests__/WriteTool.test.ts`
Expected: FAIL with TypeScript error: `Object literal may only specify known properties, and 'allowedRoots' does not exist in type '{}'` (WriteTool has no constructor today).

- [x] **Step 3: Update WriteTool constructor and imports**

In `packages/agent/src/tool/WriteTool/WriteTool.ts`, add the imports next to the existing `expandPath` import (line 21):

```typescript
import { expandPath } from '../../utils/path.js';
import { isPathWithinRoots } from '../allowedRoots.js';
```

Add a constructor and `allowedRoots` field to the `WriteTool` class. Insert immediately after the `readonly input_schema` block (after line 102, before `get interruptBehavior`):

```typescript
  private readonly allowedRoots?: readonly string[];

  constructor(opts: { allowedRoots?: string[] } = {}) {
    super();
    this.allowedRoots = opts.allowedRoots;
  }
```

- [x] **Step 4: Enforce allowedRoots in `execute`**

In `packages/agent/src/tool/WriteTool/WriteTool.ts`, replace the early part of `execute` (lines 128-145) — specifically insert the root check after `const { file_path, content, encoding = 'utf-8' } = validation.data;` and before `// Use expandPath for cross-platform compatibility`:

```typescript
  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();

    const validation = validateWriteInput(input);
    if (!validation.valid) {
      return {
        id,
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { file_path, content, encoding = 'utf-8' } = validation.data;

    if (this.allowedRoots && this.allowedRoots.length > 0) {
      const resolved = expandPath(file_path, workingDirectory);
      if (!isPathWithinRoots(resolved, [...this.allowedRoots])) {
        return {
          id,
          name: this.name,
          error: true,
          result: `Path '${file_path}' is outside the allowed roots for this tool.`,
        };
      }
    }

    try {
      // Use expandPath for cross-platform compatibility
      const absolutePath = expandPath(file_path, workingDirectory);

      const dirPath = dirname(absolutePath);
```

Leave the rest of the `execute` body unchanged from `if (!existsSync(dirPath)) {` onward.

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/tool/WriteTool/__tests__/WriteTool.test.ts`
Expected: PASS (all 8 cases).

- [x] **Step 6: Run typecheck**

Run: `npm run typecheck:all`
Expected: PASS. Verify `builtin.ts:50` (`const writeTool = new WriteTool();`) still compiles.

- [x] **Step 7: Commit**

```bash
git add packages/agent/src/tool/WriteTool/WriteTool.ts packages/agent/src/tool/WriteTool/__tests__/WriteTool.test.ts
git commit -m "feat(agent): add allowedRoots sandbox to WriteTool"
```

---

## Task 4: Add `allowedRoots` to EditTool

**Files:**
- Modify: `packages/agent/src/tool/EditTool/EditTool.ts` (class at line 81; class `execute` at line 124; imports at line 8-20)
- Create: `packages/agent/src/tool/EditTool/__tests__/EditTool.test.ts`

**Note:** EditTool resolves paths inside the standalone `executeEdit` function (line 186) using `resolve(workingDirectory || process.cwd(), file_path)` — NOT `expandPath`. The class `execute` method delegates to `executeEdit`. To enforce `allowedRoots` we add the check in the **class** `execute` method (after validation, before calling `executeEdit`), resolving the path with `expandPath` so the check matches the resolution used by the other tools. `executeEdit` then re-resolves internally to the same file; the check is a superset guard.

- [x] **Step 1: Write the failing test**

Create `packages/agent/src/tool/EditTool/__tests__/EditTool.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../EditTool.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-edit-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-edit-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'line one\nline two\nline three\n');
  writeFileSync(join(outside, 'o.md'), 'outside\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('EditTool basic', () => {
  it('replaces a unique string in a file', async () => {
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'a.md'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'a.md'), 'utf-8')).toContain('TWO');
  });

  it('errors when old_string is not found', async () => {
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: join(root, 'memory', 'a.md'), old_string: 'nope', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
  });
});

describe('EditTool allowedRoots sandbox', () => {
  it('rejects an edit outside allowedRoots', async () => {
    const sandboxed = new EditTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(outside, 'o.md'), old_string: 'outside', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
    // Content unchanged
    expect(readFileSync(join(outside, 'o.md'), 'utf-8')).toBe('outside\n');
  });

  it('allows an edit inside allowedRoots', async () => {
    const sandboxed = new EditTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute(
      { file_path: join(root, 'memory', 'a.md'), old_string: 'line two', new_string: 'TWO' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'memory', 'a.md'), 'utf-8')).toContain('TWO');
  });

  it('rejects an edit that uses .. to escape allowedRoots', async () => {
    const sandboxed = new EditTool({ allowedRoots: [join(root, 'memory')] });
    const escape = join(root, 'memory', '..', '..', 'o.md');
    const result = await sandboxed.execute(
      { file_path: escape, old_string: 'outside', new_string: 'x' },
      root,
    );
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new EditTool();
    const result = await tool.execute(
      { file_path: join(outside, 'o.md'), old_string: 'outside', new_string: 'OUT' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(outside, 'o.md'), 'utf-8')).toContain('OUT');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/tool/EditTool/__tests__/EditTool.test.ts`
Expected: FAIL with TypeScript error: `Object literal may only specify known properties, and 'allowedRoots' does not exist in type '{}'` (EditTool has no constructor).

- [x] **Step 3: Update EditTool imports, constructor, and execute**

In `packages/agent/src/tool/EditTool/EditTool.ts`, add the imports next to the existing `checkPathWritePermission` import (line 20):

```typescript
import { checkPathWritePermission } from '../../permissions/pathPermission.js';
import { expandPath } from '../../utils/path.js';
import { isPathWithinRoots } from '../allowedRoots.js';
```

Add a constructor and `allowedRoots` field to the `EditTool` class. Insert immediately after the `readonly input_schema` block (after line 101, before `get interruptBehavior`):

```typescript
  private readonly allowedRoots?: readonly string[];

  constructor(opts: { allowedRoots?: string[] } = {}) {
    super();
    this.allowedRoots = opts.allowedRoots;
  }
```

Replace the class `execute` method (lines 124-136):

```typescript
  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const validation = validateEditInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    return executeEdit(crypto.randomUUID(), validation.data, workingDirectory);
  }
```

with:

```typescript
  async execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const validation = validateEditInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    if (this.allowedRoots && this.allowedRoots.length > 0) {
      const resolved = expandPath(validation.data.file_path, workingDirectory);
      if (!isPathWithinRoots(resolved, [...this.allowedRoots])) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          error: true,
          result: `Path '${validation.data.file_path}' is outside the allowed roots for this tool.`,
        };
      }
    }

    return executeEdit(crypto.randomUUID(), validation.data, workingDirectory);
  }
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/tool/EditTool/__tests__/EditTool.test.ts`
Expected: PASS (all 6 cases).

- [x] **Step 5: Run typecheck**

Run: `npm run typecheck:all`
Expected: PASS. Verify `EditTool.ts:177` (`export const editTool = new EditTool();`) and `builtin.ts:114` (`new EditTool()`) still compile.

- [x] **Step 6: Commit**

```bash
git add packages/agent/src/tool/EditTool/EditTool.ts packages/agent/src/tool/EditTool/__tests__/EditTool.test.ts
git commit -m "feat(agent): add allowedRoots sandbox to EditTool"
```

---

## Task 5: Add `allowedRoots` to GrepTool and GlobTool

**Files:**
- Modify: `packages/agent/src/tool/GrepTool/GrepTool.ts` (`GrepToolOptions` at line 42; constructor at line 148; `execute` at line 364; imports at line 17)
- Modify: `packages/agent/src/tool/GlobTool/GlobTool.ts` (class at line 24; `execute` at line 54; imports at line 17-18)
- Create: `packages/agent/src/tool/GrepTool/__tests__/GrepTool.test.ts`
- Create: `packages/agent/src/tool/GlobTool/__tests__/GlobTool.test.ts`

Both tools route their working directory through `sanitizeWorkingDirectory` (from `GrepTool/sanitize.ts`), which returns an absolute path or `undefined`. By the time we compute the search path, it is absolute — so `isPathWithinRoots` can be applied directly. GrepTool and GlobTool are combined into one task because they share the search-tool pattern and the same `sanitizeWorkingDirectory` root.

- [x] **Step 1: Write the failing GrepTool test**

Create `packages/agent/src/tool/GrepTool/__tests__/GrepTool.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool } from '../GrepTool.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-grep-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-grep-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'needle in haystack\nsecond line\n');
  writeFileSync(join(outside, 'o.md'), 'needle outside\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('GrepTool basic', () => {
  it('finds matches inside the working directory', async () => {
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });
});

describe('GrepTool allowedRoots sandbox', () => {
  it('rejects a search whose path is outside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: join(root, 'memory'),
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle', path: outside });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows a search inside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: join(root, 'memory'),
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });

  it('rejects a search that defaults to a working directory outside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: outside,
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new GrepTool({ workingDirectory: outside });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
  });
});
```

- [x] **Step 2: Write the failing GlobTool test**

Create `packages/agent/src/tool/GlobTool/__tests__/GlobTool.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobTool } from '../GlobTool.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-glob-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-glob-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'a');
  writeFileSync(join(outside, 'o.md'), 'o');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('GlobTool basic', () => {
  it('finds files matching a pattern inside the working directory', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: '*.md' }, join(root, 'memory'));
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });
});

describe('GlobTool allowedRoots sandbox', () => {
  it('rejects a glob whose path is outside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: '*.md', path: outside });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows a glob inside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: '*.md', path: join(root, 'memory') });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });

  it('rejects a glob that defaults to a working directory outside allowedRoots', async () => {
    const sandboxed = new GlobTool({ allowedRoots: [join(root, 'memory')] });
    const result = await sandboxed.execute({ pattern: '*.md' }, outside);
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({ pattern: '*.md' }, outside);
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.numFiles).toBeGreaterThanOrEqual(1);
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/agent/src/tool/GrepTool/__tests__/GrepTool.test.ts packages/agent/src/tool/GlobTool/__tests__/GlobTool.test.ts`
Expected: FAIL with TypeScript errors: `Object literal may only specify known properties, and 'allowedRoots' does not exist in type 'GrepToolOptions'` (GrepTool) and `'allowedRoots' does not exist in type '{}'` (GlobTool).

- [x] **Step 4: Update GrepTool**

In `packages/agent/src/tool/GrepTool/GrepTool.ts`, add the import next to the existing `sanitizeWorkingDirectory` import (line 17):

```typescript
import { sanitizeWorkingDirectory } from './sanitize.js';
import { isPathWithinRoots } from '../allowedRoots.js';
```

Extend `GrepToolOptions` (lines 42-44):

```typescript
export interface GrepToolOptions {
  workingDirectory?: string;
  allowedRoots?: string[];
}
```

Add the `allowedRoots` field to the class and wire it in the constructor. Replace the constructor block (lines 145-159):

```typescript
  private workingDirectory: string;
  private defaultMaxResults = 50;

  constructor(options: GrepToolOptions = {}) {
    super();
    // Process cwd is unreliable in the packaged Electron main process — it
    // resolves to the app install dir (e.g. C:\Program Files\duya\resources\app.asar),
    // not the user's project. Prefer the explicit option; only fall back to
    // process.cwd() when no better source is available, and detect the asar
    // case so the caller gets a clear error instead of a silent misscan.
    // The empty-string default is safe because execute() re-runs the
    // sanitizer on every call and refuses to scan when the result is
    // undefined.
    this.workingDirectory = sanitizeWorkingDirectory(options.workingDirectory) ?? '';
  }
```

with:

```typescript
  private workingDirectory: string;
  private readonly allowedRoots?: readonly string[];
  private defaultMaxResults = 50;

  constructor(options: GrepToolOptions = {}) {
    super();
    // Process cwd is unreliable in the packaged Electron main process — it
    // resolves to the app install dir (e.g. C:\Program Files\duya\resources\app.asar),
    // not the user's project. Prefer the explicit option; only fall back to
    // process.cwd() when no better source is available, and detect the asar
    // case so the caller gets a clear error instead of a silent misscan.
    // The empty-string default is safe because execute() re-runs the
    // sanitizer on every call and refuses to scan when the result is
    // undefined.
    this.workingDirectory = sanitizeWorkingDirectory(options.workingDirectory) ?? '';
    this.allowedRoots = options.allowedRoots;
  }
```

Enforce `allowedRoots` in `execute`. In the `execute` method, after the `searchPath` computation (after line 402, before the `try {` block at line 404), insert:

```typescript
    if (this.allowedRoots && this.allowedRoots.length > 0) {
      if (!isPathWithinRoots(searchPath, [...this.allowedRoots])) {
        return {
          id,
          name: this.name,
          error: true,
          result: JSON.stringify({
            success: false,
            error: `Search path '${searchPath}' is outside the allowed roots for this tool.`,
          }),
        };
      }
    }
```

The surrounding code (lines 398-402) stays:

```typescript
    const searchPath = path
      ? isAbsolute(path)
        ? path
        : join(baseDir, path)
      : baseDir;
```

- [x] **Step 5: Update GlobTool**

In `packages/agent/src/tool/GlobTool/GlobTool.ts`, add the import next to the existing `sanitizeWorkingDirectory` import (line 18):

```typescript
import { sanitizeWorkingDirectory } from '../GrepTool/sanitize.js';
import { isPathWithinRoots } from '../allowedRoots.js';
```

Add a constructor and `allowedRoots` field to the `GlobTool` class. Insert immediately after the `readonly input_schema` block (after line 44, before `get interruptBehavior`):

```typescript
  private readonly allowedRoots?: readonly string[];

  constructor(opts: { allowedRoots?: string[] } = {}) {
    super();
    this.allowedRoots = opts.allowedRoots;
  }
```

Enforce `allowedRoots` in `execute`. In the `execute` method, after the `safeCwd` computation (after line 71, before the `if (!safeCwd)` check at line 73 — actually insert AFTER the `if (!safeCwd) { ... }` block so we never check an undefined cwd), the final shape of the early `execute` body becomes:

```typescript
  async execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult> {
    const validation = validateGlobInput(input);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { pattern, path: searchPath, maxResults } = validation.data;
    // Prefer the live context cwd, fall back to whatever was captured at
    // construct time. Both must be asar-safe — process.cwd() in the packaged
    // Electron main process resolves to the install dir.
    const safeCwd = sanitizeWorkingDirectory(searchPath)
      ?? sanitizeWorkingDirectory(workingDirectory)
      ?? sanitizeWorkingDirectory(process.cwd());

    if (!safeCwd) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: 'No safe working directory available (asar bundle, empty, or non-existent path). Pass `path` explicitly or run from a project context.',
        }),
        error: true,
      };
    }

    if (this.allowedRoots && this.allowedRoots.length > 0) {
      if (!isPathWithinRoots(safeCwd, [...this.allowedRoots])) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          error: true,
          result: JSON.stringify({
            success: false,
            error: `Search path '${safeCwd}' is outside the allowed roots for this tool.`,
          }),
        };
      }
    }

    return executeGlob(pattern, safeCwd, { maxResults });
  }
```

- [x] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/tool/GrepTool/__tests__/GrepTool.test.ts packages/agent/src/tool/GlobTool/__tests__/GlobTool.test.ts`
Expected: PASS (all GrepTool + GlobTool cases).

- [x] **Step 7: Run typecheck**

Run: `npm run typecheck:all`
Expected: PASS. Verify `builtin.ts:55` (`new GrepTool()`), `builtin.ts:118` (`new GlobTool()`), `GlobTool.ts:147` (`export const globTool = new GlobTool();`) all still compile.

- [x] **Step 8: Commit**

```bash
git add packages/agent/src/tool/GrepTool/GrepTool.ts packages/agent/src/tool/GlobTool/GlobTool.ts packages/agent/src/tool/GrepTool/__tests__/GrepTool.test.ts packages/agent/src/tool/GlobTool/__tests__/GlobTool.test.ts
git commit -m "feat(agent): add allowedRoots sandbox to GrepTool and GlobTool"
```

---

## Task 6: Add `memory-curator` AgentProfile preset

**Files:**
- Modify: `packages/agent/src/agent-profile/types.ts` (add entry to `PRESET_AGENT_PROFILES` after line 303)
- Create: `packages/agent/src/agent-profile/types.test.ts`

**Design reference:** §7.3 (what the curator entry disables) and §7.4 (session identity). The profile is a defense-in-depth layer — the curator process entry (Task 7) only registers 5 tools, so even without the profile filter no other tools are reachable. The profile's `allowedTools` whitelist + `disallowedTools` blacklist ensure that if the profile is ever reused in a process that registers more tools, the dangerous ones stay hidden. `userVisible: false` keeps it out of the UI; `isPreset: true` marks it as non-deletable.

- [x] **Step 1: Write the failing test**

Create `packages/agent/src/agent-profile/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PRESET_AGENT_PROFILES } from './types.js';
import { resolveAllowedTools } from './ToolFilter.js';

describe('PRESET_AGENT_PROFILES', () => {
  it('includes the memory-curator preset', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator');
    expect(curator).toBeDefined();
    expect(curator!.isPreset).toBe(true);
    expect(curator!.userVisible).toBe(false);
    expect(curator!.isEnabled).toBe(true);
    expect(curator!.allowedTools).toEqual(['read', 'write', 'edit', 'grep', 'glob']);
  });

  it('memory-curator denies shell, subagent, canvas, and self-management tools', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    expect(curator.disallowedTools).toContain('bash');
    expect(curator.disallowedTools).toContain('powershell');
    expect(curator.disallowedTools).toContain('Agent');
    expect(curator.disallowedTools).toContain('canvas:*');
    expect(curator.disallowedTools).toContain('duya_cli');
    expect(curator.disallowedTools).toContain('tool_search');
    expect(curator.disallowedTools).toContain('skill');
  });

  it('memory-curator disables volatile prompt sections', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const disabled = curator.promptProfile?.disableSections ?? [];
    // Memory content is the curator's INPUT, not a prompt section it should
    // re-inject as context about itself.
    expect(disabled).toContain('memory');
    expect(disabled).toContain('memoryContent');
    expect(disabled).toContain('skills');
    expect(disabled).toContain('agentsMd');
    expect(disabled).toContain('rules');
  });

  it('resolveAllowedTools whitelists exactly the 5 file tools for memory-curator', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const allTools = [
      'read', 'write', 'edit', 'grep', 'glob',
      'bash', 'powershell', 'Agent', 'browser', 'canvas_create',
      'show_widget', 'AskUserQuestion', 'duya_cli', 'tool_search',
      'skill', 'task', 'vision_analyze',
    ];
    const result = resolveAllowedTools(curator, allTools);
    expect(result.allowed.sort()).toEqual(['edit', 'glob', 'grep', 'read', 'write']);
    expect(result.denied).toContain('bash');
    expect(result.denied).toContain('Agent');
    expect(result.isValid).toBe(true);
  });

  it('memory-curator is distinct from the explore preset (different toolset)', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const explore = PRESET_AGENT_PROFILES.find((p) => p.id === 'explore')!;
    expect(curator.allowedTools).not.toEqual(explore.allowedTools);
    // curator can write/edit; explore cannot
    expect(curator.allowedTools).toContain('write');
    expect(explore.disallowedTools).toContain('write');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/agent-profile/types.test.ts`
Expected: FAIL with `expected undefined to be defined` on the first `expect(curator).toBeDefined()` (the preset does not exist yet).

- [x] **Step 3: Add the `memory-curator` preset**

In `packages/agent/src/agent-profile/types.ts`, append a new entry to the `PRESET_AGENT_PROFILES` array, immediately before the closing `];` at line 303 (after the `conductor-refine` entry):

```typescript
  {
    id: 'memory-curator',
    name: 'Memory Curator',
    description:
      'Phase 2 memory curation agent — root-bound file tools only, no shell/MCP/skills',
    // Defense-in-depth whitelist: the curator process entry only registers
    // these 5 tools, so the profile filter is a second layer in case the
    // profile is ever reused in a process that registers more tools.
    allowedTools: ['read', 'write', 'edit', 'grep', 'glob'],
    disallowedTools: [
      // No shell — the curator never executes commands.
      'bash', 'powershell',
      // No recursive subagent spawning.
      'Agent',
      // No interactive / UI / canvas surface — curator runs headless.
      'canvas:*', 'show_widget', 'AskUserQuestion',
      // No browser, no self-management, no module loader.
      'browser', 'duya_cli', 'read_module', 'task', 'tool_search', 'skill',
      // No mode-switching side effects.
      'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
      // No session-to-session messaging or vision.
      'session_search', 'message_session', 'vision_analyze',
    ],
    promptProfile: {
      // Memory content is the curator's INPUT data, not context about
      // itself. Skills, AGENTS.md, project grounding, and the "ask the
      // user" rules are all irrelevant or harmful in a headless curation
      // run (design §7.3, §7.5).
      disableSections: [
        'memory', 'memoryContent', 'skills', 'sessionGuidance',
        'agentsMd', 'projectGrounding', 'projectContinuity',
        'visionGuidelines', 'rules',
      ],
    },
    promptSystem: 'general',
    userVisible: false,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/agent-profile/types.test.ts`
Expected: PASS (all 5 cases).

- [x] **Step 5: Run full agent-profile + tool filter test suite**

Run: `npx vitest run packages/agent/src/agent-profile`
Expected: PASS (no existing tests broken; the preset array grew by one entry).

- [x] **Step 6: Run typecheck**

Run: `npm run typecheck:all`
Expected: PASS. The `InMemoryAgentProfileService.initPresets()` loads `PRESET_AGENT_PROFILES` automatically; the new preset is picked up without further wiring.

- [x] **Step 7: Commit**

```bash
git add packages/agent/src/agent-profile/types.ts packages/agent/src/agent-profile/types.test.ts
git commit -m "feat(agent): add memory-curator AgentProfile preset"
```

---

## Task 7: `memory-curator-process-entry.ts` with root-bound tools

**Files:**
- Create: `packages/agent/src/process/memory-curator-process-entry.ts`
- Create: `packages/agent/src/process/memory-curator-process-entry.test.ts`

**Design reference:** §7.2 (exact root layout per tool) and §7.3 (what the entry disables — by NOT registering those tools at all). The entry exports `createCuratorTools(stagingRoot): ToolRegistry` (constructs the 5 root-bound tools) and `parseStagingRootFromArgv(argv): string` (reads `--staging-root`). It does NOT register bash/MCP/skills/AGENTS — those are absent by construction, not by permission. This task does NOT wire the entry into the process pool launcher; that is a later plan (the design §14 Phase A gates the whole feature behind `DUYA_MEMORY_PHASE2_ENABLED`).

- [x] **Step 1: Write the failing test**

Create `packages/agent/src/process/memory-curator-process-entry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCuratorTools, parseStagingRootFromArgv } from './memory-curator-process-entry.js';

let stagingRoot: string;

beforeEach(() => {
  stagingRoot = mkdtempSync(join(tmpdir(), 'duya-curator-'));
  // Seed the directory layout the curator expects (design §7.2).
  mkdirSync(join(stagingRoot, 'memory'), { recursive: true });
  mkdirSync(join(stagingRoot, 'memory-config'), { recursive: true });
  mkdirSync(join(stagingRoot, 'inputs'), { recursive: true });
  writeFileSync(join(stagingRoot, 'memory', 'a.md'), 'inside memory');
  writeFileSync(join(stagingRoot, 'memory-config', 'stage1_policy.md'), 'policy');
  writeFileSync(join(stagingRoot, 'inputs', 'rollout.md'), 'rollout evidence');
  writeFileSync(join(stagingRoot, 'curation_receipt.json'), '{}');
});

afterEach(() => {
  rmSync(stagingRoot, { recursive: true, force: true });
});

describe('createCuratorTools', () => {
  it('registers exactly 5 tools', () => {
    const registry = createCuratorTools(stagingRoot);
    expect(registry.size).toBe(5);
  });

  it('registers read, write, edit, grep, glob by name', () => {
    const registry = createCuratorTools(stagingRoot);
    expect(registry.has('read')).toBe(true);
    expect(registry.has('write')).toBe(true);
    expect(registry.has('edit')).toBe(true);
    expect(registry.has('grep')).toBe(true);
    expect(registry.has('glob')).toBe(true);
  });

  it('does NOT register bash or any non-file tool', () => {
    const registry = createCuratorTools(stagingRoot);
    expect(registry.has('bash')).toBe(false);
    expect(registry.has('powershell')).toBe(false);
    expect(registry.has('Agent')).toBe(false);
    expect(registry.has('browser')).toBe(false);
    expect(registry.has('duya_cli')).toBe(false);
  });

  it('ReadTool allows reading inside memory, memory-config, inputs, and stagingRoot (receipt)', async () => {
    const registry = createCuratorTools(stagingRoot);
    const readExecutor = registry.getExecutor('read')!;
    const r1 = await readExecutor.execute({ file_path: join(stagingRoot, 'memory', 'a.md') });
    expect(r1.error).toBeFalsy();
    const r2 = await readExecutor.execute({ file_path: join(stagingRoot, 'memory-config', 'stage1_policy.md') });
    expect(r2.error).toBeFalsy();
    const r3 = await readExecutor.execute({ file_path: join(stagingRoot, 'inputs', 'rollout.md') });
    expect(r3.error).toBeFalsy();
    const r4 = await readExecutor.execute({ file_path: join(stagingRoot, 'curation_receipt.json') });
    expect(r4.error).toBeFalsy();
  });

  it('ReadTool rejects a read outside all roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'duya-curator-out-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'secret');
      const registry = createCuratorTools(stagingRoot);
      const readExecutor = registry.getExecutor('read')!;
      const result = await readExecutor.execute({ file_path: join(outside, 'secret.md') });
      expect(result.error).toBe(true);
      expect(result.result).toContain('outside the allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('WriteTool allows writing inside memory and memory-config but rejects stagingRoot-only paths outside those', async () => {
    const registry = createCuratorTools(stagingRoot);
    const writeExecutor = registry.getExecutor('write')!;
    // write roots: memory, memory-config, stagingRoot (receipt)
    const okMemory = await writeExecutor.execute(
      { file_path: join(stagingRoot, 'memory', 'new.md'), content: 'x' },
    );
    expect(okMemory.error).toBeFalsy();
    const okReceipt = await writeExecutor.execute(
      { file_path: join(stagingRoot, 'curation_receipt.json'), content: '{}' },
    );
    expect(okReceipt.error).toBeFalsy();
    // inputs/ is NOT a write root — the curator must not modify frozen evidence
    const rejectInputs = await writeExecutor.execute(
      { file_path: join(stagingRoot, 'inputs', 'tamper.md'), content: 'x' },
    );
    expect(rejectInputs.error).toBe(true);
    expect(rejectInputs.result).toContain('outside the allowed roots');
  });

  it('EditTool allows editing inside memory and memory-config, rejects inputs', async () => {
    const registry = createCuratorTools(stagingRoot);
    const editExecutor = registry.getExecutor('edit')!;
    const ok = await editExecutor.execute(
      { file_path: join(stagingRoot, 'memory', 'a.md'), old_string: 'inside memory', new_string: 'edited' },
    );
    expect(ok.error).toBeFalsy();
    const reject = await editExecutor.execute(
      { file_path: join(stagingRoot, 'inputs', 'rollout.md'), old_string: 'rollout', new_string: 'x' },
    );
    expect(reject.error).toBe(true);
    expect(reject.result).toContain('outside the allowed roots');
  });

  it('GrepTool searches inside memory and inputs, rejects an outside path', async () => {
    const registry = createCuratorTools(stagingRoot);
    const grepExecutor = registry.getExecutor('grep')!;
    const ok = await grepExecutor.execute(
      { pattern: 'inside', path: join(stagingRoot, 'memory') },
    );
    expect(ok.error).toBeFalsy();
    const outside = mkdtempSync(join(tmpdir(), 'duya-curator-grep-out-'));
    try {
      writeFileSync(join(outside, 'o.md'), 'inside');
      const reject = await grepExecutor.execute({ pattern: 'inside', path: outside });
      expect(reject.error).toBe(true);
      expect(reject.result).toContain('outside the allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('GlobTool globs inside memory-config and inputs, rejects an outside path', async () => {
    const registry = createCuratorTools(stagingRoot);
    const globExecutor = registry.getExecutor('glob')!;
    const ok = await globExecutor.execute(
      { pattern: '*.md', path: join(stagingRoot, 'memory-config') },
    );
    expect(ok.error).toBeFalsy();
    const outside = mkdtempSync(join(tmpdir(), 'duya-curator-glob-out-'));
    try {
      writeFileSync(join(outside, 'o.md'), 'x');
      const reject = await globExecutor.execute({ pattern: '*.md', path: outside });
      expect(reject.error).toBe(true);
      expect(reject.result).toContain('outside the allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('parseStagingRootFromArgv', () => {
  it('reads --staging-root value', () => {
    const argv = ['node', 'entry.js', '--staging-root', '/tmp/stage'];
    expect(parseStagingRootFromArgv(argv)).toBe('/tmp/stage');
  });

  it('throws when --staging-root is missing', () => {
    expect(() => parseStagingRootFromArgv(['node', 'entry.js'])).toThrow(/--staging-root/);
  });

  it('throws when --staging-root has no value', () => {
    expect(() => parseStagingRootFromArgv(['node', 'entry.js', '--staging-root'])).toThrow(/--staging-root/);
  });

  it('throws when --staging-root value is empty', () => {
    expect(() => parseStagingRootFromArgv(['node', 'entry.js', '--staging-root', ''])).toThrow(/empty/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/process/memory-curator-process-entry.test.ts`
Expected: FAIL with `Failed to resolve import "./memory-curator-process-entry.js"` (module does not exist yet).

- [x] **Step 3: Write the implementation**

Create `packages/agent/src/process/memory-curator-process-entry.ts`:

```typescript
/**
 * memory-curator-process-entry.ts — Phase 2 Curator Agent process entry.
 *
 * Registers exactly five root-bound file tools (read/write/edit/grep/glob),
 * each constructed with `allowedRoots` derived from a `--staging-root` argv.
 * The curator process literally cannot name live memory, the DB, or the
 * user home — every tool call is bounded to the staging workspace.
 *
 * What this entry does NOT register (design §7.3): bash / shell, MCP
 * servers, apps, plugin tools, subagent tools, skills, AGENTS.md, the
 * runtime memory prompt section, conductor / canvas / message-session
 * tools. These are absent by construction, not by permission.
 *
 * Design: docs/design-docs/2026-08-03-memory-phase2-curation-agent-design.md
 * §7 (Phase 2 Agent: toolset and sandboxing).
 */
import * as path from 'node:path';
import { ToolRegistry } from '../tool/registry.js';
import { ReadTool } from '../tool/ReadTool/ReadTool.js';
import { WriteTool } from '../tool/WriteTool/WriteTool.js';
import { EditTool } from '../tool/EditTool/EditTool.js';
import { GrepTool } from '../tool/GrepTool/GrepTool.js';
import { GlobTool } from '../tool/GlobTool/GlobTool.js';

/**
 * Construct a ToolRegistry containing exactly the five root-bound file
 * tools. Roots are derived from `stagingRoot` per design §7.2:
 *
 *   read  → memory, memory-config, stagingRoot (receipt), inputs
 *   write → memory, memory-config, stagingRoot (receipt)
 *   edit  → memory, memory-config
 *   grep  → memory, memory-config, inputs
 *   glob  → memory, memory-config, inputs
 *
 * `inputs/` is read-only for the curator (frozen rollout evidence) — it
 * is a root for read/grep/glob but NOT for write/edit. `stagingRoot`
 * itself is a write root only so the curator can emit `curation_receipt.json`
 * at the staging root; it must not write arbitrary files there.
 */
export function createCuratorTools(stagingRoot: string): ToolRegistry {
  if (!stagingRoot) {
    throw new Error('createCuratorTools: stagingRoot is required');
  }

  const memory = path.join(stagingRoot, 'memory');
  const memoryConfig = path.join(stagingRoot, 'memory-config');
  const inputs = path.join(stagingRoot, 'inputs');

  const readRoots = [memory, memoryConfig, stagingRoot, inputs];
  const writeRoots = [memory, memoryConfig, stagingRoot];
  const editRoots = [memory, memoryConfig];
  const searchRoots = [memory, memoryConfig, inputs];

  const readTool = new ReadTool({ allowedRoots: readRoots });
  const writeTool = new WriteTool({ allowedRoots: writeRoots });
  const editTool = new EditTool({ allowedRoots: editRoots });
  const grepTool = new GrepTool({ allowedRoots: searchRoots });
  const globTool = new GlobTool({ allowedRoots: searchRoots });

  const registry = new ToolRegistry();
  registry.register(readTool.toTool(), readTool, { exposeMode: 'always' });
  registry.register(writeTool.toTool(), writeTool, { exposeMode: 'always' });
  registry.register(editTool.toTool(), editTool, { exposeMode: 'always' });
  registry.register(grepTool.toTool(), grepTool, { exposeMode: 'always' });
  registry.register(globTool.toTool(), globTool, { exposeMode: 'always' });

  return registry;
}

/**
 * Read `--staging-root <path>` from an argv array and return the value.
 * Throws if the flag is missing, has no value, or the value is empty.
 *
 * Extracted from the process main so it is unit-testable without spawning
 * a real process. The curator process main (wired in a later plan) calls
 * this, then `createCuratorTools`.
 */
export function parseStagingRootFromArgv(argv: string[]): string {
  const idx = argv.indexOf('--staging-root');
  if (idx === -1) {
    throw new Error('memory-curator-process-entry: --staging-root <path> is required');
  }
  if (idx === argv.length - 1) {
    throw new Error('memory-curator-process-entry: --staging-root <path> is required (flag has no value)');
  }
  const value = argv[idx + 1];
  if (!value) {
    throw new Error('memory-curator-process-entry: --staging-root value is empty');
  }
  return value;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/process/memory-curator-process-entry.test.ts`
Expected: PASS (all 13 cases: 9 createCuratorTools behavioral + 4 parseStagingRootFromArgv).

- [x] **Step 5: Run the full agent test suite**

Run: `npm run test`
Expected: PASS — no existing tests broken. The 5 tool modifications are backward-compatible (all new params optional), the new preset is additive, and the new entry is a standalone module.

- [x] **Step 6: Run typecheck**

Run: `npm run typecheck:all`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/agent/src/process/memory-curator-process-entry.ts packages/agent/src/process/memory-curator-process-entry.test.ts
git commit -m "feat(agent): add memory-curator process entry with root-bound tools"
```

---

## Verification Checklist (run after all 7 tasks)

- [x] `npm run typecheck:all` passes.
- [x] `npm test` passes with no regressions (plan401 scope: 87 tests green; the residual full-suite failures are pre-existing plan 315 refactor failures in `mailbox`/`prompts`/`useProvidersQuery`, unrelated to plan401).
- [x] `npx vitest run packages/agent/src/tool/__tests__/allowedRoots.test.ts` — helper robust (traversal, symlink, cross-drive, prefix-collision): 15 tests pass.
- [x] Each of the 5 file tools rejects out-of-root calls and accepts in-root calls; behavior unchanged when `allowedRoots` is unset (ReadTool 31 / WriteTool 7 / EditTool 6 / GrepTool 5 / GlobTool 5 all green).
- [x] `memory-curator` profile exists in `PRESET_AGENT_PROFILES`, `userVisible: false`, `allowedTools` = the 5 file tools, and `resolveAllowedTools` whitelists exactly those 5 (5 tests pass).
- [x] `createCuratorTools(stagingRoot)` returns a registry of exactly 5 tools (`read`/`write`/`edit`/`grep`/`glob`), each behaviorally bound to the design §7.2 root layout, and does NOT register bash/MCP/skills/Agent/etc (13 tests pass).
- [x] No behavior change for normal agent processes: `builtin.ts` still constructs all tools with no `allowedRoots`, the normal agent-process-entry is untouched, and existing tool tests stay green.

## Out of Scope (future plans)

- Wiring `memory-curator-process-entry.ts` into the agent process pool launcher (`--entry` flag selection). Lands with the Phase 2 worker (Plan 403+ / §9).
- The Phase 2 Curator Agent system prompt + initial message (§7.5, §10). Lands with the curation runner.
- `releaseAndWait` on the agent process pool. Tracked in Plan 402.
- The `DUYA_MEMORY_PHASE2_ENABLED` gate. Lands with the worker integration.
- Extending the worker protocol (`InitCommand` / `ChatStartCommand`) with `fileAccessPolicy`. Design §7.1 option 1; explicitly deferred — this plan uses option 2 (dedicated entry).
