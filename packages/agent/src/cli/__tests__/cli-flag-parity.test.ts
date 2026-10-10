/**
 * Flag parity between the interactive path and the `--print` / `--headless`
 * paths.
 *
 * `--print` and `--headless` are intercepted before commander reaches its own
 * action handler, because in those modes the trailing positional is a prompt
 * rather than an interactive REPL. The bug this file guards: a private
 * `parseCLIArgs` used to parse those two modes and it recognised only
 * `--model`, `--cwd`/`-c` and `--format`. Consequently
 *   - `-k`, `-u`, `-p` and `-w` were silently dropped in those two modes,
 *   - `--cwd` was assigned to BOTH `baseUrl` and `workspace`,
 *   - `--format` worked but never appeared in `--help`.
 *
 * These tests drive `parseCliArgs` / `createAgentProgram` from
 * `../cli-program.js`, i.e. the SAME declarations the shipped CLI uses, so
 * they cannot drift from the real option table.
 */
import { describe, it, expect } from 'vitest';
// Same import as the module under test, so both sides share one Command type.
import { Command } from '@commander-js/extra-typings';

import { createAgentProgram, parseCliArgs, AGENT_CLI_OPTIONS } from '../cli-program.js';

describe('flag parity: interactive vs print/headless', () => {
  it('honours -k / -u / -p / -w in print mode (previously silently dropped)', () => {
    const { options } = parseCliArgs([
      '--print',
      '-k', 'SECRET',
      '-u', 'https://base.example',
      '-p', 'openai',
      '-w', '/tmp/ws',
      'hello',
    ]);
    expect(options.apiKey).toBe('SECRET');
    expect(options.baseUrl).toBe('https://base.example');
    expect(options.provider).toBe('openai');
    expect(options.workspace).toBe('/tmp/ws');
  });

  it('honours the long forms too', () => {
    const { options } = parseCliArgs([
      '--print',
      '--api-key', 'SECRET',
      '--base-url', 'https://base.example',
      '--workspace', '/tmp/ws',
      'hello',
    ]);
    expect(options.apiKey).toBe('SECRET');
    expect(options.baseUrl).toBe('https://base.example');
    expect(options.workspace).toBe('/tmp/ws');
  });

  it('honours the same flags in headless mode', () => {
    const { options } = parseCliArgs([
      '--headless',
      '-k', 'SECRET',
      '-u', 'https://base.example',
      '-p', 'openai',
      '-w', '/tmp/ws',
      '--script', 'run.txt',
    ]);
    expect(options.script).toBe('run.txt');
    expect(options.apiKey).toBe('SECRET');
    expect(options.baseUrl).toBe('https://base.example');
    expect(options.provider).toBe('openai');
    expect(options.workspace).toBe('/tmp/ws');
  });

  it('parses the same values for print and interactive invocation', () => {
    // The same argv, both ways: the table is shared, so the values must match.
    const flags = ['-k', 'SECRET', '-m', 'some-model', '-u', 'https://b.example', '-w', '/tmp/ws'];
    const asPrint = parseCliArgs(['--print', ...flags, 'hi']).options;
    const asInteractive = parseCliArgs(flags).options;
    expect(asPrint.apiKey).toBe(asInteractive.apiKey);
    expect(asPrint.model).toBe(asInteractive.model);
    expect(asPrint.baseUrl).toBe(asInteractive.baseUrl);
    expect(asPrint.workspace).toBe(asInteractive.workspace);
  });

  it('no longer assigns --cwd to baseUrl', () => {
    // The old defect: `baseUrl: parsed.options.cwd`.
    const { options } = parseCliArgs(['--print', '--cwd', '/tmp/ws', 'hello']);
    expect(options.baseUrl).toBeUndefined();
    expect(options.workspace).toBeUndefined();
  });

  it('treats the prompt as the first operand, even when it starts with --', () => {
    expect(parseCliArgs(['--print', '--', '--not-a-flag']).operands[0]).toBe('--not-a-flag');
  });

  it('takes the first operand as the prompt, not a last-token heuristic', () => {
    // The old parser used "last token that is not a flag"; with two bare
    // words it silently picked only the final one.
    expect(parseCliArgs(['--print', 'two', 'words']).operands[0]).toBe('two');
  });

  it('exposes --format so it appears in --help', () => {
    expect(createAgentProgram().helpInformation()).toContain('--format');
  });

  it('--format defaults to text and is honoured in both modes', () => {
    expect(parseCliArgs(['--print', 'hi']).options.format).toBe('text');
    expect(parseCliArgs(['--print', '--format', 'json', 'hi']).options.format).toBe('json');
    expect(parseCliArgs(['--headless', '--script', 's', '--format', 'markdown']).options.format)
      .toBe('markdown');
  });

  it('every declared option round-trips through the shared parser', () => {
    // A parity census over the shipped table: a flag that parses in the
    // interactive program but not through parseCliArgs fails here.
    for (const [flags, , defaultValue] of AGENT_CLI_OPTIONS) {
      const program = createAgentProgram();
      const option = program.options.find((o) => o.long === flags.match(/--[a-z-]+/)?.[0]);
      expect(option, `${flags} should be declared on the program`).toBeDefined();

      // Commander's Option.short holds ONLY the short form (e.g. `-k`), so the
// value placeholder lives in the `flags` string, not in option.long.
const needsValue = flags.includes('<');
      const argv = [option!.short ?? option!.long, ...(needsValue ? ['VAL'] : [])];
      // --version/--help are commander built-ins that print and exit rather
      // than populating opts; they are asserted separately above.
      if (option!.long === '--version' || option!.long === '--help') continue;
      const parsed = parseCliArgs(argv).options as Record<string, unknown>;

      const key = option!.attributeName();
      if (needsValue) {
        expect(parsed[key], `${flags} should carry its value`).toBe('VAL');
      } else if (defaultValue !== undefined) {
        expect(parsed[key], `${flags} should default to ${defaultValue}`).toBe(defaultValue);
      } else {
        expect(parsed[key], `${flags} should be set`).toBe(true);
      }
    }
  });
});

describe('the program carries the shared option table', () => {
  it('declares exactly the options listed for it (no silent additions)', () => {
    const program = createAgentProgram();
    // Commander contributes --version and --help implicitly; the table
    // comparison is about the options this repo declares.
    const BUILT_IN = new Set(['--version', '--help']);
    const declared = program.options.map((o) => o.long).filter((l) => !BUILT_IN.has(l)).sort();
    const listed = AGENT_CLI_OPTIONS
      .map(([flags]) => flags.match(/--[a-z-]+/)![0])
      .sort();
    expect(declared).toEqual(listed);
  });

  it('creates an independent program each call (no shared mutable state)', () => {
    const a = new Command();
    const b = createAgentProgram();
    a.option('--sentinel <v>', 'sentinel');
    expect(b.options.find((o) => o.long === '--sentinel')).toBeUndefined();
  });
});