import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import {
  calculateMaxConcurrentWorkers,
  getWorkerMemoryThreshold,
  getWorkerMaxMemoryMB,
  getWorkerIdleTtlMs,
  isLowPowerEnv,
  selectIdleSessionIds,
  WORKER_IDLE_TTL_MS,
  WORKER_IDLE_TTL_LOW_POWER_MS,
} from '../worker-limits';

// ESM module namespace is not configurable, so os must be mocked at the
// module level rather than via vi.spyOn.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    totalmem: vi.fn(actual.totalmem),
    cpus: vi.fn(actual.cpus),
  };
});

const GB = 1024 * 1024 * 1024;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'DUYA_MAX_CONCURRENT_WORKERS',
  'DUYA_MEMORY_THRESHOLD',
  'DUYA_WORKER_MAX_MEMORY_MB',
  'DUYA_WORKER_IDLE_TTL_MS',
  'DUYA_LOW_POWER',
] as const;

function mockHardware(totalGB: number, cores: number): void {
  vi.mocked(os.totalmem).mockReturnValue(Math.round(totalGB * GB));
  vi.mocked(os.cpus).mockReturnValue(Array.from({ length: cores }, () => ({}) as os.CpuInfo));
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.mocked(os.totalmem).mockRestore();
  vi.mocked(os.cpus).mockRestore();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  vi.mocked(os.totalmem).mockRestore();
  vi.mocked(os.cpus).mockRestore();
});

describe('calculateMaxConcurrentWorkers', () => {
  it('caps at 2 on low-spec machines (<8GB RAM)', () => {
    mockHardware(4, 4);
    expect(calculateMaxConcurrentWorkers(false)).toBe(2);
  });

  it('caps at 4 on mid-range machines (<16GB RAM)', () => {
    mockHardware(8, 8);
    expect(calculateMaxConcurrentWorkers(false)).toBe(4);
  });

  it('allows 8~16 on high-end machines bounded by CPU/2', () => {
    mockHardware(32, 16);
    expect(calculateMaxConcurrentWorkers(false)).toBe(8);

    mockHardware(64, 32);
    expect(calculateMaxConcurrentWorkers(false)).toBe(16);
  });

  it('never returns below 1 even on single-core machines', () => {
    mockHardware(4, 1);
    expect(calculateMaxConcurrentWorkers(false)).toBe(1);
  });

  it('lowPower mode caps the result at 2', () => {
    mockHardware(32, 16);
    expect(calculateMaxConcurrentWorkers(true)).toBe(2);
  });

  it('env override wins and is clamped to the hard cap', () => {
    mockHardware(64, 32);
    process.env.DUYA_MAX_CONCURRENT_WORKERS = '99';
    expect(calculateMaxConcurrentWorkers()).toBe(16);

    process.env.DUYA_MAX_CONCURRENT_WORKERS = '3';
    expect(calculateMaxConcurrentWorkers()).toBe(3);
  });

  it('DUYA_LOW_POWER env is picked up by the default argument', () => {
    mockHardware(32, 16);
    process.env.DUYA_LOW_POWER = '1';
    expect(calculateMaxConcurrentWorkers()).toBe(2);
    expect(isLowPowerEnv()).toBe(true);
  });
});

describe('getWorkerMemoryThreshold', () => {
  it('defaults to 0.90', () => {
    expect(getWorkerMemoryThreshold()).toBe(0.9);
  });

  it('env override wins', () => {
    process.env.DUYA_MEMORY_THRESHOLD = '0.85';
    expect(getWorkerMemoryThreshold()).toBe(0.85);
  });

  it('invalid env values fall back to the default', () => {
    process.env.DUYA_MEMORY_THRESHOLD = '2.5';
    expect(getWorkerMemoryThreshold()).toBe(0.9);
  });
});

describe('getWorkerMaxMemoryMB', () => {
  it('gives low-spec machines 1024MB per worker', () => {
    mockHardware(4, 4);
    expect(getWorkerMaxMemoryMB()).toBe(1024);
  });

  it('gives machines with ≥8GB the default 2048MB', () => {
    mockHardware(16, 8);
    expect(getWorkerMaxMemoryMB()).toBe(2048);
  });

  it('env override wins', () => {
    mockHardware(4, 4);
    process.env.DUYA_WORKER_MAX_MEMORY_MB = '4096';
    expect(getWorkerMaxMemoryMB()).toBe(4096);
  });
});

describe('getWorkerIdleTtlMs', () => {
  it('defaults to 10 minutes', () => {
    expect(getWorkerIdleTtlMs(false)).toBe(WORKER_IDLE_TTL_MS);
    expect(WORKER_IDLE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('lowPower shortens the TTL to 4 minutes', () => {
    expect(getWorkerIdleTtlMs(true)).toBe(WORKER_IDLE_TTL_LOW_POWER_MS);
  });

  it('env override wins', () => {
    process.env.DUYA_WORKER_IDLE_TTL_MS = '60000';
    expect(getWorkerIdleTtlMs()).toBe(60000);
  });
});

describe('selectIdleSessionIds', () => {
  const now = 1_000_000;
  const ttl = WORKER_IDLE_TTL_MS;

  it('reaps settled workers idle past the TTL', () => {
    const victims = selectIdleSessionIds(
      [
        { sessionId: 'a', lastActivityAt: now - ttl - 1, keepAlive: false, state: 'COMPLETED' },
        { sessionId: 'b', lastActivityAt: now - ttl + 1000, keepAlive: false, state: 'COMPLETED' },
      ],
      now,
      ttl,
    );
    expect(victims).toEqual(['a']);
  });

  it('does not reap workers with recent activity', () => {
    const victims = selectIdleSessionIds(
      [{ sessionId: 'a', lastActivityAt: now - 1000, keepAlive: false, state: 'IDLE' }],
      now,
      ttl,
    );
    expect(victims).toEqual([]);
  });

  it('never reaps streaming/completing workers regardless of idle time', () => {
    const victims = selectIdleSessionIds(
      [
        { sessionId: 'a', lastActivityAt: now - ttl * 10, keepAlive: false, state: 'STREAMING' },
        { sessionId: 'b', lastActivityAt: now - ttl * 10, keepAlive: false, state: 'COMPLETING' },
      ],
      now,
      ttl,
    );
    expect(victims).toEqual([]);
  });

  it('exempts keepAlive sessions', () => {
    const victims = selectIdleSessionIds(
      [{ sessionId: 'cron-shared', lastActivityAt: now - ttl * 10, keepAlive: true, state: 'IDLE' }],
      now,
      ttl,
    );
    expect(victims).toEqual([]);
  });

  it('treats a missing lastActivityAt as just spawned (not reaped)', () => {
    const victims = selectIdleSessionIds(
      [{ sessionId: 'a', lastActivityAt: undefined, keepAlive: false, state: 'IDLE' }],
      now,
      ttl,
    );
    expect(victims).toEqual([]);
  });
});
