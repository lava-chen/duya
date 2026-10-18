/**
 * `duya tui` attaching to a Host that is already running.
 *
 * ## Why the seam exists
 *
 * `runTuiCommand` always called `startLocalHost`, which spawns a real worker.
 * That is correct for a person and unusable for an automated acceptance run:
 * there was no way to point the TUI at a Host the test controls, so every such
 * run needed real credentials and a real agent turn. T12's PTY acceptance is
 * what this unblocks.
 *
 * ## The property worth guarding
 *
 * Not "attaching works" — that is the easy half. The half that matters is that
 * a stray `DUYA_TUI_HOST_ORIGIN` in someone's shell does NOT silently change
 * what the command does. Attaching to a Host you did not start, with no other
 * symptom than a session that is not where you expected, is worse than not
 * having the option.
 */
import { describe, expect, it } from 'vitest';
import { attachedHostFromEnv } from '../tui-command.js';

describe('duya tui Host attach', () => {
  it('starts its own Host when nothing is set', () => {
    // The default must be untouched: no env, no attach.
    expect(attachedHostFromEnv({})).toBeNull();
    expect(attachedHostFromEnv({ DUYA_TUI_HOST_ORIGIN: 'http://127.0.0.1:8710' })).toBeNull();
    expect(attachedHostFromEnv({ DUYA_TUI_HOST_TOKEN: 'secret' })).toBeNull();
  });

  it('attaches only when the opt-in is present too', () => {
    const host = attachedHostFromEnv({
      DUYA_TUI_ATTACH: '1',
      DUYA_TUI_HOST_ORIGIN: 'http://127.0.0.1:8710',
      DUYA_TUI_HOST_TOKEN: '  tok  ',
    });

    expect(host?.origin).toBe('http://127.0.0.1:8710');
    expect(host?.token).toBe('tok');
    // This process did not start it, so it must not shut it down.
    expect(host?.started).toBe(false);
    // The diagnostics log belongs to whoever STARTED the Host.
    expect(host?.diagnosticsLogPath).toBeUndefined();
  });

  it('treats anything other than "1" as no opt-in', () => {
    for (const flag of ['', '0', 'true', 'yes', '1 ']) {
      expect(attachedHostFromEnv({ DUYA_TUI_ATTACH: flag, DUYA_TUI_HOST_ORIGIN: 'http://x' })).toBeNull();
    }
  });

  it('refuses to attach to nothing, and says which variable is missing', () => {
    // Silently falling back to starting a Host here would attach the operator
    // to a different Host than the one they asked for — a confusing failure
    // with no message at all.
    expect(() => attachedHostFromEnv({ DUYA_TUI_ATTACH: '1' })).toThrow(/DUYA_TUI_HOST_ORIGIN/);
    expect(() => attachedHostFromEnv({ DUYA_TUI_ATTACH: '1', DUYA_TUI_HOST_ORIGIN: '   ' })).toThrow(
      /DUYA_TUI_HOST_ORIGIN/,
    );
  });

  it('closing an attached Host is a no-op, not a shutdown', async () => {
    const host = attachedHostFromEnv({ DUYA_TUI_ATTACH: '1', DUYA_TUI_HOST_ORIGIN: 'http://127.0.0.1:8710' });
    await expect(host?.close()).resolves.toBeUndefined();
  });
});
