/**
 * Unit tests for the memory wakeup helper (Plan 305 Phase B).
 *
 * Covers the three contract points from the plan's Phase B test table:
 *   1. sendMemoryWakeup calls the send callback exactly once when enabled
 *   2. sendMemoryWakeup swallows errors (shadow-mode tolerance)
 *   3. DUYA_MEMORY_ENABLED unset → no call (returns 0)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendMemoryWakeup,
  isMemoryEnabled,
} from './wakeup';

describe('sendMemoryWakeup (Plan 305 Phase B)', () => {
  const prevEnv = process.env.DUYA_MEMORY_ENABLED;
  const prevLegacyEnv = process.env.DUYA_MEMORY_V2_ENABLED;
  const prevDev = process.env.DUYA_DEV;

  beforeEach(() => {
    delete process.env.DUYA_MEMORY_ENABLED;
    delete process.env.DUYA_MEMORY_V2_ENABLED;
    delete process.env.DUYA_DEV;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.DUYA_MEMORY_ENABLED;
    } else {
      process.env.DUYA_MEMORY_ENABLED = prevEnv;
    }
    if (prevLegacyEnv === undefined) {
      delete process.env.DUYA_MEMORY_V2_ENABLED;
    } else {
      process.env.DUYA_MEMORY_V2_ENABLED = prevLegacyEnv;
    }
    if (prevDev === undefined) {
      delete process.env.DUYA_DEV;
    } else {
      process.env.DUYA_DEV = prevDev;
    }
  });

  it('1. calls send exactly once when enabled (explicit override)', () => {
    const send = vi.fn();
    const count = sendMemoryWakeup(send, { enabled: true, sessionId: 's-1' });
    expect(count).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'memory:wakeup',
      sessionId: 's-1',
    });
  });

  it('1b. calls send exactly once when DUYA_MEMORY_ENABLED=1', () => {
    process.env.DUYA_MEMORY_ENABLED = '1';
    const send = vi.fn();
    const count = sendMemoryWakeup(send);
    expect(count).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'memory:wakeup',
      sessionId: undefined,
    });
  });

  it('1c. legacy DUYA_MEMORY_V2_ENABLED=1 still honored', () => {
    process.env.DUYA_MEMORY_V2_ENABLED = '1';
    const send = vi.fn();
    const count = sendMemoryWakeup(send);
    expect(count).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('2. send failure does not throw — returns 0, logs warning', () => {
    const send = vi.fn(() => {
      throw new Error('stdout pipe closed');
    });
    // Should not throw.
    const count = sendMemoryWakeup(send, { enabled: true });
    expect(count).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('3. DUYA_MEMORY_ENABLED unset and not dev → no send call', () => {
    expect(isMemoryEnabled()).toBe(false);
    const send = vi.fn();
    const count = sendMemoryWakeup(send);
    expect(count).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('3b. DUYA_MEMORY_ENABLED=false → no send call', () => {
    process.env.DUYA_MEMORY_ENABLED = 'false';
    expect(isMemoryEnabled()).toBe(false);
    const send = vi.fn();
    const count = sendMemoryWakeup(send);
    expect(count).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('4. dev default-on — DUYA_DEV=1 alone enables wakeup', () => {
    process.env.DUYA_DEV = '1';
    expect(isMemoryEnabled()).toBe(true);
    const send = vi.fn();
    const count = sendMemoryWakeup(send);
    expect(count).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('5. dev default-on but DUYA_MEMORY_ENABLED=0 → explicit opt-out', () => {
    process.env.DUYA_DEV = '1';
    process.env.DUYA_MEMORY_ENABLED = '0';
    expect(isMemoryEnabled()).toBe(false);
    const send = vi.fn();
    const count = sendMemoryWakeup(send);
    expect(count).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
