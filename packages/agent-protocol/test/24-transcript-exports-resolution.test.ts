/**
 * Published-package resolution for `@duya/agent-protocol/transcript`.
 *
 * ## Why this test spawns Node instead of importing the module
 *
 * `vitest.config.ts` aliases `@duya/agent-protocol` and its subpaths onto
 * this checkout's SOURCE. That is correct for test runs and useless for this
 * question. Under an alias, `import ... from '@duya/agent-protocol/transcript'`
 * resolves no matter what the `exports` map says — so a subpath that is
 * missing from `package.json` entirely, or one whose `types` condition points
 * at a file that is never emitted, would still import cleanly in every test
 * in this repository.
 *
 * That is the exact failure this file exists to catch: "a type that only
 * passes typecheck through a path the published package does not expose is
 * not done" (plan 587 T3.1 acceptance).
 *
 * So the resolution is done by a real Node child process, from a directory
 * with no vite alias in scope, using `import.meta.resolve` — which honours the
 * `exports` map and its `import` condition, exactly as a downstream consumer
 * does. A separate `tsc --noEmit` run then proves the TYPES resolve through
 * the same map, not just the runtime entry.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The test file lives at <repo>/packages/agent-protocol/test/, so three
// levels up is the repo root. Two levels up is `packages/`, which still
// resolves the package via node_modules' upward walk and would therefore
// hide a wrong-root bug — the `existsSync` checks below are what catch it.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** `import.meta.resolve` returns a file:// URL; fs wants a plain path. */
const toPath = (resolved: string): string =>
  resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;

/**
 * Resolve specifiers with the real Node resolver from the repo root.
 *
 * `import.meta.resolve` is used rather than `createRequire().resolve`
 * because this package's `exports` map declares an `import` condition and no
 * `require` condition — a CJS resolve would fail against a package that is
 * perfectly usable from ESM, which would be a misleading failure.
 */
function resolveWithNode(specifiers: readonly string[]): Record<string, string> {
  const script = `
    const specs = ${JSON.stringify(specifiers)};
    const out = {};
    for (const s of specs) {
      try {
        out[s] = import.meta.resolve(s);
      } catch (err) {
        out[s] = 'UNRESOLVED: ' + (err && err.code ? err.code : String(err));
      }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as Record<string, string>;
}

const scratch = mkdtempSync(join(tmpdir(), 'duya-587-t3-1-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('published-package resolution: @duya/agent-protocol/transcript', () => {
  it('the subpath is declared in the package exports map', () => {
    const pkg = JSON.parse(
      execFileSync(process.execPath, ['-e', "process.stdout.write(require('fs').readFileSync('packages/agent-protocol/package.json','utf8'))"], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as { exports: Record<string, { types: string; import: string }> };

    // Declared in the map. The runtime resolution below proves the map is
    // honoured; this proves the declaration itself exists.
    expect(Object.keys(pkg.exports)).toContain('./transcript');
    expect(pkg.exports['./transcript']?.types).toBe('./dist/transcript/index.d.ts');
    expect(pkg.exports['./transcript']?.import).toBe('./dist/transcript/index.js');
  });

  it('a real Node resolver reaches the runtime entry through the exports map', () => {
    const resolved = resolveWithNode(['@duya/agent-protocol/transcript']);

    expect(resolved['@duya/agent-protocol/transcript']).not.toMatch(/^UNRESOLVED/);
    // Must land on the built dist entry the map declares, not on src.
    expect(resolved['@duya/agent-protocol/transcript']).toMatch(
      /packages[/\\]agent-protocol[/\\]dist[/\\]transcript[/\\]index\.js$/,
    );
    expect(resolved['@duya/agent-protocol/transcript']).not.toMatch(/[/\\]src[/\\]/);
  });

  it('the resolved entry exists on disk', () => {
    const resolved = resolveWithNode(['@duya/agent-protocol/transcript']);
    expect(existsSync(toPath(resolved['@duya/agent-protocol/transcript']))).toBe(true);
  });

  it('the emitted declarations for the types a consumer imports are on disk', () => {
    const resolved = resolveWithNode(['@duya/agent-protocol/transcript']);
    const runtimeEntry = resolved['@duya/agent-protocol/transcript'];
    expect(runtimeEntry).not.toMatch(/^UNRESOLVED/);

    // The `types` condition points at the .d.ts sibling. This is the file a
    // downstream `tsc` actually reads, so it must exist after a build.
    const dts = toPath(runtimeEntry).replace(/\.js$/, '.d.ts');
    expect(existsSync(dts), `missing emitted declarations: ${dts}`).toBe(true);
  });

  it('a consumer importing only through the package name typechecks', () => {
    // The decisive check. A scratch .ts file that imports the moved types by
    // bare package specifier — no relative path, no vite alias — and is
    // compiled with the repo's own module resolution settings
    // (NodeNext). If the `exports` map did not expose the subpath, or the
    // declarations were not emitted, this fails to compile.
    writeFileSync(
      join(scratch, 'consumer.ts'),
      `
import type {
  AgentProgressEvent,
  AssistantMessage,
  DeferredToolExtras,
  ImageContent,
  Message,
  MessageContent,
  PermissionRequestEvent,
  StopReason,
  TokenUsage,
  ToolResultWire,
  ToolUse,
  UsageCall,
} from '@duya/agent-protocol/transcript';

// A value of each imported type, so the import is load-bearing rather than
// a type-only reference the compiler could erase.
const content: MessageContent = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AA' },
};
const image: ImageContent = content as ImageContent;

