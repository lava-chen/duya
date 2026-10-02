/**
 * electron/ipc/contracts.test.ts
 *
 * Contract tests for the ISS-31 payload schemas.
 *
 * These are pure zod tests (no electron), so they run under plain vitest.
 * The point of each case is either (a) a payload the renderer really sends
 * must still be accepted — so the schema is a bound, not a behavior change —
 * or (b) a type-confused / unbounded payload must be rejected before it can
 * reach SQLite or the provider store.
 */
import { describe, it, expect } from 'vitest';
import {
  AgentProfileCreateSchema,
  AgentProfileUpdateSchema,
  ApiProviderPatchSchema,
  ApiProviderUpsertSchema,
  IpcContractError,
  parseIpcPayload,
  RecordIdSchema,
  ShellPathSchema,
} from './contracts';

describe('ShellPathSchema', () => {
  it('accepts ordinary Windows and POSIX absolute paths', () => {
    expect(ShellPathSchema.safeParse('C:\\Users\\dev\\project').success).toBe(true);
    expect(ShellPathSchema.safeParse('/home/dev/project/file.py').success).toBe(true);
  });

  it('rejects non-strings, empty strings, and oversized input', () => {
    expect(ShellPathSchema.safeParse(undefined).success).toBe(false);
    expect(ShellPathSchema.safeParse(42).success).toBe(false);
    expect(ShellPathSchema.safeParse('').success).toBe(false);
    expect(ShellPathSchema.safeParse('a'.repeat(4097)).success).toBe(false);
  });

  it('rejects NUL and other control characters', () => {
    expect(ShellPathSchema.safeParse('C:\\a\0b').success).toBe(false);
    expect(ShellPathSchema.safeParse('C:\\a\nb').success).toBe(false);
    expect(ShellPathSchema.safeParse('C:\\a\u007fb').success).toBe(false);
  });
});

describe('AgentProfileUpdateSchema', () => {
  it('accepts the prompt_profile payload the existing handler test sends', () => {
    const parsed = AgentProfileUpdateSchema.safeParse({
      prompt_profile: { disableSections: ['memory', 'skills'] },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts null for every nullable column (the handler maps null to NULL)', () => {
    const parsed = AgentProfileUpdateSchema.safeParse({
      description: null,
      allowed_tools: null,
      disallowed_tools: null,
      prompt_system: null,
      prompt_profile: null,
      default_model: null,
      profile_kind: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an object where a string column belongs', () => {
    // This is the concrete type confusion the audit found: the old handler
    // cast with `v as string` and wrote the object straight into the row.
    expect(AgentProfileUpdateSchema.safeParse({ name: { evil: true } }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ prompt_system: ['a'] }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ default_model: 7 }).success).toBe(false);
  });

  it('rejects a scalar where a tool-pattern array belongs', () => {
    expect(AgentProfileUpdateSchema.safeParse({ allowed_tools: 'file:*' }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ allowed_tools: [123] }).success).toBe(false);
  });

  it('rejects an array where the prompt_profile object belongs', () => {
    expect(AgentProfileUpdateSchema.safeParse({ prompt_profile: ['memory'] }).success).toBe(false);
  });

  it('rejects non-boolean for the integer flag columns', () => {
    expect(AgentProfileUpdateSchema.safeParse({ is_enabled: 'yes' }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ user_visible: 1 }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ is_preset: 1 }).success).toBe(false);
  });

  it('bounds every free-text column', () => {
    expect(AgentProfileUpdateSchema.safeParse({ name: 'a'.repeat(201) }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ description: 'a'.repeat(5001) }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ prompt_system: 'a'.repeat(201) }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ default_model: 'a'.repeat(301) }).success).toBe(false);
    expect(AgentProfileUpdateSchema.safeParse({ profile_kind: 'a'.repeat(65) }).success).toBe(false);
    expect(
      AgentProfileUpdateSchema.safeParse({ allowed_tools: Array.from({ length: 501 }, () => 'x') }).success,
    ).toBe(false);
  });

  it('strips unknown keys rather than rejecting the whole payload', () => {
    // Matches the existing fieldMap behavior, which silently ignored extras.
    const parsed = AgentProfileUpdateSchema.safeParse({ name: 'ok', bogus: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ name: 'ok' });
  });
});

describe('AgentProfileCreateSchema', () => {
  it('accepts a payload with no name (the handler defaults it)', () => {
    expect(AgentProfileCreateSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a caller-supplied id and rejects a non-string one', () => {
    expect(AgentProfileCreateSchema.safeParse({ id: 'my-agent' }).success).toBe(true);
    expect(AgentProfileCreateSchema.safeParse({ id: 123 }).success).toBe(false);
    expect(AgentProfileCreateSchema.safeParse({ id: '' }).success).toBe(false);
  });
});

describe('ApiProviderUpsertSchema', () => {
  // The onboarding flow sends exactly this: id + name, everything else absent.
  it('accepts the partial payload the onboarding flow really sends', () => {
    const parsed = ApiProviderUpsertSchema.safeParse({ id: 'anthropic', name: 'Anthropic' });
    expect(parsed.success).toBe(true);
  });

  it('accepts the full onboarding payload including free-form options', () => {
    const parsed = ApiProviderUpsertSchema.safeParse({
      id: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-1234567890',
      isActive: true,
      options: { defaultModel: 'claude-opus-4', enabled_models: ['a', 'b'] },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires id and name (both already required by the TS type at every call site)', () => {
    expect(ApiProviderUpsertSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(ApiProviderUpsertSchema.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('rejects type-confused scalars', () => {
    const base = { id: 'p', name: 'P' };
    expect(ApiProviderUpsertSchema.safeParse({ ...base, isActive: 'true' }).success).toBe(false);
    expect(ApiProviderUpsertSchema.safeParse({ ...base, sortOrder: '1' }).success).toBe(false);
    expect(ApiProviderUpsertSchema.safeParse({ ...base, headers: 'a: b' }).success).toBe(false);
    expect(ApiProviderUpsertSchema.safeParse({ ...base, extraEnv: ['A=1'] }).success).toBe(false);
    expect(ApiProviderUpsertSchema.safeParse({ ...base, providerType: 1 }).success).toBe(false);
  });

  it('rejects an oversized API key', () => {
    expect(
      ApiProviderUpsertSchema.safeParse({ id: 'p', name: 'P', apiKey: 'k'.repeat(4001) }).success,
    ).toBe(false);
  });

  it('caps the number of entries in the request-header maps', () => {
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`H${i}`, 'v']),
    );
    expect(ApiProviderUpsertSchema.safeParse({ id: 'p', name: 'P', headers: many }).success).toBe(false);
  });

  it('accepts the partial update shape', () => {
    expect(ApiProviderPatchSchema.safeParse({ name: 'renamed' }).success).toBe(true);
    expect(ApiProviderPatchSchema.safeParse({}).success).toBe(true);
  });
});

describe('parseIpcPayload', () => {
  it('returns the parsed value on success', () => {
    expect(parseIpcPayload(RecordIdSchema, 'abc', 'some:channel')).toBe('abc');
  });

  it('throws IpcContractError naming the channel and the failing path', () => {
    let caught: unknown;
    try {
      parseIpcPayload(ApiProviderUpsertSchema, { name: 1, id: 'p' }, 'config:provider:upsert');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IpcContractError);
    const err = caught as IpcContractError;
    expect(err.channel).toBe('config:provider:upsert');
    expect(err.message).toContain('config:provider:upsert');
    expect(err.message).toContain('name');
  });
});
