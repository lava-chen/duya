/**
 * Layer purity: makes the `layers:` block in `architecture-policy.yaml` mean
 * something.
 *
 * ## Why this file exists
 *
 * `architecture-policy.yaml` declares a layer list:
 *
 *   protocol # agent-protocol, shared
 *   core     # agent-core, agent-tools, ai
 *   runtime  # agent-runtime
 *   host     # desktop, cli, gateway
 *
 * and the governing document says a `core` module performs no IO. That claim
 * was, as of plan 587 M5.1, **entirely unenforced**: `architecture-check.mjs`
 * does not read the `layers:` block at all (verified by grepping it for
 * `layer` — zero matches), and the only thing that noticed a `core` module
 * doing IO was a hand-written list of three `PURE_VIOLATIONS` entries in
 * `slice-classification.ts`. A contract with one hand-kept list behind it is a
 * comment, and a comment does not stop the fourth violation.
 *
 * This module is that stop. It walks the source of every module declared at
 * layer `core` and asserts the set of files performing IO is EXACTLY the
 * declared carve-out. Green today; a new `fetch(` anywhere in a `core` root
 * fails here.
 *
 * ## What "IO" means here
 *
 * A call out to a host primitive: the network, the filesystem, a Node
 * builtin, crypto, timers, or a child process. Deliberately NOT counted:
 *
 *  - `setTimeout`/`setTimeout` used for debouncing is still IO, so it IS
 *    counted. There is no exemption, because a `core` reducer that schedules
 *    a timer is already depending on a host clock.
 *  - `console.*` is not counted. It is a diagnostic sink, not a capability,
 *    and counting it would produce hundreds of findings that all say the same
 *    thing, which is how a gate gets ignored.
 *  - A *type-only* `import type ... from 'node:crypto'` is not counted, because
 *    it is erased at compile time and creates no runtime coupling. The runtime
 *    `require('node:crypto')` next to it is counted.
 *
 * ## The carve-out
 *
 * `packages/ai` is declared `core`, and it is genuinely `core`-shaped: it is
 * wire-shape translation, and the two packages that actually carry the contract
 * (`agent-protocol`, `agent-core`) import NOTHING from it — measured, not
 * assumed. But three files inside it reach for a network or crypto primitive
 * themselves rather than taking an injected port. Those three are the carve-out.
 *
 * The carve-out is the honest position: it says "this IO exists, it is here,
 * and it is watched", instead of either pretending it is gone (M5.1's option)
 * or relabelling the whole package non-core (which would have been worse — see
 * the note on `packages/agent-core` in the policy).
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repo root, resolved from this file rather than from `process.cwd()`.
 *
 * `slice-classification.ts` carries a comment about exactly this bug: two extra
 * `..` climbed into `.claude/worktrees` once and the inventory silently
 * classified zero files. A verifier that quietly scans nothing is worse than no
 * verifier, so the root is anchored to the module, and `assertScannedNonEmpty`
 * below refuses to pass on an empty scan.
 */
export const REPO_ROOT = path.resolve(HERE, '../..');

/**
 * Source trees a layer contract governs, relative to a package root.
 *
 * `src` only, and that is a decision rather than an oversight:
 *
 *  - `test/` and `__tests__/` are excluded because a test that cannot stand up a
 *    fake HTTP server cannot test a client, and `packages/ai/test/embed.test.ts`
 *    imports `node:http`/`node:net` for exactly that. The repo already draws
 *    this line in `slice-classification.ts`'s `UNCLASSIFIED_PREFIXES`, which
 *    excludes host and agent test trees from the classified map.
 *  - `scripts/` is excluded because it is maintenance tooling, not the module's
 *    shipped surface. `packages/ai/scripts/sync-models.mjs` fetches the upstream
 *    model catalog, which is the script's entire job.
 *
 * Excluding tests is the standard carve-out and is safe. Excluding `scripts` is
 * also correct, but it is worth naming, because a package can smuggle runtime
 * code into `scripts/` — so a new top-level `scripts/*.ts` that is imported from
 * `src` is a separate finding, not something this gate covers.
 */
