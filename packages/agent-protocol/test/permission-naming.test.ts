/**
 * The permission vocabulary must not collide with the system being migrated.
 *
 * Not a spec-numbered drift test. It guards a decision made at PP-1 review:
 * three names in this package originally shadowed names that already mean
 * something different in `packages/agent/src/permissions/types.ts`, and the
 * collision is invisible until both packages are imported in the same file —
 * which is exactly what the migration does.
 *
 * The names are checked by reading the source rather than by importing it,
 * because TypeScript erases types and `import *` cannot enumerate them.
 * Reading the declarations is the only way to see the exported type surface.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function readModule(name: string): string {
  const p = join(SRC, name);
  if (!existsSync(p)) throw new Error(`cannot verify the vocabulary: ${p} is missing`);
  return readFileSync(p, 'utf8');
}

/** Exported type and interface names declared in a module. */
function exportedTypeNames(source: string): Set<string> {
  const names = new Set<string>();
  const re = /^export\s+(?:declare\s+)?(?:type|interface)\s+([A-Za-z0-9_]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.add(m[1]!);
  return names;
}

const PERMISSION_SURFACE = new Set<string>([
  ...exportedTypeNames(readModule('permission.ts')),
  ...exportedTypeNames(readModule('primitives.ts')),
]);

describe('permission naming: the four stages are distinguishable', () => {
  it('exports one name per stage of the chain', () => {
    // request -> response -> resolution is on the wire; the run's own
    // configuration is separate again. A reader who sees `PermissionRequest`
    // must not have to check a docstring to learn which side of the exchange
    // it belongs to.
    for (const name of [
      'PermissionRequest',
      'PermissionResponse',
      'PermissionResolution',
      'PermissionPolicyMode',
      'PermissionRequestMode',
    ]) {
      expect(PERMISSION_SURFACE.has(name), `${name} is not exported`).toBe(true);
    }
  });

  it('does not export any name that means something else in packages/agent', () => {
    // `PermissionDecision` in packages/agent is the policy engine's verdict —
    // `{ behavior: 'allow' | 'ask' | 'deny' }`, produced before anyone is asked.
    // If this package exported a `PermissionDecision` meaning the host's
    // answer, both would be in scope in every migrated file and the compiler
    // would have no way to flag the confusion.
    //
    // `PermissionMode` is worse because it is ambiguous WITHIN this package:
    // the old one is the run's policy, the new one was a single request's
    // interactive situation. `PermissionModeName` was the first attempt at
    // disambiguating and is a weaker convention than naming both.
    const forbidden = ['PermissionDecision', 'PermissionMode', 'PermissionModeName'];
    expect(
      forbidden.filter((n) => PERMISSION_SURFACE.has(n)),
      'these names collide with the system being migrated',
    ).toEqual([]);
  });

  it('keeps the policy mode and the request mode as separate types', () => {
    // Not a string-equality test: a future "simplification" that merges the
    // two unions would still produce two exported names, and the collision
    // this whole change exists to prevent would come back one layer down.
    const primitives = readModule('primitives.ts');
    const permission = readModule('permission.ts');

    expect(primitives, 'PermissionPolicyMode belongs with the run configuration').toContain(
      'export type PermissionPolicyMode',
    );
    expect(permission, 'PermissionRequestMode belongs with the request payload').toContain(
      'export type PermissionRequestMode',
    );

    const policyValues = /export type PermissionPolicyMode =([\s\S]*?);/.exec(primitives)?.[1] ?? '';
    const requestValues = /export type PermissionRequestMode =([\s\S]*?);/.exec(permission)?.[1] ?? '';
    const overlap = [...policyValues.matchAll(/'([^']+)'/g)]
      .map((m) => m[1]!)
      .filter((v) => new RegExp(`'${v}'`).test(requestValues));

    expect(overlap, 'the two modes must not share a wire value, or they are not two layers').toEqual([]);
  });
});
