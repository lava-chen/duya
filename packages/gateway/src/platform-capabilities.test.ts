import { describe, expect, it } from 'vitest';

import { PLATFORM_TYPES, type PlatformCapability, type PlatformType } from './types.js';
import {
  PLATFORM_DESCRIPTORS,
  getPlatformDescriptor,
  getPlatformCapabilities,
  isKnownPlatform,
  listPlatforms,
  supportsCapability,
} from './platform-capabilities.js';
import './adapters/index.js';
import { createAdapter, getRegisteredPlatforms } from './adapters/base.js';

/**
 * The capability table is only useful if it cannot drift away from reality.
 * These tests fail when a descriptor is added without an adapter, or when an
 * adapter advertises a capability it does not implement.
 */
describe('platform capability matrix', () => {
  it('has a descriptor for every PlatformType and nothing else', () => {
    expect(listPlatforms().sort()).toEqual([...PLATFORM_TYPES].sort());
    expect(Object.keys(PLATFORM_DESCRIPTORS).sort()).toEqual([...PLATFORM_TYPES].sort());
  });

  it('every platform registers a real adapter factory', () => {
    const registered = new Set(getRegisteredPlatforms());
    for (const platform of listPlatforms()) {
      expect(registered.has(platform), `missing adapter registration for ${platform}`).toBe(true);
    }
  });

  it('every descriptor declares the text capability and a positive length limit', () => {
    for (const platform of listPlatforms()) {
      const descriptor = getPlatformDescriptor(platform);
      expect(descriptor.capabilities, platform).toContain('text');
      expect(descriptor.maxMessageLength, platform).toBeGreaterThan(0);
      expect(descriptor.displayName.length, platform).toBeGreaterThan(0);
    }
  });

  it('port-binding descriptors declare a default port and path', () => {
    for (const platform of listPlatforms()) {
      const descriptor = getPlatformDescriptor(platform);
      if (!descriptor.bindsPort) continue;
      expect(descriptor.defaultPort, platform).toBeGreaterThan(0);
      expect(descriptor.webhookPath, platform).toMatch(/^\//);
    }
  });

  it('required credentials are non-empty and secrets are marked', () => {
    for (const platform of listPlatforms()) {
      const descriptor = getPlatformDescriptor(platform);
      for (const field of descriptor.credentialFields) {
        expect(field.key.length, platform).toBeGreaterThan(0);
        expect(field.label.length, platform).toBeGreaterThan(0);
      }
      // A webhook channel with no secret at all would be unauthenticated.
      const hasSecret = descriptor.credentialFields.some((f) => f.secret);
      if (descriptor.bindsPort) expect(hasSecret, platform).toBe(true);
    }
  });
});

/** Capabilities that imply a concrete adapter method. */
const METHOD_BACKED: Partial<Record<PlatformCapability, string>> = {
  typing: 'sendTyping',
  'typing-stop': 'stopTyping',
  reaction: 'setMessageReaction',
  'message-delete': 'deleteMessage',
};

describe('declared capabilities are backed by adapter methods', () => {
  for (const platform of PLATFORM_TYPES) {
    const expected = Object.entries(METHOD_BACKED).filter(([capability]) =>
      supportsCapability(platform, capability as PlatformCapability),
    );

    if (expected.length === 0) continue;

    it(`${platform} implements every method-backed capability it declares`, () => {
      const adapter = createAdapter(platform) as unknown as Record<string, unknown> | null;
      expect(adapter, `no adapter for ${platform}`).not.toBeNull();
      for (const [capability, method] of expected) {
        expect(typeof adapter?.[method], `${platform} claims ${capability} but has no ${method}()`)
          .toBe('function');
      }
    });
  }
});

describe('capability lookup helpers', () => {
  it('reports unknown platforms as unknown instead of throwing', () => {
    expect(isKnownPlatform('telegram')).toBe(true);
    expect(isKnownPlatform('myspace')).toBe(false);
    expect(getPlatformCapabilities('myspace' as PlatformType)).toEqual([]);
    expect(supportsCapability('myspace' as PlatformType, 'text')).toBe(false);
  });

  it('throws for an unknown descriptor instead of returning undefined', () => {
    expect(() => getPlatformDescriptor('myspace' as PlatformType)).toThrow(/Unknown platform/);
  });

  it('keeps the newly added channels in the matrix', () => {
    for (const platform of ['whatsapp_cloud', 'signal', 'bluebubbles', 'webhook', 'msgraph'] as const) {
      expect(isKnownPlatform(platform), platform).toBe(true);
      expect(supportsCapability(platform, 'text'), platform).toBe(true);
    }
  });

  it('inbound-only channels do not claim outbound media', () => {
    for (const platform of ['webhook', 'msgraph'] as const) {
      expect(supportsCapability(platform, 'outbound-media'), platform).toBe(false);
      expect(getPlatformCapabilities(platform), platform).toEqual(['text', 'inbound-callback']);
    }
  });
});
