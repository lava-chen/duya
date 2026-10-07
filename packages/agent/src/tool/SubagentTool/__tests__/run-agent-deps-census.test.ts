/**
 * Plan 610 A5 census — the compile-time discipline above, enforced as a test.
 *
 * `RunAgentParams` makes `createSubAgent` / `createToolRegistry` REQUIRED, so
 * TypeScript already rejects a call site that forgets them. That is not enough
 * on its own, for two reasons this file closes:
 *
 *  1. Every tsconfig in this repo EXCLUDES the test directories, so a new
 *     `runAgent(` inside `__tests__/` or `tests/` is never type-checked at all.
 *     This census covers those files explicitly.
 *  2. The removed module-level `subagentTool` singleton is not a type error to
 *     reintroduce if someone re-adds the export — only an import of it. The
 *     second half of the census fails on that import.
 *
 * This is a source-reading test on purpose. It asserts on the literal call
 * sites in the tree, which is the same discipline
 * `modes/__tests__/orthogonality.test.ts` already uses for the mode layer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_PKG = path.resolve(HERE, '../../../..');
const AGENT_SRC = path.join(AGENT_PKG, 'src');
const AGENT_TESTS = path.join(AGENT_PKG, 'tests');
const RUN_AGENT_FILE = path.join(AGENT_SRC, 'tool/SubagentTool/runAgent.ts');
const SUBAGENT_TOOL_FILE = path.join(AGENT_SRC, 'tool/SubagentTool/SubagentTool.ts');

const SRC_EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'bundle', 'build', 'release', '.git', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SRC_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** Every `.ts` file under `src/` and `tests/` — the two roots typecheck skips. */
function allAgentSources(): string[] {
  return [...walk(AGENT_SRC), ...walk(AGENT_TESTS)];
}

const rel = (p: string): string => path.relative(AGENT_PKG, p).split(path.sep).join('/');

/**
 * Does this file import `runAgent` or `runAgentSync` from the SubagentTool
 * module?
 *
 * The name `runAgent` is also a `HostAgent` port method across
 * `modes/workflow/**` and `process/workflow-runner.ts`
 * (`ctx.host.runAgent(...)`, `async runAgent(spec) {}`), which is a completely
 * different interface with different arguments. Two details keep those out:
 *
 *  - keying on the IMPORT, not the bare word; and
 *  - reading only the `{ ... }` CLAUSE, never the specifier.
 *
 * The specifier is matched as "ends in `runAgent.js`" rather than by a
 * `SubagentTool/` prefix, because `SubagentTool.ts` itself imports the module
 * as `'./runAgent.js'`. A prefix match left the single most important call
 * site in the tree unscanned while the suite still reported green -- proven by
 * a mutation that deleted `createToolRegistry` from that call and watched the
 * census pass. Requiring the clause to bind `runAgent`/`runAgentSync` is what
 * keeps the `HostAgent` ports out.
 */
function importsSubagentRunner(src: string): boolean {
  const re = /import\s*(?:type\s*)?\{([\s\S]*?)\}\s*from\s*['"][^'"]*\/runAgent\.js['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1];
    if (/\brunAgent\b/.test(clause) || /\brunAgentSync\b/.test(clause)) return true;
  }
  return false;
}

/**
 * The source text of the argument list of the call starting at `openParen`.
 * Balances parentheses so a nested call cannot end the scan early.
 */
function callArguments(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return src.slice(openParen + 1);
}

