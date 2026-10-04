#!/usr/bin/env node
/**
 * check-packaged-artifacts.mjs — gate the packaged artifacts the root
 * AGENTS.md "Agent Bundle (MUST FOLLOW)" pre-release checklist names.
 *
 * WHY THIS EXISTS
 * ---------------
 * Plan 587 E4.4 bullet 3 requires: "每次 lazy/module boundary 变化打包检查
 * agent bundle / assets / BashWorker / native SQLite; first chat to ready,
 * no module missing." The checklist in AGENTS.md names three exact paths.
 * Before this script those three paths were asserted by *nothing* except a
 * human reading a checklist: `scripts/after-pack.js` FATALs on the agent
 * entry and on `better_sqlite3.node` but never looks at BashWorker, and
 * `scripts/verify-packaged-parity.mjs` does not list BashWorker either. A
 * checklist item no code checks is a comment, not a gate.
 *
 * The failure this catches is specific and expensive to find late. The agent
 * bundle is a single esbuild CJS file with `bundle: true`; anything esbuild
 * inlines needs no packaging step, and anything marked `external` needs a
 * matching copy under `resources/agent-bundle/` or the first tool call dies
 * with MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND. Nothing in the test suite
 * exercises the packaged tree, so only a check against real packaging output
 * can see it.
 *
 * THREE MODES, DELIBERATELY SEPARATE
 * ---------------------------------
 *   default (static)  Reads source only. No dist, no release tree, no
 *                     Electron. Sub-second, so it can run on every module
 *                     boundary change and in CI. It gates the *contract*:
 *                     which externals are allowed, that the bundle stays
 *                     CommonJS, that the production resolver still prefers
 *                     `resources/agent-bundle/agent-process-entry.js`, and
 *                     that every file the runtime resolves inside the bundle
 *                     directory has a build step that actually emits it.
 *
 *   --bundle          Inspects the STAGED `packages/agent/bundle/` tree that
 *                     electron-builder copies into resources/. Needs
 *                     `npm run bundle:agent` first, but not a package. This
 *                     is the only mode that sees esbuild's real output, so it
 *                     is the one that can prove self-containment and the
 *                     CommonJS marker. It is NOT a packaging pass: the staged
 *                     tree is an input to packaging, not its output, and every
 *                     run says so.
 *
 *   --packaged        Inspects a REAL `release/<platform>` tree produced by
 *                     `electron:pack`, and loads the native module with the
 *                     packaged Electron binary. Requires ~GB of disk and a
 *                     completed package, so it is NOT on the default path.
 *
 * WHAT THIS DOES NOT CLAIM
 * ------------------------
 * No mode proves "first packaged chat turn reaches Agent ready". That needs a
 * live provider key and a real package, and no static check can stand in for
 * it — a mock without a wire path proves nothing about the host boundary.
 * `--packaged` reports that check as `unverified` with its reason rather than
 * passing a cheaper proxy off as success. See the `UNVERIFIABLE` list in
 * `main()`.
 *
 * KNOWN DEFECTS
 * -------------
 * A pre-existing defect on master must not turn this gate permanently red —
 * a gate that is always red is a gate nobody reads. Findings that match an
 * entry in `packaged-artifact-baseline.json` are reported as `known-defect`,
 * loudly and by name, and do not fail the run; anything unregistered fails.
 * The registry records the evidence and the removal criterion, so a fixed
 * defect has to be deleted from the baseline to be believed. The OK message
 * always states how many known defects remain open: a known defect is never
 * counted as a pass.
 *
 * Usage:
 *   node scripts/check-packaged-artifacts.mjs            # static (CI)
 *   node scripts/check-packaged-artifacts.mjs --json
 *   node scripts/check-packaged-artifacts.mjs --bundle    # needs bundle:agent
 *   node scripts/check-packaged-artifacts.mjs --packaged  # needs a real package
 *   node scripts/check-packaged-artifacts.mjs --packaged --platform mac
 *
 * Exit codes: 0 clean (known defects allowed), 1 finding, 2 gate could not run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'packaged-artifact-baseline.json');

/** The esbuild config that defines what is inlined vs. left to runtime. */
const BUNDLE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-agent-bundle.mjs');
/** Packaged-path resolver for the agent entry (main process). */
const PROCESS_MANAGER = path.join(
  REPO_ROOT,
  'apps/desktop/src/main/agents/process-pool/process-manager.ts',
);
/** Runtime resolver for the bash worker child process (inside the bundle). */
const WORKER_POOL = path.join(REPO_ROOT, 'packages/agent/src/tool/WorkerPool.ts');

