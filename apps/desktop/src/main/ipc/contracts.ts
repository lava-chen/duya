/**
 * electron/ipc/contracts.ts
 *
 * Runtime schemas for high-risk IPC payloads (audit ISS-31).
 *
 * Several privileged `ipcMain.handle` channels took `unknown` payloads and
 * coerced them with bare `as` casts, so an arbitrary renderer payload
 * (object where a string belongs, array where a scalar belongs, a
 * multi-megabyte string) reached the SQLite layer or the provider store
 * verbatim. TypeScript does not help here: `ipcMain.handle` accepts any
 * renderer-supplied value at runtime, so the annotation is a lie.
 *
 * Design rules — these are deliberate, not oversights:
 *
 * 1. **Type + bound, not required-ness.** `migrateLegacyApiProvider` already
 *    tolerates a missing `providerType` / `baseUrl`, and the onboarding flow
 *    really does send partial payloads. Demanding those fields here would be a
 *    behavior change dressed up as a fix. Where a field is already required by
 *    the TypeScript type at every call site (`ApiProvider.id`, `ApiProvider.name`)
 *    it stays required, because no type-correct caller can omit it.
 * 2. **Unknown keys are stripped** (zod's default), which matches what the
 *    existing `db:agentProfile:update` `fieldMap` already does by hand.
 * 3. **Bounded string, not enum,** for open vocabularies (`providerType`,
 *    `profile_kind`). The renderer types both as plain `string` and both are
 *    data-driven; narrowing to the values that happen to be present today
 *    would reject presets or plugins we have not inspected.
 *
 * No electron imports — plain zod, unit-testable under vitest.
 */

import { z } from 'zod';

/** Bounded, non-empty record identifier. */
export const RecordIdSchema = z.string().min(1).max(200);

/** True when `value` contains any C0 control char, DEL, or NUL. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * Absolute path for `shell:open-path` / `shell:show-item-in-folder`.
 *
 * Replaces three copies of the same inline typeof/length/NUL check. The
 * control-character rejection is slightly stronger than the NUL-only check
 * it replaces, and deliberately so: no valid Windows or POSIX filename can
 * contain a control character, and `isHttpUrl` already rejects them for the
 * sibling `shell:open-external` handler with the same reasoning.
 *
 * NOTE: this validates *shape*, not *location*. It deliberately does not
 * decide which filesystem roots are legitimate — see audit ISS-14, which
 * needs a product decision before any root allow-list can be applied here.
 */
export const ShellPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !hasControlChar(p), {
    message: 'path must not contain control characters',
  });

// ---------------------------------------------------------------------------
// Agent profiles (db:agentProfile:create / :update)
// ---------------------------------------------------------------------------

/** Tool group pattern, e.g. `file:*`. */
const ToolPatternSchema = z.string().min(1).max(200);
const ToolPatternListSchema = z.array(ToolPatternSchema).max(500);

/** Prompt section name, e.g. `memory`. */
const SectionNameSchema = z.string().min(1).max(100);
const SectionListSchema = z.array(SectionNameSchema).max(200);

// Field order matters: zod rebuilds the output object in schema declaration
// order, and this value is persisted as a JSON string. Keep it aligned with
// `PromptProfileOverride` in packages/agent/src/agent-profile/types.ts so the
// stored key order stays stable.
export const PromptProfileOverrideSchema = z.object({
  disableSections: SectionListSchema.optional(),
  enableSections: SectionListSchema.optional(),
});

/**
 * Field set shared by create and update. Every field is optional because both
 * handlers already supply their own defaults (`|| 'New Agent'`, `?? 'main'`,
 * `? 1 : 0`); the schema's job is to reject wrongly-typed or unbounded values
 * *when present*, not to second-guess those defaults.
 *
 * Wire keys are snake_case column names. That is what the handler `fieldMap`
 * reads and what the only in-repo caller uses.
 */
