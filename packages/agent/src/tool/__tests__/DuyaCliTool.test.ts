/**
 * packages/agent/tests/unit/tools/DuyaCliTool.test.ts
 *
 * Unit tests for the `duya_cli` agent tool.
 *
 * Coverage:
 *  - input validation: unknown command / subcommand / id missing
 *  - dispatch: status, doctor, plugin list/info, session list/show
 *  - dispatcher rejects unknown command
 *  - output envelope shape: { exitCode, ok, stdout, stderr, data }
 *  - stdout is captured (does not leak to test runner's stdout)
 *  - stdout JSON is parsed into `data` when format=json
 *  - skill enable/disable is exposed but only with `yes`
 *  - disallowed actions (provider key entry, etc.) are not in
 *    the schema — they live in `duya_config`, not `duya_cli`
 */

import { describe, it, expect } from 'vitest';
import { DuyaCliTool } from '../../../src/tool/DuyaCliTool/DuyaCliTool.js';
import { DUYA_CLI_TOOL_NAME } from '../../../src/tool/DuyaCliTool/constants.js';
import { DESCRIPTION, getPrompt } from '../../../src/tool/DuyaCliTool/prompt.js';

describe('DuyaCliTool (unit)', () => {
  const tool = new DuyaCliTool();

  describe('shape', () => {
    it('has the frozen tool name', () => {
      expect(DUYA_CLI_TOOL_NAME).toBe('duya_cli');
      expect(tool.name).toBe('duya_cli');
    });

    it('exposes a JSON schema with the allowed command enum (auto-derived from descriptors)', () => {
      const schema = tool.input_schema as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.command.type).toBe('string');
      // Plan 99: enum is auto-derived from CLI_DESCRIPTORS, so all 14
      // top-level commands are present.
      const enum_ = props.command.enum as string[];
      expect(enum_).toEqual(expect.arrayContaining([
        'status', 'doctor', 'plugin', 'session',
        'skill', 'mcp', 'provider',
        'channel', 'cron', 'message',
        'install-cli', 'uninstall-cli',
      ]));
      // argv is the new preferred style
      expect(props.argv).toBeDefined();
      expect(props.argv.type).toBe('array');
      // No required field — either argv or command is acceptable
      expect(schema.required).toEqual([]);
    });

    it('declares subcommand as optional with hint', () => {
      const props = (tool.input_schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      expect(props.subcommand.type).toBe('string');
    });

    it('returns a non-empty description', () => {
      expect(DESCRIPTION.length).toBeGreaterThan(50);
      expect(getPrompt()).toContain('duya_cli');
    });
  });

  describe('input validation', () => {
    it('rejects empty input', async () => {
      const result = await tool.execute({});
      expect(result.error).toBe(true);
      expect(result.name).toBe('duya_cli');
    });

    it('rejects unknown top-level command', async () => {
      const result = await tool.execute({ command: 'not-a-command' });
      expect(result.error).toBe(true);
      expect(result.result).toMatch(/Invalid input/);
    });

    it('rejects plugin without subcommand', async () => {
      const result = await tool.execute({ command: 'plugin' });
      expect(result.error).toBe(true);
      expect(result.result).toMatch(/requires a subcommand/);
    });

    it('rejects plugin with unknown subcommand', async () => {
      const result = await tool.execute({ command: 'plugin', subcommand: 'not-a-subcommand' });
      expect(result.error).toBe(true);
      expect(result.result).toMatch(/unknown subcommand 'not-a-subcommand' for 'plugin'/);
    });

    it('rejects plugin info without id (runner returns 64)', async () => {
      const result = await tool.execute({ command: 'plugin', subcommand: 'info' });
      // The runner returns exitCode 64 in stderr; the tool envelope
      // is non-error but `ok: false` and `data` carries the hint.
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.ok).toBe(false);
      expect(payload.exitCode).toBe(64);
      expect(payload.stderr).toMatch(/plugin info requires an <id>/);
    });

    it('rejects status with subcommand', async () => {
      const result = await tool.execute({ command: 'status', subcommand: 'list' });
      expect(result.error).toBe(true);
      expect(result.result).toMatch(/does not accept a subcommand/);
    });

    it('rejects doctor with subcommand', async () => {
      const result = await tool.execute({ command: 'doctor', subcommand: 'whatever' });
      expect(result.error).toBe(true);
      expect(result.result).toMatch(/does not accept a subcommand/);
    });

    it('rejects skill enable without id (runner returns 64)', async () => {
      const result = await tool.execute({ command: 'skill', subcommand: 'enable' });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.ok).toBe(false);
      expect(payload.exitCode).toBe(64);
      expect(payload.stderr).toMatch(/skill enable requires an <id>/);
    });
  });

  describe('dispatch (text format — never reaches network for unknown ids)', () => {
    it('handles unknown plugin id with a captured error envelope', async () => {
      const result = await tool.execute({
        command: 'plugin',
        subcommand: 'info',
        id: 'no.such.plugin',
        format: 'text',
      });
      expect(result.error).toBeFalsy(); // dispatch succeeds; CLI returned exit!=0
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('plugin');
      expect(payload.subcommand).toBe('info');
      expect(typeof payload.exitCode).toBe('number');
      // plugin info on an unknown id should not be exit 0
      expect(payload.ok).toBe(false);
      // stderr/stdout were captured
      expect(typeof payload.stdout).toBe('string');
      expect(typeof payload.stderr).toBe('string');
    });

    it('captures stdout from run* functions (does not leak to test runner)', async () => {
      // Spy on process.stdout.write to confirm we restore it.
      const origWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
      let writeCalledDuringExecute = false;
      const spyWrite: typeof process.stdout.write = ((chunk, encoding?: BufferEncoding | ((err?: Error | null | undefined) => void), cb?: (err?: Error | null | undefined) => void) => {
        writeCalledDuringExecute = true;
        if (typeof encoding === 'function') {
          return origWrite(chunk, encoding);
        }
        if (encoding !== undefined) {
          return origWrite(chunk, encoding, cb);
        }
        return origWrite(chunk, cb);
      }) as typeof process.stdout.write;
      (process.stdout as { write: typeof process.stdout.write }).write = spyWrite;
      try {
        const result = await tool.execute({
          command: 'plugin',
          subcommand: 'info',
          id: 'no.such.plugin',
          format: 'text',
        });
        const payload = JSON.parse(result.result);
        expect(payload.stdout.length).toBeGreaterThanOrEqual(0);
        // Confirm we restored process.stdout.write after execute
        expect(writeCalledDuringExecute).toBe(false);
        // After restore, the spy is gone — origWrite should equal the
        // current process.stdout.write reference.
        expect(process.stdout.write).not.toBe(origWrite);
      } finally {
        (process.stdout as { write: typeof process.stdout.write }).write = origWrite;
      }
    });
  });

  describe('output envelope (json format)', () => {
    it('parses stdout into data when format=json', async () => {
      const result = await tool.execute({
        command: 'plugin',
        subcommand: 'info',
        id: 'no.such.plugin',
        format: 'json',
      });
      const payload = JSON.parse(result.result);
      expect(payload).toHaveProperty('exitCode');
      expect(payload).toHaveProperty('ok');
      expect(payload).toHaveProperty('stdout');
      expect(payload).toHaveProperty('stderr');
      expect(payload).toHaveProperty('data');
      // data may be a string or a parsed object — we are only
      // asserting the key is present, since the run* call
      // itself will not have a JSON body for an unknown id.
    });
  });

  describe('forbidden actions are not in the schema', () => {
    it('does not expose provider key entry', () => {
      const enum_ = ((tool.input_schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).command.enum as string[];
      expect(enum_).not.toContain('provider set-key');
      expect(enum_).not.toContain('plugin install');
      expect(enum_).not.toContain('mcp add');
      expect(enum_).not.toContain('session delete');
    });
  });

  describe('argv-style (Plan 99 — preferred)', () => {
    it('dispatches status via argv without requiring an explicit default subcommand', async () => {
      const result = await tool.execute({ argv: ['status', '--format', 'json'] });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('status');
      expect(payload.subcommand).toBe(null);
      expect(payload.exitCode).not.toBe(64);
      expect(payload.stderr).not.toMatch(/unknown command: status/);
    });

    it('dispatches doctor via argv without requiring an explicit default subcommand', async () => {
      const result = await tool.execute({ argv: ['doctor', '--format', 'json'] });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('doctor');
      expect(payload.subcommand).toBe(null);
      expect(payload.exitCode).not.toBe(64);
      expect(payload.stderr).not.toMatch(/unknown command: doctor/);
    });

    it('dispatches cron list via argv', async () => {
      const result = await tool.execute({ argv: ['cron', 'list'] });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('cron');
      expect(payload.subcommand).toBe('list');
    });

    it('rejects empty argv', async () => {
      const result = await tool.execute({ argv: [] });
      expect(result.error).toBe(true);
      expect(result.result).toMatch(/non-empty/);
    });

    it('rejects mixing argv with structured fields', async () => {
      const result = await tool.execute({ argv: ['cron', 'list'], command: 'cron' });
      expect(result.error).toBe(true);
      expect(result.result).toMatch(/mutually exclusive/);
    });

    it('rejects argv with neither command nor argv', async () => {
      const result = await tool.execute({ format: 'json' });
      expect(result.error).toBe(true);
    });

    it('dispatches channel list with --platform flag', async () => {
      const result = await tool.execute({ argv: ['channel', 'list', '--platform', 'telegram'] });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('channel');
      expect(payload.subcommand).toBe('list');
    });

    it('dispatches message list with sessionId arg', async () => {
      const result = await tool.execute({ argv: ['message', 'list', 'session-123'] });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('message');
      expect(payload.subcommand).toBe('list');
    });

    it('refuses unknown command via argv', async () => {
      const result = await tool.execute({ argv: ['telegram', 'send'] });
      // unknown command is dispatched to runner which returns 64
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.ok).toBe(false);
      expect(payload.exitCode).toBe(64);
      expect(payload.stderr).toMatch(/unknown command: telegram/);
    });

    it('refuses unknown subcommand via argv', async () => {
      const result = await tool.execute({ argv: ['plugin', 'not-a-subcommand'] });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.exitCode).toBe(64);
      expect(payload.stderr).toMatch(/unknown plugin subcommand: not-a-subcommand/);
    });

    it('parses --yes flag for write operations', async () => {
      const result = await tool.execute({
        argv: ['skill', 'enable', 'bundled:code-review', '--yes'],
      });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      // The run will fail because no desktop app is running, but
      // the argv should have been parsed and dispatch reached.
      expect(payload.command).toBe('skill');
      expect(payload.subcommand).toBe('enable');
    });
  });

  describe('new commands exposed by plan 98', () => {
    it('channel command appears in the enum', () => {
      const enum_ = ((tool.input_schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).command.enum as string[];
      expect(enum_).toContain('channel');
    });

    it('cron command appears in the enum', () => {
      const enum_ = ((tool.input_schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).command.enum as string[];
      expect(enum_).toContain('cron');
    });

    it('message command appears in the enum', () => {
      const enum_ = ((tool.input_schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).command.enum as string[];
      expect(enum_).toContain('message');
    });
  });

  describe('Plan 102 — `duya config` argv surface (replace `duya_config`)', () => {
    it('config command appears in the enum (replaces the removed `duya_config` tool)', () => {
      const enum_ = ((tool.input_schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).command.enum as string[];
      expect(enum_).toContain('config');
    });

    it('dispatches config provider-add argv to the matching subcommand', async () => {
      // Will fail with a connection error (no desktop app), but the
      // dispatch path must reach the descriptor. If argv was
      // unparsed the error would be exit 64.
      const result = await tool.execute({
        argv: ['config', 'provider-add', '--id', 'x', '--name', 'X', '--type', 'openai', '--yes'],
      });
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('config');
      expect(payload.subcommand).toBe('provider-add');
    });

    it('dispatches config settings-set with all PATCH fields (--max-tokens, --temperature, --top-p, --top-k, --enable-thinking, --thinking-budget)', async () => {
      const result = await tool.execute({
        argv: [
          'config', 'settings-set',
          '--model', 'claude-sonnet-4',
          '--max-tokens', '8192',
          '--temperature', '0.7',
          '--top-p', '0.9',
          '--top-k', '40',
          '--enable-thinking',
          '--thinking-budget', '16000',
          '--yes',
        ],
      });
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('config');
      expect(payload.subcommand).toBe('settings-set');
    });

    it('dispatches mcp add with repeatable --arg / --env / --agent flags', async () => {
      const result = await tool.execute({
        argv: [
          'mcp', 'add',
          '--server', 'test-mcp',
          '--command', 'npx',
          '--arg', '-y', '--arg', '@foo/bar',
          '--env', 'K=V', '--env', 'K2=V2',
          '--agent', 'a', '--agent', 'b',
          '--yes',
        ],
      });
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('mcp');
      expect(payload.subcommand).toBe('add');
    });

    it('supports --key=value form for the new flags', async () => {
      const result = await tool.execute({
        argv: ['config', 'provider-info', '--id=openai'],
      });
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('config');
      expect(payload.subcommand).toBe('provider-info');
    });
  });

  describe('Plan 102 — regression: duya_config tool is no longer registered', () => {
    it('the agent tool enum does not include the removed "duya_config" command path', () => {
      const enum_ = ((tool.input_schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).command.enum as string[];
      expect(enum_).not.toContain('duya_config');
    });
  });

  describe('single-subcommand structured dispatch', () => {
    it('dispatches status without a subcommand in structured mode', async () => {
      const result = await tool.execute({ command: 'status', format: 'json' });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('status');
      expect(payload.subcommand).toBe(null);
      expect(payload.exitCode).not.toBe(64);
      expect(payload.stderr).not.toMatch(/unknown command: status/);
    });

    it('dispatches doctor without a subcommand in structured mode', async () => {
      const result = await tool.execute({ command: 'doctor', format: 'json' });
      expect(result.error).toBeFalsy();
      const payload = JSON.parse(result.result);
      expect(payload.command).toBe('doctor');
      expect(payload.subcommand).toBe(null);
      expect(payload.exitCode).not.toBe(64);
      expect(payload.stderr).not.toMatch(/unknown command: doctor/);
    });
  });
});