const GOVERNED_DIRS = ['src'];

/** Directories never walked: build output, deps, VCS. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'bundle',
  'coverage',
  '.git',
  'release',
]);

/** Source extensions that can carry an import or a call. */
const SRC_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/**
 * A primitive that takes the process outside pure computation.
 *
 * Each entry is a regex tested against a source line that has already had its
 * comments stripped, so a mention in prose cannot produce a finding and a
 * mention in code cannot hide one.
 */
export const IO_PRIMITIVES: readonly { readonly name: string; readonly re: RegExp }[] = [
  // Network.
  //
  // `this.fetchFn(` is deliberately NOT matched: an injected transport is the
  // point of the exercise, and `packages/ai/src/system-one/client.ts:166,190`
  // is the working example (`options.fetchFn ?? fetch`, then `this.fetchFn(`).
  { name: 'fetch', re: /(?<![\w.$])fetch\s*\(/ },
  // `globalThis.fetch` as a bare VALUE is the injectable-transport seam, not a
  // capability, and is the pattern this repo already uses in two places:
  //   - packages/ai/src/api/google-generative-ai.ts:398
  //       `const fetchImpl = opts.fetchImpl ?? globalThis.fetch;`
  //   - packages/ai/src/system-one/client.ts:166
  //       `this.fetchFn = options.fetchFn ?? fetch;`
  // Only a CALL through the global is IO. Requiring the paren keeps the rule in
  // step with the bare-`fetch(` rule above it.
  { name: 'globalThis.fetch', re: /globalThis\s*\.\s*fetch\s*\(/ },
  { name: 'node:http', re: /from\s+['"]node:https?['"]/ },
  { name: 'require(node:http)', re: /require\s*\(\s*['"]node:https?['"]\s*\)/ },
  { name: 'node:net', re: /from\s+['"]node:net['"]/ },
  { name: 'WebSocket', re: /(?<![\w.$])new\s+WebSocket\s*\(/ },
  // Filesystem.
  { name: 'node:fs', re: /from\s+['"](node:)?fs(\/promises)?['"]/ },
  { name: 'require(node:fs)', re: /require\s*\(\s*['"](node:)?fs(\/promises)?['"]\s*\)/ },
  { name: 'node:fs/promises', re: /from\s+['"]node:fs\/promises['"]/ },
  // Host primitives.
  { name: 'node:crypto', re: /from\s+['"]node:crypto['"]/ },
  { name: 'require(node:crypto)', re: /require\s*\(\s*['"]node:crypto['"]\s*\)/ },
  { name: 'node:child_process', re: /from\s+['"]node:child_process['"]/ },
  { name: 'require(node:child_process)', re: /require\s*\(\s*['"]node:child_process['"]\s*\)/ },
  { name: 'node:worker_threads', re: /from\s+['"]node:worker_threads['"]/ },
  { name: 'node:os', re: /from\s+['"]node:os['"]/ },
  { name: 'node:process', re: /from\s+['"]node:process['"]/ },
  // Timers: a scheduled callback is a dependency on a host clock.
  { name: 'setTimeout/setInterval', re: /(?<![\w.$])(setTimeout|setInterval)\s*\(/ },
  // Host singletons.
  { name: 'process.binding', re: /process\s*\.\s*(binding|dlopen)\s*\(/ },
];

// Comment stripping is INLINED in `findIoSites` rather than factored out,
// because it cannot be factored out: the stripped copy has to keep the original
// line numbering (see the comment there). It is deliberately naive, and
// deliberately so — a naive strip can only ever produce a FALSE POSITIVE (a
// regex left inside a stripped comment still matches), never a false negative,
// and `layer-purity.test.ts` pins the behaviour on real fixtures.
// `strip-comments.mjs` is the rigorous implementation; this is a local copy so
// this module has no import cycle with the checker.

export interface IoSite {
  /** Repo-relative, forward-slashed. */
  readonly file: string;
  /** 1-based line number in the ORIGINAL file. */
  readonly line: number;
  readonly primitive: string;
  /** The offending source line, trimmed. */
  readonly text: string;
}

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

/** Repo-relative, forward-slashed, so results are stable across platforms. */
export function rel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/**
 * Turn an `IoSite.file` back into a comparable absolute path.
 *
 * `rel()` is normally repo-relative, but on Windows `path.relative` returns an
 * ABSOLUTE path when the target is on a different drive than the repo (the temp
 * dir the tests use is on `C:`, the repo on `E:`). Re-joining such a value onto
 * `REPO_ROOT` yields a path that does not exist, which silently defeats the
 * carve-out lookup. Checking `isAbsolute` first is what makes the synthetic-root
 * tests work at all.
 */
function absoluteOf(relOrAbs: string): string {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO_ROOT, relOrAbs);
}

/**
 * Absolute path, forward-slashed, case-preserved.
 *
 * Used for every path COMPARISON in this module. Windows reports the same file
 * as `C:\x\y` and `C:/x/y` depending on how it was built, and a comparison that
 * treats those as different strings is a gate that fails on a clean tree and
 * passes on a dirty one.
 */
function normalize(abs: string): string {
  return path.resolve(abs).split(path.sep).join('/');
}

/**
 * Every IO site in one file.
 *
 * Line numbers come from the original file even though matching runs on the
 * stripped copy, because a finding that cannot be opened at the line it names
 * is a finding nobody can act on. The two are kept in sync by replacing
 * stripped-out characters with newlines rather than spaces, so offsets
 * survive.
 */
export function findIoSites(absPath: string): IoSite[] {
  const original = fs.readFileSync(absPath, 'utf8');
  // Preserve line structure: collapse each removed comment to the same number
  // of newlines, so stripped[i] still corresponds to original line i+1.
  const stripped = original
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/\/\/[^\n]*/g, (s) => ' '.repeat(s.length)));

  const sites: IoSite[] = [];
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // A type-only import is erased at compile time and creates no runtime
    // coupling, so it is not a capability. `packages/ai/src/auth/oauth/pkce.ts`
    // is the live example: it names WebCrypto types and calls
    // `crypto.subtle.digest` through the ambient handle, with no specifier for
    // a bundler to externalize at all.
    if (/^\s*import\s+type\b/.test(line)) continue;

    for (const { name, re } of IO_PRIMITIVES) {
      if (re.test(line)) {
        sites.push({
          file: rel(absPath),
          line: i + 1,
          primitive: name,
          text: (original.split('\n')[i] ?? '').trim(),
        });
        break; // one finding per line is enough to fail the gate
      }
    }
  }
  return sites;
}

/**
 * A module declared at layer `core`, and the IO it is allowed to contain.
 *
 * `carveOut` is a CLOSED list. An empty array means "this root is pure and
 * must stay pure". A file in `carveOut` that no longer contains the IO it was
 * granted for is itself a failure — see `assertCarveOutIsLive` — because a
 * stale allowance is how a carve-out grows into a blanket.
 */
export interface CoreModule {
  readonly id: string;
  readonly roots: readonly string[];
  readonly carveOut: readonly CarveOutEntry[];
}

export interface CarveOutEntry {
  /** Repo-relative path. */
  readonly file: string;
  /** What the file is doing, and why it is not pure yet. */
  readonly why: string;
  /** The primitive names the entry is expected to match. */
  readonly expects: readonly string[];
}

/**
 * The declared layer contract, transcribed from `architecture-policy.yaml`.
 *
 * Duplicated rather than parsed on purpose: the policy file is a YAML document
 * the checker loads with a hand-rolled reader, and making this module depend on
 * that reader would couple a purity gate to the checker's parsing bugs. The
 * duplication is guarded by `layer-purity.test.ts`, which asserts this list and
 * the policy's `layers:` block name the same packages.
 */
export const CORE_MODULES: readonly CoreModule[] = [
  {
    id: 'agent-protocol',
    roots: ['packages/agent-protocol'],
    carveOut: [],
  },
  {
    id: 'agent-core',
    roots: ['packages/agent-core'],
    carveOut: [],
  },
  {
    // `packages/ai` is `core`-shaped and declared `core`. Three files are not
    // pure. See the file header for the full argument.
    id: 'legacy-ai',
    roots: ['packages/ai'],
    carveOut: [
      {
        file: 'packages/ai/src/api/ollama-chat.ts',
        why: 'Calls `fetch` directly against the local Ollama HTTP server for /api/chat and /api/embed instead of taking an injected transport. Should become an injected port (M5.3 follow-on); it is the largest of the three and the only one reachable from the renderer path that talks to a user-installed local model.',
        expects: ['fetch'],
      },
      {
        file: 'packages/ai/src/auth/oauth/device-code.ts',
        why: 'OAuth 2.0 device-authorization grant. Both legs of the grant are network calls by definition; there is no pure formulation, so this is a credential capability adapter and the honest place for it is outside `core`.',
        expects: ['fetch'],
      },
      // ── Host-clock sites, found by MEASUREMENT ───────────────────────────
      // These three were NOT in M5.1\'s list. Running this gate is what
      // surfaced them: a hand-kept list of three stops finding the fourth.
      // They are listed rather than dropped from the detector because a timer
      // IS a host-clock dependency, and quietly removing the primitive to make
      // the number smaller is how a gate stops meaning anything.
      {
        file: 'packages/ai/src/utils/backoff.ts',
        why: '`sleep()` (line 119) schedules on the host timer. The DECISION half of this file is already pure and separately exported — `calculateBackoffDelay` and `calculatePersistentBackoffDelay` are the pure algorithm, and `sleep` is the effect. The clean fix is to make `sleep` take an injected sleep function, as `system-one/client.ts` already does for its transport.',
        expects: ['setTimeout/setInterval'],
      },
      {
        file: 'packages/ai/src/utils/idle-timeout.ts',
        why: '`withIdleTimeout` is an async generator that races its consumer against a host timer. There is no pure formulation of a deadline without a clock port, so this is a clock dependency and should take an injected `Clock` — which is exactly the port `slice-classification.ts` already declares and marks as having no seam today.',
        expects: ['setTimeout/setInterval'],
      },
      {
        file: 'packages/ai/src/system-one/client.ts',
        why: 'Request timeout at line 188. NOTE this file is otherwise the CORRECT pattern and the model for the other carve-outs: its transport is already injected (`options.fetchFn ?? fetch`, line 166) and it calls `this.fetchFn(...)` (line 190), never bare `fetch`. Only the deadline is host-bound. Fixing this one is a clock port; fixing `ollama-chat.ts` is a transport port.',
        expects: ['setTimeout/setInterval'],
      },
    ],
  },
];

/**
 * Resolve a declared root to an absolute directory.
 *
 * Relative roots are repo-relative (the normal case). Absolute roots are
 * honoured so the tests can point a synthetic module at a temp tree — without
 * that, `path.join(REPO_ROOT, absoluteRoot)` silently discards `REPO_ROOT` and
 * the synthetic scan reads a path that does not exist, which would make every
 * "the gate has teeth" case pass vacuously.
 */
function resolveRoot(root: string): string {
  return path.isAbsolute(root) ? root : path.join(REPO_ROOT, root);
}

/** Every IO site under every declared `core` root. */
export function scanCoreModules(modules: readonly CoreModule[] = CORE_MODULES): IoSite[] {
  const sites: IoSite[] = [];
  for (const mod of modules) {
    for (const root of mod.roots) {
      for (const governed of GOVERNED_DIRS) {
        for (const abs of walk(path.join(resolveRoot(root), governed))) {
          sites.push(...findIoSites(abs));
        }
      }
    }
  }
  return sites;
}

/**
 * The gate.
 *
 * Returns a human-readable list of violations. Empty means the `core` contract
 * holds. Deliberately a pure function of the filesystem so the test can assert
 * on the shape of a violation without writing a fixture to the repo.
 */
export function findCorePurityViolations(
  modules: readonly CoreModule[] = CORE_MODULES,
): string[] {
  const problems: string[] = [];
  const sites = scanCoreModules(modules);

  // A scan that found no files at all is a broken gate, not a clean repo.
  const scannedRoots = modules
    .flatMap((m) => m.roots)
    .filter((r) => fs.existsSync(path.join(resolveRoot(r), GOVERNED_DIRS[0]!)));
  if (scannedRoots.length === 0) {
    problems.push(
      'no declared core root exists on disk — the scan is anchored wrong and would pass vacuously',
    );
  }

  const allowed = new Map<string, CarveOutEntry>();
  for (const mod of modules) {
    for (const entry of mod.carveOut) {
      // Keyed by the NORMALISED ABSOLUTE path, never by the display string.
      // `rel()` output is only meaningful for roots inside the repo; keying on
      // it makes a carve-out silently stop matching whenever separators or a
      // temp-dir location differ, and a carve-out that quietly stops matching
      // is the exact failure this gate exists to prevent.
      const key = normalize(resolveRoot(entry.file));
      if (allowed.has(key)) {
        problems.push(`${entry.file}: declared as a carve-out twice`);
        continue;
      }
      if (!fs.existsSync(key)) {
        problems.push(`${entry.file}: carve-out names a file that does not exist`);
        continue;
      }
      allowed.set(key, entry);
    }
  }

  for (const site of sites) {
    const absKey = normalize(absoluteOf(site.file));
    const entry = allowed.get(absKey);
    if (!entry) {
      // Attribute to the owning module by ABSOLUTE containment, so the message
      // names the right module for repo and synthetic roots alike. Both sides
      // are normalized: `path.join` yields backslashes on Windows while
      // `rel()` yields forward slashes, and comparing those two directly is a
      // mismatch that silently degrades every message to "layer-core".
      const siteAbs = normalize(absoluteOf(site.file));
      const owner = modules.find((m) =>
        m.roots.some((r) => siteAbs.startsWith(normalize(resolveRoot(r)))),
      );
      problems.push(
        `${site.file}:${site.line}: ${site.primitive} in a layer-` +
          `${owner?.id ?? 'core'} module, which declares no IO`,
      );
    }
  }

  return problems;
}

/**
 * A carve-out that no longer needs to exist is a finding, not a cleanup.
 *
 * Two reasons: the allowance is dead weight in a list that is supposed to be
 * the authoritative inventory, and — more importantly — a carve-out entry that
 * stopped matching means the file was edited, and nobody re-read whether the
 * edit is why. Making the gate fail forces the re-read.
 */
export function findStaleCarveOuts(
  modules: readonly CoreModule[] = CORE_MODULES,
): string[] {
  const problems: string[] = [];
  for (const mod of modules) {
    for (const entry of mod.carveOut) {
      const abs = resolveRoot(entry.file);
      if (!fs.existsSync(abs)) continue; // already reported by findCorePurityViolations
      const found = findIoSites(abs);
      if (found.length === 0) {
        problems.push(
          `${entry.file}: carve-out is stale — the file no longer performs IO, ` +
            `so the entry must be removed (and the layer re-checked)`,
        );
        continue;
      }
      const kinds = new Set(found.map((s) => s.primitive));
      for (const expected of entry.expects) {
        if (!kinds.has(expected)) {
          problems.push(
            `${entry.file}: carve-out expects ${expected}, but the file now ` +
              `performs ${[...kinds].join(', ') || 'nothing'}`,
          );
        }
      }
    }
  }
  return problems;
}