const usage: TokenUsage = { input_tokens: 1, output_tokens: 2 };
const call: UsageCall = { input_tokens: 1, output_tokens: 2, model: 'm' };
const stop: StopReason = 'repeated_tool_calls';
const msg: Message = { role: 'user', content: 'hi', visibility: 'hidden' };
const assistant: AssistantMessage = { role: 'assistant', content: [], stopReason: stop };
const toolUse: ToolUse = { id: 't', name: 'n', input: {} };
const wire: ToolResultWire = { id: 't', name: 'n', result: 'ok', error: false };
const extras: DeferredToolExtras = { pendingContext: Promise.resolve('note') };
const perm: PermissionRequestEvent = {
  id: 'p',
  toolName: 'Bash',
  toolInput: {},
  mode: 'generic',
  expiresAt: 0,
};
const progress: AgentProgressEvent = { type: 'text', data: 'x' };

export const surface = [
  image,
  usage,
  call,
  stop,
  msg,
  assistant,
  toolUse,
  wire,
  extras,
  perm,
  progress,
] as const;
`,
      'utf8',
    );

    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ['consumer.ts'],
    };
    writeFileSync(
      join(scratch, 'tsconfig.json'),
      JSON.stringify(
        {
          ...tsconfig,
          // Resolve node_modules from the repo so the workspace link to
          // packages/agent-protocol is found.
          compilerOptions: {
            ...tsconfig.compilerOptions,
            baseUrl: REPO_ROOT,
            typeRoots: [join(REPO_ROOT, 'node_modules/@types')],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    // Symlink the repo's node_modules next to the scratch consumer so
    // NodeNext resolution finds @duya/agent-protocol the way a real
    // consumer's node_modules would, without copying 1700 packages.
    try {
      symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'), 'junction');
    } catch {
      // Junction creation can fail without privileges. Skip rather than
      // report a resolution failure that is really an environment problem.
      return;
    }

    const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    expect(existsSync(tsc), 'typescript must be installed to run this check').toBe(true);

    try {
      execFileSync(process.execPath, [tsc, '-p', join(scratch, 'tsconfig.json')], {
        cwd: scratch,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      const detail = err as { stdout?: string; stderr?: string };
      throw new Error(
        `a consumer importing '@duya/agent-protocol/transcript' by package name did not typecheck:\n${detail.stdout ?? ''}${detail.stderr ?? ''}`,
      );
    }
  });

  it('the sibling subpaths still resolve, so nothing was displaced', () => {
    // `/transcript` was added to a map that already carried `.`, `/testing`
    // and `/legacy`. A subpath that shadows an existing one would resolve
    // here and fail only for the shadowed entry.
    const resolved = resolveWithNode([
      '@duya/agent-protocol',
      '@duya/agent-protocol/testing',
      '@duya/agent-protocol/legacy',
      '@duya/agent-protocol/transcript',
    ]);
    for (const [spec, target] of Object.entries(resolved)) {
      expect(target, `${spec} must resolve`).not.toMatch(/^UNRESOLVED/);
      expect(existsSync(toPath(target)), `${spec} -> ${target}`).toBe(true);
    }
  });
});
