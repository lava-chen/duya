/**
 * timers.ts — injectable timer surface.
 *
 * Every wait this transport performs (HTTP timeout, reconnect backoff, rate
 * spacing, heartbeat) goes through this interface so tests can drive time
 * deterministically instead of sleeping. The defaults read `globalThis` at call
 * time, so `vi.useFakeTimers()` in a test also works without injection.
 */

export interface DiscordTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemTimers: DiscordTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};
