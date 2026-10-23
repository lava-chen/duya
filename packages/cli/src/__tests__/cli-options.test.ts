/**
 * The Commander options of `duya`.
 *
 * ## The trap this guards
 *
 * Commander stores an option under its camelCase attribute name. Reading
 * `--client-scoped` as `getOptionValue('client-scoped')` returns `undefined`
 * instead of throwing, so the option is silently dropped. That is not
 * cosmetic: a Host asked to be client-scoped becomes one that never stops,
 * and `--api-format` and `--runtime-file` become options that do nothing.
 *
 * Only a single-word flag has the same name either way, which is why the
 * bug survived in exactly the hyphenated options.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../index.js';

const mocks = vi.hoisted(() => ({
  runChatCommand: vi.fn(async () => 0),
  runTuiCommand: vi.fn(async () => 0),
}));

vi.mock('../chat.js', () => ({ runChatCommand: mocks.runChatCommand }));
vi.mock('../tui-command.js', () => ({ runTuiCommand: mocks.runTuiCommand }));

beforeEach(() => {
  mocks.runChatCommand.mockClear();
  mocks.runTuiCommand.mockClear();
});

describe('hyphenated options', () => {
  it('reads --api-format and --runtime-file for the chat client', async () => {
    const program = buildProgram();

    await program.parseAsync([
      'node', 'duya', 'chat', '--api-format', 'openai', '--runtime-file', '/tmp/host-api.json',
    ]);

    expect(mocks.runChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({ apiFormat: 'openai', runtimeFile: '/tmp/host-api.json' }),
    );
  });

  it('reads --api-format for the TUI', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'tui', '--api-format', 'anthropic']);

    expect(mocks.runTuiCommand).toHaveBeenCalledWith(
      expect.objectContaining({ apiFormat: 'anthropic' }),
    );
  });
});
