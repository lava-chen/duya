/**
 * The assembly entry point — the real caller of `validate()`.
 *
 * This is the production assembly path, not a test fixture: it is what
 * `index.ts` exports and what any host calls when it turns a set of
 * contributors into a registry. Validation runs here, before a registry
 * exists, and the extension is unskippable — `ExtensionRegistry.create` is
 * `@internal` and stripped from the emitted declarations.
 */

import { ExtensionRegistry } from './registry.js';
import type { ExtensionRegistryBuilder } from './registry.js';
import { ExtensionValidationError, validate } from './validation.js';
import type { GrantedCapabilities } from './grants.js';

/**
 * Assemble contributions into a validated registry.
 *
 * @param builder - the builder the host filled through its 13 narrow methods
 * @param granted - the capabilities the host granted for this assembly
 * @throws {ExtensionValidationError} when any assembly-time rule rejects
 */
export function assembleExtensions(
  builder: ExtensionRegistryBuilder,
  granted: GrantedCapabilities,
): ExtensionRegistry {
  const snapshot = builder.build();
  const issues = validate(snapshot, granted);
  if (issues.length > 0) throw new ExtensionValidationError(issues);
  return ExtensionRegistry.create(snapshot);
}