/** Strip string literals and comments so a factory name inside prose is not a hit. */
function codeOnly(src: string): string {
  return stripComments(src)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Strip COMMENTS ONLY, leaving string literals byte-for-byte intact.
 *
 * This exists because {@link codeOnly} is unusable for any assertion whose
 * subject IS a string literal. `codeOnly` rewrites every string to `''`, so a
 * check for `import('../builtin.js')` is run against `import('')` and can never
 * match.
 *
 * A regex-based comment stripper is NOT a fix. The common one spares `//`
 * preceded by a colon, which protects `https`, but a RELATIVE specifier's `//`
 * is preceded by `.`, not `:`, so
 * `import { DuyaAgent } from '../agent/DuyaAgent.js'` loses everything from the
 * `//` onward. That silently disarmed the *other* half of the same assertion.
 * Both regexes below therefore had no teeth at all, on a file whose two import
 * edges are the ones that closed the cycle.
 *
 * Hence the character scanner: it knows whether it is inside a line comment, a
 * block comment, or a string literal, and only blanks the first two.
 * `architecture:check` caught both edges regardless — it is slow and whole-repo,
 * whereas this census is meant to be the fast local signal.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        const closing = src[i] === quote;
        i += 1;
        if (closing) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The source text the factory fields must appear in.
 *
 * A call site may pass its fields inline (`runAgentSync({ ..., createSubAgent,
 * createToolRegistry })`) or hand over a pre-built object
 * (`runAgentSync(params)`). Both are legitimate, so a bare identifier is
 * resolved to the `const <ident> = { ... }` literal it refers to.
 *
 * Returns `null` when the argument is a bare identifier that resolves to no
 * object literal in the file. That is reported as an offender rather than
 * waved through: an unresolvable call site is exactly the case where this
 * census has no evidence, and silence would read as a pass.
 */
function factoryEvidence(src: string, args: string): string | null {
  const trimmed = args.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) return args;
  const decl = new RegExp(`(?:const|let|var)\\s+${trimmed}\\b[^=]*=\\s*\\{`);
  const m = decl.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

describe('plan 610 A5: sub-agent composition census', () => {
  it('RunAgentParams declares both factories as REQUIRED fields', () => {
    const src = fs.readFileSync(RUN_AGENT_FILE, 'utf8');
    const body = src.slice(src.indexOf('export interface RunAgentParams'));
    for (const field of ['createSubAgent', 'createToolRegistry']) {
      const declared = new RegExp(`\\n\\s{2}${field}\\s*:\\s*\\w`, 'm');
      expect(declared.test(body), `${field} must be a required field on RunAgentParams`).toBe(true);
    }
    // An optional field (`createSubAgent?:`) is the defect this census exists
    // to catch, so assert the optional spelling is absent outright.
    expect(/\n\s{2}create(SubAgent|ToolRegistry)\?\s*:/.test(body)).toBe(false);
  });

  it('every runAgent / runAgentSync call site passes both factories', () => {
    const offenders: string[] = [];
    const scanned: string[] = [];
    let callSites = 0;

    for (const file of allAgentSources()) {
      if (path.resolve(file) === path.resolve(RUN_AGENT_FILE)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (!importsSubagentRunner(raw)) continue;
      scanned.push(rel(file));
      const src = codeOnly(raw);

      const callRe = /\brunAgent(?:Sync)?\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
        callSites += 1;
        const args = callArguments(src, src.indexOf('(', m.index));
        const evidence = factoryEvidence(src, args);
        if (evidence === null) {
          offenders.push(`${rel(file)}: ${m[0].trim()} passes an identifier the census cannot resolve`);
          continue;
        }
        const missing = ['createSubAgent', 'createToolRegistry'].filter((k) => !new RegExp(`\\b${k}\\b`).test(evidence));
        if (missing.length > 0) {
          offenders.push(`${rel(file)}: ${m[0].trim()} missing ${missing.join(', ')}`);
        }
      }
    }

    // A census that scans nothing passes vacuously. This is the false green
    // that a wrong root path produces, so the floor is asserted explicitly:
    // the tree is known to hold this many sub-agent call sites today.
    expect(
      scanned,
      'the census found no file importing runAgent — the scan root is probably wrong',
    ).not.toEqual([]);
    expect(
      callSites,
      `census covered only ${callSites} call sites; expected at least 5 in ${scanned.join(', ')}`,
    ).toBeGreaterThanOrEqual(5);

    expect(
      offenders,
      `These sub-agent call sites do not supply the plan 610 A5 factories:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the module-level subagentTool singleton is gone and nothing imports it', () => {
    const toolSrc = fs.readFileSync(SUBAGENT_TOOL_FILE, 'utf8');
    expect(
      /export\s+const\s+subagentTool\s*=/.test(toolSrc),
      'SubagentTool.ts must not export a module-level `subagentTool` instance',
    ).toBe(false);

    const barrelSrc = fs.readFileSync(path.join(AGENT_SRC, 'tool/SubagentTool/index.ts'), 'utf8');
    const barrelExport = barrelSrc.match(/export\s*\{[^}]*\}\s*from\s*['"][^'"]*SubagentTool\.js['"]/);
    if (barrelExport) {
      expect(
        /\bsubagentTool\b/.test(barrelExport[0]),
        'the SubagentTool barrel must not re-export `subagentTool`',
      ).toBe(false);
    }

    // No source file may BIND the removed singleton by import. A local
    // `const subagentTool = new SubagentTool(deps)` inside a registry factory
    // is fine and is not matched here.
    const importers: string[] = [];
    for (const file of allAgentSources()) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /import\s*\{[^}]*\bsubagentTool\b[^}]*\}\s*from\s*['"][^'"]*['"]/g;
      if (re.test(src)) importers.push(rel(file));
    }
    expect(
      importers,
      `These files import the removed subagentTool singleton:\n${importers.join('\n')}`,
    ).toEqual([]);
  });

  it('the cycle edges are absent from runAgent.ts', () => {
    // `stripComments`, NOT `codeOnly`: the specifier below is a string literal,
    // and `codeOnly` rewrites strings to `''`, which silently disarms this
    // whole assertion. See the note on `stripComments`.
    const src = stripComments(fs.readFileSync(RUN_AGENT_FILE, 'utf8'));
    // A VALUE import of DuyaAgent re-closes runAgent -> DuyaAgent -> builtin
    // -> SubagentTool -> runAgent. `import type` is erased and is fine; the
    // inline `import { type X }` spelling is NOT erased, so it is rejected here.
    // Case-insensitive so a rename to `DuyaAgent` cannot slip past; the `\b`
    // boundaries keep it from matching an unrelated identifier.
    expect(
      /import\s*\{[^}]*\bduyaAgent\b[^}]*\}\s*from/i.test(src),
      'runAgent.ts must not value-import DuyaAgent (use a whole-statement `import type`)',
    ).toBe(false);
    expect(
      /(?:import\s*\(|from\s*)['"][^'"]*builtin\.js['"]/.test(src),
      'runAgent.ts must not reference builtin.js; the registry factory is injected',
    ).toBe(false);
  });

  it('the cycle-edge regexes still match the shapes they claim to forbid', () => {
    // Self-test for the assertion above. A guard that cannot fire is worse than
    // no guard, because it reads as coverage. Each sample below is exactly one
    // of the two cycle-closing edges; if the regexes stop matching them, this
    // test goes red BEFORE the real code is allowed to drift.
    const duyaAgentEdge = /import\s*\{[^}]*\bduyaAgent\b[^}]*\}\s*from/i;
    const builtinEdge = /(?:import\s*\(|from\s*)['"][^'"]*builtin\.js['"]/;

    const liveSamples = [
      // The exported class is lower-camel `duyaAgent`; the guard is
      // case-sensitive, so both spellings are asserted to be caught. Writing
      // only `DuyaAgent` here is what a wrong-looking-but-passing sample looks
      // like, and it is why the positive samples are explicit rather than
      // generated from the source.
      "import { duyaAgent } from '../agent/DuyaAgent.js';",
      "import { DuyaAgent } from '../agent/DuyaAgent.js';",
      "const r = await import('../builtin.js');",
      "import { createBuiltinRegistry } from '../tool/builtin.js';",
      "import { createBuiltinRegistry } from './builtin.js';",
    ];
    for (const sample of liveSamples) {
      const stripped = stripComments(sample);
      expect(
        duyaAgentEdge.test(stripped) || builtinEdge.test(stripped),
        `stripComments destroyed a live specifier: ${sample}`,
      ).toBe(true);
    }

    // And the negative direction: the shapes that are ALLOWED must not match,
    // so the guard is not simply matching everything.
    const safeSamples = [
      "import type { CreateSubAgent } from './deps.js';",
      '// a comment mentioning builtin.js must not trip the guard',
      '/* builtin.js in a block comment */',
      "import { createSubAgent, createToolRegistry } from './deps.js';",
    ];
    for (const sample of safeSamples) {
      expect(
        duyaAgentEdge.test(stripComments(sample)) || builtinEdge.test(stripComments(sample)),
        `stripComments left a false positive: ${sample}`,
      ).toBe(false);
    }
  });
});