/**
 * The externals the current build is allowed to leave unbundled.
 *
 * This is a ratchet, not a wish list. `AGENTS.md` says only `better-sqlite3`
 * and the BashWorker worker stay external; the build actually marks six
 * packages external, and four of them are load-bearing for packaged runtime:
 * `better-sqlite3` (native), `playwright` (after-pack.js copies it into
 * `agent-bundle/node_modules/` and FATALs if it is missing), `esbuild`
 * (dwf transpiles workflow scripts at runtime and degrades to a typed error
 * when the require fails), `fsevents` (macOS-only, never installed on
 * Windows), and the two `chromium-bidi` deep paths the browser daemon
 * imports. Each addition needs a matching producer; each removal needs the
 * producer to go with it. See BASELINE for the drift this has already had.
 */
export const ALLOWED_EXTERNALS = [
  'better-sqlite3',
  'chromium-bidi/lib/cjs/bidiMapper/BidiMapper',
  'chromium-bidi/lib/cjs/cdp/CdpConnection',
  'esbuild',
  'fsevents',
  'playwright',
];

/** Format the agent bundle must be emitted in. CJS, per AGENTS.md. */
export const REQUIRED_BUNDLE_FORMAT = 'cjs';

/**
 * The primary packaged location of the agent entry, relative to
 * `process.resourcesPath`. Probed first by `getAgentProcessPath()`.
 */
export const PRIMARY_AGENT_ENTRY = 'agent-bundle/agent-process-entry.js';

/**
 * Files the agent resolves *inside the bundle directory* at runtime.
 *
 * Each entry pairs the relative path with the source that resolves it. The
 * gate then asks the question nothing else asks: does a build step actually
 * emit that file into the bundle directory? `assets/` is produced by
 * `build-agent-bundle.mjs`; `BashTool/BashWorker.js` is not produced by
 * anything, which is the open defect recorded in the baseline.
 */
export const BUNDLE_FILE_CONTRACTS = [
  {
    id: 'prompt-assets',
    relativePath: 'assets',
    kind: 'directory',
    resolvedBy: 'packages/agent/src/prompts/hbs/HbsPromptSystem.ts',
    producer: 'scripts/build-agent-bundle.mjs',
  },
  {
    id: 'bash-worker',
    relativePath: 'BashTool/BashWorker.js',
    kind: 'file',
    resolvedBy: 'packages/agent/src/tool/WorkerPool.ts',
    producer: '(none found)',
  },
];

/**
 * Build and packaging sources scanned when asking "does a producer emit this
 * path into the bundle directory?".
 */
const PRODUCER_SOURCES = [
  'scripts/build-agent-bundle.mjs',
  'scripts/after-pack.js',
  'scripts/build-electron.mjs',
  'electron-builder.yml',
];

// ---------------------------------------------------------------------------
// Pure helpers. Exported so scripts/check-packaged-artifacts.test.ts can pin
// the parsing rules without building a bundle or a package.
// ---------------------------------------------------------------------------

/**
 * Remove `//` and block comments from JS source.
 *
 * The esbuild config documents each external inline, so the array cannot be
 * read as a bare string list.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Read the `external: [...]` list out of an esbuild config source.
 *
 * @param {string} source
 * @returns {string[]} declared externals, in source order
 * @throws {Error} when the `external:` key is absent or unterminated
 */
export function extractExternals(source) {
  const cleaned = stripJsComments(source);
  const key = cleaned.indexOf('external:');
  if (key === -1) throw new Error('no `external:` key in the esbuild config');
  const open = cleaned.indexOf('[', key);
  const close = cleaned.indexOf(']', open);
  if (open === -1 || close === -1) throw new Error('could not parse the `external:` array');

  const out = [];
  for (const match of cleaned.slice(open, close).matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    out.push(match[2]);
  }
  return out;
}

/**
 * Read the `format:` string out of an esbuild config source.
 *
 * @param {string} source
 * @returns {string|null}
 */
