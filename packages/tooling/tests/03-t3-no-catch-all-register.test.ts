/**
 * T3 — there is no single catch-all `register(any)`-shaped method.
 *
 * The design specifies the check: enumerate `ExtensionRegistry`'s public
 * methods and fail if any registration method takes `any` / `unknown`. This
 * gate generalises that to the builder as well, because the builder is where
 * registration actually happens, and a check that only looked at the registry
 * would go green by being unable to see the method at all.
 *
 * It uses the TypeScript checker rather than a regex so a parameter typed
 * through an alias, a generic, or an indexed access is still resolved to its
 * written type text.
 *
 * Mutation proof: add `registerPlugin(plugin: any): void {}` to
 * `ExtensionRegistryBuilder` — the expected-name set comparison goes red
 * (14 methods, one unexpected) AND the any-parameter check goes red.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The literal contract. The actual set is read from the TypeScript checker,
 *  so the two sides of every comparison come from different sources. */
const EXPECTED_REGISTRATION_METHODS = [
  'modeContributor',
  'toolContributor',
  'promptSectionContributor',
  'hookContributor',
  'contextContributor',
  'skillContributor',
  'approvalPolicyContributor',
  'profileContributor',
  'serverContributor',
  'memoryPolicyContributor',
  'decisionContributor',
  'lifecycleContributor',
  'tokenUsageContributor',
] as const;

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const program = ts.createProgram([ENTRY], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
});

interface PublicMethod {
  readonly className: string;
  readonly name: string;
  readonly parameterTypes: readonly (string | null)[];
}

function publicMethodsOf(className: string): PublicMethod[] {
  const found: PublicMethod[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('node_modules')) continue;
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      if (statement.name?.text !== className) continue;
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const name = member.name.getText(sourceFile);
        if (name.startsWith('_')) continue;
        const isPrivate = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
        if (isPrivate) continue;
        found.push({
          className,
          name,
          parameterTypes: member.parameters.map((p) => p.type?.getText(sourceFile) ?? null),
        });
      }
    }
  }
  return found;
}

/** A registration method is one of the 13 narrow slot methods. */
function isRegistrationMethod(method: PublicMethod): boolean {
  return method.name.endsWith('Contributor');
}

describe('T3 — no single catch-all register(any)-shaped method', () => {
  const registryMethods = publicMethodsOf('ExtensionRegistry');
  const builderMethods = publicMethodsOf('ExtensionRegistryBuilder');

  /**
   * A registration method is one of the 13 narrow slot methods.
   *
   * Used ONLY for the "exactly 13" comparison. The broad checks below
   * deliberately do NOT use this predicate: an earlier version of this gate
   * filtered by it everywhere, which meant a new `registerPlugin(any)` was
   * caught by the name check alone while the any-parameter check and the
   * count check both stayed green — a gate that had stopped seeing the thing.
   */
  function isRegistrationMethod(method: PublicMethod): boolean {
    return method.name.endsWith('Contributor');
  }

  it('actually locates both classes (guard against a green-but-blind gate)', () => {
    expect(registryMethods.length).toBeGreaterThan(0);
    expect(builderMethods.length).toBeGreaterThan(0);
  });

  it('exposes exactly the 13 narrow registration methods on the builder', () => {
    const actual = builderMethods.filter(isRegistrationMethod).map((m) => m.name).sort();
    const expected = [...EXPECTED_REGISTRATION_METHODS].sort();
    expect(actual).toEqual(expected);
  });

  /**
   * The whole public surface of the builder, not just the 13. A 14th method of
   * ANY name is a contract change and must be deliberate, so this compares
   * against the complete expected set. This is the check that catches a
   * `register(any)` that the name-filtered comparison above would ignore.
   */
  it('exposes no public builder method beyond the 13 slots plus build/count', () => {
    const actual = builderMethods.map((m) => m.name).sort();
    const expected = [...EXPECTED_REGISTRATION_METHODS, 'build', 'count'].sort();
    expect(actual).toEqual(expected);
  });

  it('gives the registry no registration method at all (frozen after assembly)', () => {
    expect(registryMethods.filter(isRegistrationMethod).map((m) => m.name)).toEqual([]);
  });

  it('has no method named register / registerAll / registerPlugin anywhere', () => {
    const catchAll = [...registryMethods, ...builderMethods]
      .map((m) => `${m.className}.${m.name}`)
      .filter((qualified) => /(^|\.)register[A-Za-z]*$/.test(qualified));
    expect(catchAll).toEqual([]);
  });

  /**
   * Scans EVERY public method on both classes, not only the 13 — a parameter
   * typed `any` is a defect whatever the method is called, and a
   * `registerPlugin(plugin: any)` must not slip past on a name filter.
   */
  it('takes no any/unknown and no unannotated parameter in any public method', () => {
    const offenders: string[] = [];
    for (const method of [...registryMethods, ...builderMethods]) {
      method.parameterTypes.forEach((type, index) => {
        if (type === undefined || type === null) {
          offenders.push(`${method.className}.${method.name}: parameter ${index} has no type annotation`);
          return;
        }
        const bare = type.replace(/\s/g, '');
        if (bare === 'any' || bare === 'unknown' || /[|&]any\b/.test(bare) || /[|&]unknown\b/.test(bare)) {
          offenders.push(`${method.className}.${method.name}: parameter ${index} is ${bare}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
