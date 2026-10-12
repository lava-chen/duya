/**
 * OverlayState as a permission QUEUE with a codex-style picker.
 *
 * Plan 611 Wave 4 (P0-2): the overlay used to hold exactly one request with
 * three single-key answers. It now queues concurrent asks (parallel tool
 * calls), navigates, stages destructive allows behind a second Enter, and
 * times out on the request's own deadline. These tests pin each behaviour at
 * the state level — no terminal, no blessed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  OverlayState,
  isDestructiveRequest,
  renderOverlay,
  type OverlayRequest,
  type PermissionDecision,
} from '../overlay.js';

function request(overrides: Partial<OverlayRequest> = {}): OverlayRequest {
  return {
    requestId: 'req-1',
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    reason: 'requires approval',
    ...overrides,
  };
}

/** Show one request and capture its resolution. */
function ask(state: OverlayState, req: OverlayRequest = request()): Array<PermissionDecision | null> {
  const resolved: Array<PermissionDecision | null> = [];
  state.show(req, (decision) => resolved.push(decision));
  return resolved;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the picker', () => {
  it('answers y/a/n directly on a non-destructive request', () => {
    for (const [key, expected] of [
      ['y', 'once'],
      ['a', 'always'],
      ['n', 'deny'],
    ] as const) {
      const state = new OverlayState();
      const resolved = ask(state, request({ requestId: `req-${key}` }));
      state.handleKey({ name: key });
      expect(resolved).toEqual([expected]);
      expect(state.isActive).toBe(false);
    }
  });

  it('navigates with arrows and confirms with Enter', () => {
    const state = new OverlayState();
    const resolved = ask(state);
    state.handleKey({ name: 'down' });
    state.handleKey({ name: 'down' }); // wraps to deny
    expect(state.selection).toBe(2);
    state.handleKey({ name: 'return' });
    expect(resolved).toEqual(['deny']);
  });

  it('picks by number keys 1-3', () => {
    const state = new OverlayState();
    const resolved = ask(state);
    state.handleKey({ name: '2' });
    expect(resolved).toEqual(['always']);
  });

  it('ignores keys that mean nothing to the picker', () => {
    const state = new OverlayState();
    ask(state);
    expect(state.handleKey({ name: 'x' })).toBe(false);
    expect(state.handleKey({ ch: 'z' })).toBe(false);
    expect(state.isActive).toBe(true);
  });
});

describe('the destructive second-Enter staging', () => {
  it('stages the first allow press and confirms the second', () => {
    const state = new OverlayState();
    const resolved = ask(state, request({
      requestId: 'req-destructive',
      toolInput: { command: 'rm -rf ./build' },
      destructive: true,
    }));
    state.handleKey({ name: 'y' });
    expect(state.isStaged).toBe(true);
    expect(resolved).toEqual([]);
    state.handleKey({ name: 'y' });
    expect(resolved).toEqual(['once']);
  });

  it('stages from the list row and confirms with Enter on the same row', () => {
    const state = new OverlayState();
    const resolved = ask(state, request({ requestId: 'req-d2', destructive: true }));
    state.handleKey({ name: 'down' }); // row 2: always
    state.handleKey({ name: 'return' }); // stage
    expect(state.isStaged).toBe(true);
    state.handleKey({ name: 'return' }); // confirm
    expect(resolved).toEqual(['always']);
  });

  it('un-stages when the selection moves', () => {
    const state = new OverlayState();
    const resolved = ask(state, request({ requestId: 'req-d3', destructive: true }));
    state.handleKey({ name: 'y' });
    expect(state.isStaged).toBe(true);
    state.handleKey({ name: 'up' });
    expect(state.isStaged).toBe(false);
    state.handleKey({ name: 'return' }); // row 1 now (y row wrapped? no: up from 0 wraps to deny)
    expect(resolved).toEqual(['deny']);
  });

  it('never stages a deny', () => {
    const state = new OverlayState();
    const resolved = ask(state, request({ requestId: 'req-d4', destructive: true }));
    state.handleKey({ name: 'n' });
    expect(resolved).toEqual(['deny']);
    expect(state.isStaged).toBe(false);
  });

  it('does not stage at all without the destructive flag', () => {
    const state = new OverlayState();
    const resolved = ask(state);
    state.handleKey({ name: 'y' });
    expect(resolved).toEqual(['once']);
  });
});