export function extractFormat(source) {
  const cleaned = stripJsComments(source);
  const match = cleaned.match(/\bformat:\s*(['"])([^'"]+)\1/);
  return match ? match[2] : null;
}

/**
 * Collect the `path.join(...)` calls inside one function, keeping only the
 * trailing string-literal segments of each.
 *
 * This is how a resolver's candidate paths are recovered from source without
 * evaluating it. `path.join(process.resourcesPath, 'agent-bundle', 'entry.js')`
 * yields `agent-bundle/entry.js`; a call that starts with a variable yields
 * the literals after it, which is what makes the ordering check meaningful.
 *
 * @param {string} source
 * @param {string} functionName
 * @returns {string[]} normalized relative paths, in source order
 */
export function extractJoinedPathLiterals(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  if (start === -1) throw new Error(`no \`function ${functionName}\` in source`);

  // The function ends at the next top-level `}` that closes it. Counting
  // braces is enough here because neither resolver nests a brace inside a
  // template literal or a regex literal.
  let depth = 0;
  let end = -1;
  let seen = false;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
      seen = true;
    } else if (source[i] === '}') {
      depth -= 1;
      if (seen && depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`could not find the end of \`${functionName}\``);
  const body = source.slice(start, end);

  const out = [];
  for (const match of body.matchAll(/path\.join\(([^)]*)\)/g)) {
    const segments = [...match[1].matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
    // A join of only literals is a real path; one that leads with a variable
    // is a base directory we deliberately drop.
    if (segments.length === 0) continue;
    out.push(segments.join('/'));
  }
  return out;
}

/**
 * Classify every `require()` in a CommonJS bundle.
 *
 * Self-containment is the whole point: a bare specifier that is neither a
 * Node builtin nor a declared external can only resolve through a
 * `node_modules` directory, and the packaged bundle has none (after-pack.js
 * copies exactly one, `playwright`). Those are the requires that turn into
 * MODULE_NOT_FOUND in a shipped app.
 *
 * @param {string} bundleText
 * @param {string[]} externals declared esbuild externals
 * @returns {{builtins: string[], externals: string[], relative: string[],
 *            thirdParty: string[], dynamic: number}}
 */
export function classifyRequires(bundleText, externals) {
  const builtins = new Set(builtinModules);
  const result = {
    builtins: [],
    externals: [],
    relative: [],
    thirdParty: [],
    dynamic: 0,
  };

  // A plain regex over the bundle text cannot be trusted here, and trusting it
  // produces a false positive that is worse than no check at all. The agent
  // bundle contains ajv, whose runtime keyword modules set
  // `equal.code = 'require("ajv/dist/runtime/equal").default'` — a string that
  // ajv pastes into a code generator at validation time. Those four specifiers
  // are real text in the bundle and are NOT requires; a regex reports them as
  // unresolvable dependencies and accuses a healthy build. So the scan is a
  // small lexer that only looks at `require(` occurring in code position,
  // outside strings, template literals and comments.
  scanBundleForRequires(bundleText, (spec) => {
    if (spec === null) {
      result.dynamic += 1;
      return;
    }
    if (spec.startsWith('node:') || builtins.has(spec)) {
      pushUnique(result.builtins, spec);
    } else if (externals.some((e) => spec === e || spec.startsWith(`${e}/`))) {
      pushUnique(result.externals, spec);
    } else if (spec.startsWith('.') || path.isAbsolute(spec)) {
      pushUnique(result.relative, spec);
    } else {
      pushUnique(result.thirdParty, spec);
    }
  });

  return result;
}

/**
 * Walk a CommonJS bundle and report each `require()` that appears in code
 * position.
 *
 * `onSpecifier` receives the decoded specifier, or `null` for a call whose
 * argument is not a plain string literal (a computed require).
 *
 * Known limits, stated rather than hidden: a `/` is read as division, so a
 * regular-expression literal containing the text `require("...")` would be
 * misread. No such literal exists in the agent bundle today, and the failure
 * direction is a false report rather than a missed one.
 *
 * @param {string} text
 * @param {(spec: string|null) => void} onSpecifier
 */
export function scanBundleForRequires(text, onSpecifier) {
  const isIdent = (ch) => ch !== undefined && /[$\w]/.test(ch);

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    // Comments.
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
      continue;
    }

    // String and template literals: consume them whole so their contents are
    // never mistaken for code.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let value = '';
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          value += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        if (text[i] === '\n' && quote !== '`') break;
        value += text[i];
        i += 1;
      }
      // A template literal can hold `${...}` with real code inside it. This
      // gate only needs to see the `require(` token, so the substitution is
      // left to the outer loop: skipping to the closing backtick is enough
      // because an interpolated require is, by construction, not a literal
      // specifier this gate can classify.
      continue;
    }

    // A `require` / `__require` identifier in code position. `__require` is
    // esbuild's own indirection shim for a require that may be absent; it is
    // the same resolution question, so it counts too.
    const name = text.startsWith('__require', i)
      ? '__require'
      : text.startsWith('require', i) ? 'require' : null;
    if (name === null) continue;
    if (isIdent(text[i - 1])) continue; // tail of a longer identifier, e.g. myrequire(
    let j = i + name.length;
    if (text[j] !== '(') continue; // a reference, not a call
    j += 1;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (j < text.length && (text[j] === '"' || text[j] === "'")) {
      const quote = text[j];
      let value = '';
      let k = j + 1;
      while (k < text.length) {
        if (text[k] === '\\') {
          value += text[k + 1] ?? '';
          k += 2;
          continue;
        }
        if (text[k] === quote) break;
        value += text[k];
        k += 1;
      }
      onSpecifier(value);
      i = k;
    } else {
      onSpecifier(null);
      // Skip to the matching close paren so an identifier inside the
      // arguments is not rescanned as a call site.
      let depth = 1;
      let m = j;
      while (m < text.length && depth > 0) {
        if (text[m] === '(') depth += 1;
        else if (text[m] === ')') depth -= 1;
        m += 1;
      }
      i = m - 1;
    }
  }
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