const agentProfileFieldShape = {
  name: z.string().min(1).max(200).nullish(),
  description: z.string().max(5000).nullish(),
  allowed_tools: ToolPatternListSchema.nullish(),
  disallowed_tools: ToolPatternListSchema.nullish(),
  prompt_system: z.string().min(1).max(200).nullish(),
  prompt_profile: PromptProfileOverrideSchema.nullish(),
  default_model: z.string().min(1).max(300).nullish(),
  profile_kind: z.string().min(1).max(64).nullish(),
  is_enabled: z.boolean().nullish(),
  user_visible: z.boolean().nullish(),
  is_preset: z.boolean().nullish(),
};

export const AgentProfileCreateSchema = z.object({
  ...agentProfileFieldShape,
  id: RecordIdSchema.optional(),
});

export const AgentProfileUpdateSchema = z.object(agentProfileFieldShape);

// ---------------------------------------------------------------------------
// LLM providers (config:provider:upsert / :update)
// ---------------------------------------------------------------------------

/**
 * Bounded string map. `extraEnv` and `headers` are attacker-reachable maps of
 * strings that end up on every outbound LLM request, so both the value length
 * and the key count are capped.
 *
 * `S` must stay generic: declaring the parameter as `z.ZodTypeAny` erases the
 * value type and widens `Record<string, string>` to `Record<string, unknown>`,
 * which no longer assigns back to the `ApiProvider` fields.
 */
function boundedStringMap<S extends z.ZodTypeAny>(value: S, maxEntries = 100) {
  return z
    .record(z.string().min(1).max(200), value)
    .refine((m) => Object.keys(m).length <= maxEntries, {
      message: `at most ${maxEntries} entries`,
    });
}

const providerNameSchema = z.string().min(1).max(200);

/**
 * Every provider field that may be omitted. `name` is handled separately
 * because upsert requires it and the partial update does not.
 *
 * These are `.optional()`, not `.nullish()`, on purpose: every corresponding
 * field on `ApiProvider` is declared `?: T` (never `T | null`), so accepting
 * `null` here would widen the parsed type into something that no longer
 * assigns back to `Partial<ApiProvider>`. `null` is not in the wire contract,
 * so rejecting it is also the stricter reading.
 */
const apiProviderOptionalFieldShape = {
  alias: z.string().min(1).max(200).optional(),
  // See design rule 3: data-driven vocabulary, deliberately not an enum.
  providerType: z.string().min(1).max(64).optional(),
  baseUrl: z.string().max(2000).optional(),
  apiKey: z.string().max(4000).optional(),
  isActive: z.boolean().optional(),
  extraEnv: boundedStringMap(z.string().max(2000)).optional(),
  headers: boundedStringMap(z.string().max(2000)).optional(),
  options: boundedStringMap(z.unknown()).optional(),
  notes: z.string().max(5000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
};

export const ApiProviderUpsertSchema = z.object({
  id: RecordIdSchema,
  name: providerNameSchema,
  ...apiProviderOptionalFieldShape,
});

export const ApiProviderPatchSchema = z.object({
  name: providerNameSchema.optional(),
  ...apiProviderOptionalFieldShape,
});

// ---------------------------------------------------------------------------
// Parsing helper
// ---------------------------------------------------------------------------

/** Thrown when an IPC payload fails its contract. */
export class IpcContractError extends Error {
  constructor(
    readonly channel: string,
    readonly issues: string[],
  ) {
    super(`Invalid payload for ${channel}: ${issues.join('; ')}`);
    this.name = 'IpcContractError';
  }
}

/**
 * Validate an IPC payload, or throw `IpcContractError`.
 *
 * Throwing (rather than returning a sentinel) is deliberate: a rejected
 * payload that silently degrades into an empty result is the "failure
 * disguised as success" class of bug, and callers in the main process
 * already surface handler exceptions to the renderer.
 */
export function parseIpcPayload<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  channel: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new IpcContractError(
    channel,
    result.error.issues.map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    }),
  );
}
