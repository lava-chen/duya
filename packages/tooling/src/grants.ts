/**
 * The capability vocabulary owned by this package.
 *
 * A capability is the name of one registry slot. It is NOT a feature: the
 * vocabulary is deliberately exactly as wide as the registry and no wider, so
 * "which capability does this contributor need" is answerable by looking at
 * the slot it is registered into. A capability grant therefore grants
 * contribution rights, never behaviour.
 *
 * This is deliberately NOT the host's capability model. The host injects the
 * concrete grant set at assembly time via `assembleExtensions`; this package
 * never reads the host's grant store and never decides what to grant.
 */

/**
 * The 13 extension slots, one per contributor interface. Order is the
 * declaration order of the registry's independent slots and is part of the
 * contract: `validate` reports slot names verbatim.
 */
export const EXTENSION_SLOTS = [
  'modes',
  'tools',
  'promptSections',
  'hooks',
  'context',
  'skills',
  'approvalPolicies',
  'profiles',
  'servers',
  'memoryPolicies',
  'decisions',
  'lifecycles',
  'tokenUsage',
] as const;

/** The name of one registry slot. */
export type ExtensionSlot = (typeof EXTENSION_SLOTS)[number];

/** A capability is a slot name. */
export type ExtensionCapability = ExtensionSlot;

const SLOT_SET: ReadonlySet<string> = new Set<string>(EXTENSION_SLOTS);

/** Type guard for a well-formed capability string. */
export function isExtensionCapability(value: string): value is ExtensionCapability {
  return SLOT_SET.has(value);
}

/** The set of capabilities the host granted for one assembly. */
export type GrantedCapabilities = ReadonlySet<ExtensionCapability>;

/**
 * Build a grant set from host-supplied slot names.
 *
 * Unknown names throw rather than being dropped: a typo'd grant that silently
 * vanished would turn into a confusing "capability escalation" rejection later,
 * at assembly, instead of a precise error here.
 */
export function grantedCapabilities(names: readonly string[]): GrantedCapabilities {
  const unknown = names.filter((name) => !isExtensionCapability(name));
  if (unknown.length > 0) {
    throw new Error(
      `grantedCapabilities: unknown capability/capabilities ${unknown.map((n) => `"${n}"`).join(', ')}. `
      + `Known capabilities: ${EXTENSION_SLOTS.join(', ')}.`,
    );
  }
  const granted = new Set<ExtensionCapability>();
  for (const name of names as readonly ExtensionCapability[]) granted.add(name);
  return granted;
}

/** Every capability granted. Convenience for hosts that grant everything. */
export function allCapabilities(): GrantedCapabilities {
  return grantedCapabilities(EXTENSION_SLOTS);
}