/**
 * Choose the release resources directory for a platform/arch pair.
 *
 * @param {{platform?: string, arch?: string, releaseDir?: string}} options
 * @returns {string} absolute path to the packaged `resources` directory
 */
export function resolveReleaseResourcesDir({ platform = process.platform, arch, releaseDir } = {}) {
  const base = releaseDir ?? path.join(REPO_ROOT, 'release');
  const targetArch = arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  if (platform === 'darwin') {
    const appDir = targetArch === 'arm64' ? 'mac-arm64' : 'mac';
    return path.join(base, appDir, 'DUYA.app', 'Contents', 'Resources');
  }
  if (platform === 'linux') {
    return path.join(base, 'linux-unpacked', 'resources');
  }
  return path.join(base, 'win-unpacked', 'resources');
}

// ---------------------------------------------------------------------------
// Static checks — source only, no build output required.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Finding
 * @property {string} check
 * @property {'missing'|'unexpected'} kind
 * @property {string} message
 * @property {string} [evidence]
 */

/** @returns {Finding[]} */
export function runStaticChecks() {
  /** @type {Finding[]} */
  const findings = [];

  const bundleSource = readFileSync(BUNDLE_SCRIPT, 'utf8');

  // 1. Externals are exactly the allowlist. A new external is only safe if a
  //    matching copy lands under resources/agent-bundle/; a removed one means
  //    the producer that copied it is now dead weight at best.
  const externals = extractExternals(bundleSource);
  const missing = ALLOWED_EXTERNALS.filter((e) => !externals.includes(e));
  const unexpected = externals.filter((e) => !ALLOWED_EXTERNALS.includes(e));
  if (missing.length > 0 || unexpected.length > 0) {
    findings.push({
      check: 'esbuild-externals-allowlist',
      kind: missing.length > 0 ? 'missing' : 'unexpected',
      message:
        `external list in scripts/build-agent-bundle.mjs drifted from the allowlist`
        + `${missing.length ? ` — no longer external: ${missing.join(', ')}` : ''}`
        + `${unexpected.length ? ` — newly external: ${unexpected.join(', ')}` : ''}`,
      evidence: `declared: ${externals.join(', ') || '(none)'}`,
    });
  }

  // 2. The bundle must stay CommonJS. The subprocess is spawned by
  //    `process.execPath` with ELECTRON_RUN_AS_NODE=1, which loads it as a
  //    script; an ESM bundle would need a .mjs extension or a type: module
  //    marker, and `type: commonjs` is what the build writes.
  const format = extractFormat(bundleSource);
  if (format !== REQUIRED_BUNDLE_FORMAT) {
    findings.push({
      check: 'bundle-format',
      kind: 'unexpected',
      message: `agent bundle format is ${format ?? '(unset)'}, expected '${REQUIRED_BUNDLE_FORMAT}'`,
      evidence: 'scripts/build-agent-bundle.mjs `format:` key',
    });
  }

  // 3. Production must resolve the bundled entry first. The two paths after
  //    it are debug-only fallbacks; if one is promoted above the bundle the
  //    release silently stops testing the artifact it actually ships.
  const managerSource = readFileSync(PROCESS_MANAGER, 'utf8');
  const candidates = extractJoinedPathLiterals(managerSource, 'getAgentProcessPath');
  if (candidates.length === 0 || candidates[0] !== PRIMARY_AGENT_ENTRY) {
    findings.push({
      check: 'agent-entry-resolution-order',
      kind: 'unexpected',
      message: `getAgentProcessPath() does not resolve ${PRIMARY_AGENT_ENTRY} first`,
      evidence: `packaged candidates in order: ${candidates.join(' | ') || '(none parsed)'}`,
    });
  }

  // 4. Every file the agent resolves inside the bundle directory must be
  //    emitted by a build step. This is the check that was missing: a
  //    resolver can name a path that nothing ever writes, and the failure
  //    only shows up as a spawn error after the app is installed.
  const producerText = PRODUCER_SOURCES.map((rel) => {
    const abs = path.join(REPO_ROOT, rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  }).join('\n');
  const workerPoolSource = readFileSync(WORKER_POOL, 'utf8');

  for (const contract of BUNDLE_FILE_CONTRACTS) {
    const resolverSource =
      contract.resolvedBy === 'packages/agent/src/tool/WorkerPool.ts'
        ? workerPoolSource
        : readFileSync(path.join(REPO_ROOT, contract.resolvedBy), 'utf8');

    const segments = contract.relativePath.split('/');
    const declaredByResolver = segments.every((seg) => resolverSource.includes(`'${seg}'`));
    if (!declaredByResolver) {
      // The resolver no longer asks for this file. The contract is stale, not
      // the build — say so instead of guessing which side is wrong.
      findings.push({
        check: `bundle-file-contract:${contract.id}`,
        kind: 'unexpected',
        message: `${contract.relativePath} is listed as a bundle file contract but `
          + `${contract.resolvedBy} no longer references it; delete the contract entry`,
      });
      continue;
    }

    const producedByAnyBuildStep = segments.every((seg) => producerText.includes(seg));
    if (!producedByAnyBuildStep) {
      findings.push({
        check: `bundle-file-contract:${contract.id}`,
        kind: 'missing',
        message: `the agent resolves ${contract.relativePath} inside the bundle directory, `
          + `but no build step emits it into packages/agent/bundle/`,
        evidence: `resolver: ${contract.resolvedBy}; producers scanned: ${PRODUCER_SOURCES.join(', ')}`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Packaged checks — need a real `release/<platform>` tree.
// ---------------------------------------------------------------------------

/** The three paths AGENTS.md's pre-release checklist names. */
export const CHECKLIST_ARTIFACTS = [
  { id: 'agent-entry', rel: 'agent-bundle/agent-process-entry.js' },
  { id: 'bash-worker', rel: 'agent-bundle/BashTool/BashWorker.js' },
  { id: 'native-sqlite', rel: 'better-sqlite3/build/Release/better_sqlite3.node' },
];

/**
 * Check the STAGED bundle directory (`packages/agent/bundle/`), i.e. the tree
 * `electron-builder.yml` copies verbatim into `resources/agent-bundle/`.
 *
 * This sits between the two other modes. Static mode reads source, so it
 * proves the build contract but never sees esbuild's actual output;
 * `--packaged` sees the real thing but needs a multi-GB package. This mode
 * answers the question source cannot: is the bundle esbuild really produced
 * self-contained CommonJS, with every file the agent resolves present next to
 * it?
 *
 * It is NOT a substitute for `--packaged`. The staged tree is an INPUT to
 * packaging, not its output, so what electron-builder copies, and what
 * after-pack.js adds or fails to add, stays unproven here.
 *
 * @param {{bundleDir?: string}} [options]
 * @returns {{findings: Finding[], bundleDir: string}}
 */
export function runBundleChecks(options = {}) {
  const bundleDir = options.bundleDir ?? path.join(REPO_ROOT, 'packages', 'agent', 'bundle');
  /** @type {Finding[]} */
  const findings = [];
  const entry = path.join(bundleDir, 'agent-process-entry.js');

  if (!existsSync(entry)) {
    findings.push({
      check: 'bundle-entry-built',
      kind: 'missing',
      message: `no agent bundle at ${entry}`,
      evidence: 'run `npm run bundle:agent` first',
    });
    return { findings, bundleDir };
  }
  if (statSync(entry).size === 0) {
    findings.push({
      check: 'bundle-entry-built',
      kind: 'missing',
      message: 'the built agent bundle is zero bytes',
    });
  }

  // The CommonJS marker. The subprocess is spawned with
  // ELECTRON_RUN_AS_NODE=1, which resolves the format from the nearest
  // package.json, so a missing or wrong marker is a load failure, not a style
  // problem.
  const markerPath = path.join(bundleDir, 'package.json');
  if (!existsSync(markerPath)) {
    findings.push({
      check: 'bundle-cjs-marker',
      kind: 'missing',
      message: `no CommonJS marker package.json in ${bundleDir}`,
      evidence: 'build-agent-bundle.mjs writes it; without it the bundle format is unresolvable',
    });
  } else {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.type !== 'commonjs') {
      findings.push({
        check: 'bundle-cjs-marker',
        kind: 'missing',
        message: `bundle marker declares type "${marker.type ?? '(unset)'}", expected "commonjs"`,
        evidence: markerPath,
      });
    }
  }

  // Self-containment, against the real esbuild output rather than the source.
  const externals = extractExternals(readFileSync(BUNDLE_SCRIPT, 'utf8'));
  const classified = classifyRequires(readFileSync(entry, 'utf8'), externals);
  if (classified.thirdParty.length > 0) {
    findings.push({
      check: 'bundle-self-contained',
      kind: 'missing',
      message: `the built bundle requires ${classified.thirdParty.join(', ')}, which resolves `
        + 'only through a node_modules the package does not ship',
      evidence: `externals resolved at runtime: ${classified.externals.join(', ') || '(none)'}`,
    });
  }
  if (classified.relative.length > 0) {
    findings.push({
      check: 'bundle-self-contained',
      kind: 'missing',
      message: `the built bundle still requires relative paths `
        + `(${classified.relative.slice(0, 5).join(', ')}), which esbuild should have inlined`,
    });
  }
  if (classified.dynamic > 0) {
    // Not a build failure: a computed require cannot be resolved statically.
    // It is reported so the blind spot stays visible instead of being assumed
    // safe by silence.
    findings.push({
      check: 'bundle-self-contained',
      kind: 'missing',
      message: `${classified.dynamic} non-literal require(s) in the built bundle cannot be `
        + 'checked statically; self-containment is proven only for the literal ones',
    });
  }

  // Every file the agent resolves inside the bundle directory must be here.
  for (const contract of BUNDLE_FILE_CONTRACTS) {
    const abs = path.join(bundleDir, ...contract.relativePath.split('/'));
    if (!existsSync(abs)) {
      findings.push({
        check: `bundle-file-contract:${contract.id}`,
        kind: 'missing',
        message: `${contract.relativePath} is resolved by ${contract.resolvedBy} but is absent `
          + `from the built bundle at ${abs}`,
      });
    }
  }

  return { findings, bundleDir };
}

/**
 * Load the packaged native module with the PACKAGED Electron binary.
 *
 * This is the honest ABI check. better-sqlite3 13.x ships NAPI prebuilds,
 * which are ABI-stable across Node and Electron, so comparing a
 * NODE_MODULE_VERSION against Electron's is not the right question to ask —
 * the question is whether the shipped `.node` actually loads in the shipped
 * runtime, and that is answered by loading it.
 *
 * @param {string} resourcesDir
 * @param {string} platform
 * @returns {{status: 'ok'|'fail'|'unverified', detail: string}}
 */
export function verifyNativeLoad(resourcesDir, platform = process.platform) {
  const nodeFile = path.join(
    resourcesDir,
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  const exe = findPackagedElectron(path.dirname(resourcesDir), platform);
  if (!exe) {
    return {
      status: 'unverified',
      detail: 'packaged Electron binary not found next to resources/; the native module was '
        + 'not loaded, so its ABI is UNPROVEN (run from the unpacked release directory)',
    };
  }
  const script = `require(${JSON.stringify(nodeFile)});`
    + `process.stdout.write('modules=' + process.versions.modules);`;
  const proc = spawnSync(exe, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 120000,
  });
  if (proc.error || proc.status !== 0) {
    return {
      status: 'fail',
      detail: `loading better_sqlite3.node under packaged Electron failed: `
        + `${(proc.stderr || proc.error?.message || 'unknown').toString().trim().split('\n')[0]}`,
    };
  }
  return {
    status: 'ok',
    detail: `loaded under packaged Electron (${(proc.stdout || '').trim() || 'no version banner'})`,
  };
}

/**
 * @param {string} appOutDir the unpacked app directory (parent of resources/)
 * @param {string} platform
 * @returns {string|null} path to the packaged Electron executable
 */
function findPackagedElectron(appOutDir, platform) {
  if (platform === 'darwin') {
    const mac = path.join(appOutDir, '..', 'MacOS', 'DUYA');
    return existsSync(mac) ? mac : null;
  }
  const candidates = ['DUYA.exe', 'duya.exe', 'electron.exe'];
  for (const name of candidates) {
    const abs = path.join(appOutDir, name);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * @param {{platform?: string, arch?: string, releaseDir?: string}} options
 * @returns {{findings: Finding[], unverified: {id: string, detail: string}[], resourcesDir: string}}
 */
export function runPackagedChecks(options = {}) {
  const platform = options.platform ?? process.platform;
  const resourcesDir = resolveReleaseResourcesDir({ ...options, platform });
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{id: string, detail: string}[]} */
  const unverified = [];

  if (!existsSync(resourcesDir)) {
    findings.push({
      check: 'packaged-resources-dir',
      kind: 'missing',
      message: `no packaged resources directory at ${resourcesDir}`,
      evidence: 'run `npm run electron:pack` (win) / `electron:pack:mac` first',
    });
    return { findings, unverified, resourcesDir };
  }

  for (const artifact of CHECKLIST_ARTIFACTS) {
    const abs = path.join(resourcesDir, ...artifact.rel.split('/'));
    if (!existsSync(abs)) {
      findings.push({
        check: `packaged-artifact:${artifact.id}`,
        kind: 'missing',
        message: `AGENTS.md pre-release checklist artifact missing: resources/${artifact.rel}`,
        evidence: `expected at ${abs}`,
      });
      continue;
    }
    const size = statSync(abs).size;
    if (size === 0) {
      findings.push({
        check: `packaged-artifact:${artifact.id}`,
        kind: 'missing',
        message: `packaged artifact is zero bytes: resources/${artifact.rel}`,
      });
    }
  }

  // Self-containment: scan the real bundle for bare requires that could only
  // resolve through a node_modules the packaged app does not have.
  const entryAbs = path.join(resourcesDir, 'agent-bundle', 'agent-process-entry.js');
  if (existsSync(entryAbs) && statSync(entryAbs).size > 0) {
    const externals = extractExternals(readFileSync(BUNDLE_SCRIPT, 'utf8'));
    const classified = classifyRequires(readFileSync(entryAbs, 'utf8'), externals);
    if (classified.thirdParty.length > 0) {
      findings.push({
        check: 'bundle-self-contained',
        kind: 'missing',
        message: `the packaged agent bundle requires ${classified.thirdParty.join(', ')}, `
          + 'which resolves only through a node_modules the package does not ship',
        evidence: `resolved externals present: ${classified.externals.join(', ') || '(none)'}`,
      });
    }
    if (classified.relative.length > 0) {
      findings.push({
        check: 'bundle-self-contained',
        kind: 'missing',
        message: `the packaged agent bundle still requires relative paths `
          + `(${classified.relative.slice(0, 5).join(', ')}), which esbuild should have inlined`,
      });
    }
  }

  // Native ABI: load it with the packaged runtime, or say why we could not.
  const nativeFile = path.join(
    resourcesDir,
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (existsSync(nativeFile)) {
    const load = verifyNativeLoad(resourcesDir, platform);
    if (load.status === 'fail') {
      findings.push({ check: 'native-sqlite-abi', kind: 'missing', message: load.detail });
    } else if (load.status === 'unverified') {
      unverified.push({ id: 'native-sqlite-abi', detail: load.detail });
    } else {
      process.stdout.write(`  native-sqlite-abi: ${load.detail}\n`);
    }
  }

  return { findings, unverified, resourcesDir };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function loadKnownDefects() {
  if (!existsSync(BASELINE_PATH)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`baseline unreadable (${err.message}); fix or delete it`);
  }
  return Array.isArray(parsed.defects) ? parsed.defects : [];
}

/**
 * Checks this gate can never prove, no matter how it is run. Listed so the
 * gate never implies more than it does.
 */
const UNVERIFIABLE = [
  {
    id: 'first-packaged-chat-to-ready',
    detail: 'needs a live provider key and a completed package; run the packaged app manually',
  },
  {
    id: 'app-log-has-no-ERR_MODULE_NOT_FOUND',
    detail: 'only observable from a running packaged app, in %APPDATA%/DUYA/logs/app.log',
  },
];

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const packaged = argv.includes('--packaged');
  const bundle = argv.includes('--bundle');
  const platformIndex = argv.indexOf('--platform');
  const platform = platformIndex === -1 ? undefined : argv[platformIndex + 1];
  const archIndex = argv.indexOf('--arch');
  const arch = archIndex === -1 ? undefined : argv[archIndex + 1];
  const out = (line) => {
    if (!asJson) process.stdout.write(line);
  };

  let findings;
  /** @type {{id: string, detail: string}[]} */
  let unverified = [];
  try {
    if (packaged) {
      const result = runPackagedChecks({ platform, arch });
      findings = result.findings;
      unverified = result.unverified;
      out(`check-packaged-artifacts: packaged resources at ${result.resourcesDir}\n`);
    } else if (bundle) {
      const result = runBundleChecks();
      findings = result.findings;
      out(`check-packaged-artifacts: staged bundle at ${result.bundleDir}\n`);
      // The staged tree is an input to packaging, never its output. Say so on
      // every run, so a green --bundle can never be quoted as a packaging pass.
      unverified.push({
        id: 'packaging-output',
        detail: 'packages/agent/bundle/ is what electron-builder COPIES; what the installed '
          + 'resources/ tree actually contains is only proven by --packaged',
      });
    } else {
      findings = runStaticChecks();
      out('check-packaged-artifacts: static mode (no build output required)\n');
    }
  } catch (err) {
    process.stderr.write(`check-packaged-artifacts: gate could not run: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const known = loadKnownDefects();
  const knownChecks = new Set(known.map((d) => d.check));

  const knownDefects = findings.filter((f) => knownChecks.has(f.check));
  const fresh = findings.filter((f) => !knownChecks.has(f.check));

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: packaged ? 'packaged' : bundle ? 'bundle' : 'static',
          fresh,
          knownDefects: knownDefects.map((f) => ({
            ...f,
            defect: known.find((d) => d.check === f.check),
          })),
          unverified: [...unverified, ...(packaged ? [] : UNVERIFIABLE)],
        },
        null,
        2,
      )}\n`,
    );
  }

  for (const defect of knownDefects) {
    const entry = known.find((d) => d.check === defect.check);
    out(`  KNOWN-DEFECT ${defect.check}: ${defect.message}\n`);
    if (entry?.summary) out(`    tracked as ${entry.id} — ${entry.summary}\n`);
  }
  for (const finding of fresh) {
    process.stderr.write(`  FAIL ${finding.check}: ${finding.message}\n`);
    if (finding.evidence) process.stderr.write(`    evidence: ${finding.evidence}\n`);
  }

  if (fresh.length > 0) {
    process.stderr.write(
      `\ncheck-packaged-artifacts: ${fresh.length} finding(s) not in the known-defect baseline.\n`
      + '  A packaged artifact the runtime needs is either missing or drifted from the\n'
      + '  build contract. Fix the packaging, or record the defect in\n'
      + '  scripts/packaged-artifact-baseline.json with its evidence.\n',
    );
    process.exitCode = 1;
    return;
  }

  const defectNote = knownDefects.length > 0
    ? `, ${knownDefects.length} known defect(s) still open (not counted as passes)`
    : '';
  out(`check-packaged-artifacts: OK — 0 new findings${defectNote}.\n`);

  for (const item of [...unverified, ...(packaged ? [] : UNVERIFIABLE)]) {
    out(`  UNVERIFIED ${item.id}: ${item.detail}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