describe('the queue', () => {
  it('holds concurrent asks and reveals the next after the head is answered', () => {
    const state = new OverlayState();
    const first = ask(state, request({ requestId: 'q1' }));
    const second = ask(state, request({ requestId: 'q2' }));
    expect(state.queueDepth).toBe(1);
    state.handleKey({ name: 'y' });
    expect(first).toEqual(['once']);
    expect(state.isActive).toBe(true);
    expect(state.request?.requestId).toBe('q2');
    expect(state.queueDepth).toBe(0);
    state.handleKey({ name: 'n' });
    expect(second).toEqual(['deny']);
    expect(state.isActive).toBe(false);
  });

  it('abortAll resolves the head and everything queued with null', () => {
    const state = new OverlayState();
    const all = [
      ask(state, request({ requestId: 'a1' })),
      ask(state, request({ requestId: 'a2' })),
      ask(state, request({ requestId: 'a3' })),
    ];
    state.abortAll();
    expect(all.map((entry) => entry[0])).toEqual([null, null, null]);
    expect(state.isActive).toBe(false);
    expect(state.queueDepth).toBe(0);
  });

  it('renders the waiting count in the body', () => {
    const state = new OverlayState();
    ask(state, request({ requestId: 'v1' }));
    ask(state, request({ requestId: 'v2' }));
    const body = state.body(true) ?? '';
    expect(body).toContain('+1 more request waiting');
  });
});

describe('the deadline', () => {
  it('settles as null when expiresAt passes', () => {
    vi.useFakeTimers();
    const state = new OverlayState();
    const resolved = ask(state, request({
      requestId: 'req-timeout',
      expiresAt: Date.now() + 1_000,
    }));
    vi.advanceTimersByTime(1_100);
    expect(resolved).toEqual([null]);
    expect(state.isActive).toBe(false);
  });

  it('moves to the next queued ask when the head times out', () => {
    vi.useFakeTimers();
    const state = new OverlayState();
    const first = ask(state, request({ requestId: 't1', expiresAt: Date.now() + 500 }));
    const second = ask(state, request({ requestId: 't2' }));
    vi.advanceTimersByTime(600);
    expect(first).toEqual([null]);
    expect(state.request?.requestId).toBe('t2');
    second; // still pending
    state.handleKey({ name: 'y' });
    expect(second).toEqual(['once']);
  });

  it('carries no timer when expiresAt is absent', () => {
    vi.useFakeTimers();
    const state = new OverlayState();
    const resolved = ask(state);
    vi.advanceTimersByTime(10_000);
    expect(resolved).toEqual([]);
    expect(state.isActive).toBe(true);
  });
});

describe('isDestructiveRequest', () => {
  it('flags recursive deletion, hard resets, forced pushes and raw device writes', () => {
    const destructive: Array<[string, unknown]> = [
      ['Bash', { command: 'rm -rf /tmp/x' }],
      ['Bash', { command: 'rm -r build/' }],
      ['Bash', { command: 'git reset --hard HEAD~3' }],
      ['Bash', { command: 'git push --force origin main' }],
      ['Bash', { command: 'git clean -fd' }],
      ['Bash', { command: 'dd if=/dev/zero of=/dev/sda' }],
      ['Bash', { command: 'del /s /q C:\\temp' }],
      ['Bash', { command: 'Remove-Item -Recurse -Force ./node_modules' }],
    ];
    for (const [toolName, toolInput] of destructive) {
      expect(isDestructiveRequest(toolName, toolInput)).toBe(true);
    }
  });

  it('passes ordinary commands and non-command tools through', () => {
    expect(isDestructiveRequest('Bash', { command: 'echo hello' })).toBe(false);
    expect(isDestructiveRequest('Bash', { command: 'npm test' })).toBe(false);
    expect(isDestructiveRequest('Write', { path: '/etc/passwd' })).toBe(false);
    expect(isDestructiveRequest('Bash', { other: 1 })).toBe(false);
  });
});

describe('renderOverlay', () => {
  it('lists the picker rows with the selection marker', () => {
    const body = renderOverlay(request(), true, { selectedIndex: 1, staged: false, queueDepth: 0 });
    // The marker carries its tag; the row text follows it.
    expect(body).toContain('{cyan-fg}❯{/cyan-fg} [2] Always allow');
    expect(body).toContain('  [1] Allow once');
    expect(body).toContain('  [3] Deny');
  });

  it('shows the staging hint only on the staged row', () => {
    const body = renderOverlay(request({ destructive: true }), true, {
      selectedIndex: 0,
      staged: true,
      queueDepth: 0,
    });
    expect(body).toContain('press Enter again to confirm');
    expect(body).toContain('destructive command');
  });

  it('keeps the honest no-responder body when not answerable', () => {
    const body = renderOverlay(request(), false);
    expect(body).toContain('no permission responder is attached');
    expect(body).not.toContain('Allow once');
  });
});
