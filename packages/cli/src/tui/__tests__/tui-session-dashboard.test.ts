import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { TUIApp } from '../TUIApp.js';
import { detectTerminalEnvironment } from '../terminal-env.js';

function harness() {
  const chunks: Buffer[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  Object.assign(output, { columns: 80, rows: 24, isTTY: true });
  const input = new PassThrough();
  const submitted: string[] = [];
  const opened: string[] = [];
  const app = new TUIApp({
    output,
    input,
    inline: true,
    terminalEnv: detectTerminalEnvironment({ TERM_PROGRAM: 'WezTerm' }),
    onSubmit: () => {},
    onSessionDashboardSubmit: (prompt) => { submitted.push(prompt); },
    onSessionDashboardOpen: (id) => { opened.push(id); },
  });
  return { app, input, chunks, submitted, opened };
}

const settle = async () => new Promise((resolve) => setTimeout(resolve, 150));

describe('sessions dashboard', () => {
  it('groups sessions by state and starts a separate session from its composer', async () => {
    const h = harness();
    h.app.setSessionDashboardEntries([
      { id: 's1', title: 'Needs review', status: 'needs_input' },
      { id: 's2', title: 'Building feature', status: 'working' },
      { id: 's3', title: 'Finished task', status: 'completed' },
    ]);
    h.app.openSessionsDashboard();
    h.app.start();
    await settle();
    h.app.insertPrompt('start another task');
    h.input.write('\r');
    await settle();
    h.app.stop();

    const rendered = Buffer.concat(h.chunks).toString('utf8');
    expect(rendered).toContain('Needs input');
    expect(rendered).toContain('Working');
    expect(rendered).toContain('Completed');
    expect(h.submitted).toEqual(['start another task']);
    expect(h.app.renderState.focus).toBe('sessions');
  });

  it('opens the selected session when the composer is empty', async () => {
    const h = harness();
    h.app.setSessionDashboardEntries([{ id: 'session-1', title: 'First session', status: 'working' }]);
    h.app.openSessionsDashboard();
    h.app.start();
    await settle();
    h.input.write('\r');
    await settle();
    h.app.stop();

    expect(h.opened).toEqual(['session-1']);
  });

  it('opens a session row on a mouse click', async () => {
    const h = harness();
    h.app.setSessionDashboardEntries([{ id: 'session-click', title: 'Clickable session', status: 'working' }]);
    h.app.start();
    h.app.openSessionsDashboard();
    await settle();
    const pointer = (h.app as unknown as { pointer: { targetAt(x: number, y: number): { id: string } | undefined } }).pointer;
    const y = Array.from({ length: 24 }, (_, row) => row).find((row) =>
      pointer.targetAt(4, row)?.id === 'session-dashboard:session-click');
    expect(y).toBeDefined();
    const row = y ?? -1;
    h.input.write(`\x1b[<0;5;${row + 1}M\x1b[<0;5;${row + 1}m`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    h.app.stop();

    expect(h.opened).toEqual(['session-click']);
  });
});
