import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { TuiSlashCommandDef } from './types.js';

const FILE = path.join(homedir(), '.duya', 'tui-presets.json');
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39}$/u;

export function readPromptPresets(file = FILE): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => NAME.test(key) && typeof value === 'string'));
  } catch {
    return {};
  }
}

export function writePromptPresets(presets: Readonly<Record<string, string>>, file = FILE): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(presets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

const PRESETS: TuiSlashCommandDef = {
  name: 'presets',
  description: 'Save and reuse prompt templates',
  group: 'Settings',
  async run(ctx, args) {
    const [verb = 'list', ...tail] = args.trim().split(/\s+/u);
    const presets = readPromptPresets();
    if (verb === 'list') {
      const entries = Object.entries(presets).sort(([a], [b]) => a.localeCompare(b));
      if (args.trim() === '' && entries.length > 0 && ctx.tui.showListPanel !== undefined) {
        ctx.tui.showListPanel('Prompt presets', entries.map(([name, prompt]) => ({
          value: name,
          label: name,
          description: prompt.replace(/\s+/gu, ' ').slice(0, 100),
        })), {
          footer: 'Enter load into composer · Esc close',
          onEnter: (name) => {
            const prompt = presets[name];
            if (prompt === undefined) return;
            ctx.actions?.insertPrompt?.(prompt);
            ctx.tui.printNotice(`Loaded “${name}” into the composer. Review it before submitting.`);
          },
        });
        return { kind: 'handled' };
      }
      const lines = entries.map(([name, prompt]) =>
        `${name}  ${prompt.replace(/\s+/gu, ' ').slice(0, 100)}`);
      ctx.tui.showPanel?.('Prompt presets', lines.length ? lines : ['No saved presets. Use /presets save <name> <prompt>.'], {
        footer: '/presets use <name> to load · Esc close', scrollable: true,
      });
      return { kind: 'handled' };
    }
    if (verb === 'save') {
      const name = tail.shift() ?? '';
      const prompt = tail.join(' ');
      if (!NAME.test(name) || prompt.trim() === '' || prompt.length > 16_000) {
        ctx.tui.printNotice('Usage: /presets save <name> <prompt> (prompt limit: 16,000 characters).');
        return { kind: 'handled' };
      }
      presets[name] = prompt;
      writePromptPresets(presets);
      ctx.tui.printNotice(`Saved prompt preset “${name}”.`);
      return { kind: 'handled' };
    }
    if (verb === 'use') {
      const name = tail[0] ?? '';
      const prompt = presets[name];
      if (prompt === undefined) ctx.tui.printError(`No prompt preset named “${name}”.`);
      else {
        ctx.actions?.insertPrompt?.(prompt);
        ctx.tui.printNotice(`Loaded “${name}” into the composer. Review it before submitting.`);
      }
      return { kind: 'handled' };
    }
    if (verb === 'delete') {
      const name = tail[0] ?? '';
      if (presets[name] === undefined) ctx.tui.printError(`No prompt preset named “${name}”.`);
      else {
        delete presets[name];
        writePromptPresets(presets);
        ctx.tui.printNotice(`Deleted prompt preset “${name}”.`);
      }
      return { kind: 'handled' };
    }
    ctx.tui.printNotice('Usage: /presets [list|save <name> <prompt>|use <name>|delete <name>].');
    return { kind: 'handled' };
  },
};

export const PRESET_COMMANDS: readonly TuiSlashCommandDef[] = [PRESETS];
