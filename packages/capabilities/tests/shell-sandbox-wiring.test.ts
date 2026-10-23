/**
 * shell-sandbox-wiring.test.ts — the sandbox, wired.
 *
 * ## The finding this pins
 *
 * `wrapCommand` and `executeIsolated` had NO production consumer. The only
 * call sites were `packages/sandbox/src/index.ts` — the re-export. The
 * worker announced a sandbox at startup (`setSandboxEnabled(true)` plus a
 * Docker image prewarm whose errors were swallowed), and then every command
 * went straight to the shell: no OS isolation, no image, no wrapper.
 *
 * That is a missing wire, not a degraded mode, and the difference matters:
 * "degraded" implies a working system with a fallback, and there was no
 * system. The `none` provider was not a fallback that fired — it was the
 * only state the product was ever in.
 *
 * ## What is pinned here
 *
 *  1. The production call point EXISTS, and it is in the shell worker. This
 *     is the static assertion the card asks for: it fails if the call is
 *     removed, and it fails in a way that says which file lost it.
 *  2. The command is treated according to the provider the adapter selected.
 *  3. The `none` case is stated in words a user can read, not only in a
 *     source comment.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveShellIsolationSync } from '@duya/sandbox';
import { describeShellIsolation, planShellExecution } from '../src/shell/sandbox-execution.js';
import { prepareWorkerSandbox } from '../src/shell/prepare-sandbox.js';

const REPO_ROOT = process.cwd();

/** Every production source file under a package, tests excluded. */
function productionSources(packageDir: string): string[] {
  const root = join(REPO_ROOT, packageDir, 'src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('the sandbox execution path has a production consumer', () => {
  it('has a production consumer for the sandbox execution path', () => {
    // The shell worker is where a command becomes a process, so it is where
    // the sandbox has to be applied. The assertion is on the FILE, not on the
    // package: removing the call from this one file has to make this test
    // red, and the message has to name the file that lost it.
    const bashWorker = join(REPO_ROOT, 'packages/host/src/managed-shell/BashWorker.ts');
    const source = readFileSync(bashWorker, 'utf8');
    expect(
      source,
      `${relative(REPO_ROOT, bashWorker)} must route the command through the sandbox plan; ` +
      'a command that skips it runs with no OS isolation',
    ).toContain('planShellExecution(');

    // And the plan must actually reach the sandbox's wrap.
    const plan = readFileSync(
      join(REPO_ROOT, 'packages/capabilities/src/shell/sandbox-execution.ts'),
      'utf8',
    );
    expect(plan).toContain('wrapCommandSync(');
  });

  it('has no production consumer that claims Docker isolation it never applies', () => {
    // `executeIsolated` is the Docker path, and the shell path does not use
    // it: a wrapped command is not run in a container. Nothing in production
    // may call it and then report the result as an isolated execution.
    const callers = productionSources('packages/host')
      .concat(productionSources('packages/capabilities'))
      .filter((file) => readFileSync(file, 'utf8').includes('executeIsolated('));
    expect(callers).toEqual([]);
  });
});

describe('a command is treated according to the provider the adapter selected', () => {
  it('runs a shell command through the sandbox provider that the adapter selected', () => {
    const provider = resolveShellIsolationSync().provider;
    const plan = planShellExecution({ command: 'echo hello', cwd: '/tmp' });

    expect(plan.isolation.provider).toBe(provider);
    if (provider === 'bubblewrap') {
      // Wrapped: the command runs inside the sandbox.
      expect(plan.command).toContain('bwrap');
      expect(plan.command).toContain('echo hello');
      expect(plan.isolation.isolated).toBe(true);
    } else {
      // Unwrapped, and the plan says so rather than implying otherwise.
      expect(plan.command).toBe('echo hello');
      expect(plan.isolation.isolated).toBe(false);
    }
  });

  it('never reports an isolation the command did not get', () => {
    const plan = planShellExecution({ command: 'echo hello', cwd: '/tmp' });
    const wrapped = plan.command !== 'echo hello';
    expect(plan.isolation.isolated).toBe(wrapped);
  });
});

describe('the none provider is stated where a user can see it', () => {
  it('says in one line that there is no OS isolation', () => {
    const isolation = resolveShellIsolationSync();
    const diagnostic = describeShellIsolation(isolation);
    if (isolation.isolated) {
      expect(diagnostic).toContain(isolation.provider);
    } else {
      expect(diagnostic).toContain('none');
      expect(diagnostic).toContain('no OS isolation');
    }
  });

  it('emits the diagnostic when the worker prepares its sandbox', () => {
    const lines: string[] = [];
    const preparation = prepareWorkerSandbox((message) => lines.push(message));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(preparation.diagnostic);
    expect(preparation.isolation.provider).toBe(resolveShellIsolationSync().provider);
  });
});
