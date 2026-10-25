import type { SessionCheckoutCommand } from '@duya/agent-protocol';
import type { TuiSlashCommandDef } from './types.js';
import { showPanel, describeError } from './shared.js';

export function parseWorktreeArguments(args: string): SessionCheckoutCommand {
  const words = args.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map((word) => /^(["']).*\1$/.test(word) ? word.slice(1, -1) : word) ?? [];
  const operation = words.shift() ?? 'status';
  if (operation === 'status' || operation === 'recover') {
    if (words.length) throw new Error('This action takes no arguments.');
    return { action: operation };
  }
  if (operation === 'exit') {
    if (words.length > 1 || (words[0] && words[0] !== 'keep' && words[0] !== 'remove')) throw new Error('Use /worktree exit [keep|remove].');
    return { action: 'exit', disposition: words[0] === 'remove' ? 'remove' : 'keep' };
  }
  if (operation === 'abort') return { action: 'sync', abort: true };
  if (operation === 'sync') return { action: 'sync', ...(words.length ? { base: words.join(' ') } : {}) };
  if (operation === 'enter') {
    if (!words.length) throw new Error('Use /worktree enter <registered-path>.');
    return { action: 'enter', path: words.join(' ') };
  }
  if (operation === 'create') {
    const name = words.shift();
    if (!name) throw new Error('Use /worktree create <name> [--base <ref>] [--branch <name>].');
    let base: string | undefined;
    let branchName: string | undefined;
    while (words.length) {
      const key = words.shift(); const value = words.shift();
      if (!value || (key !== '--base' && key !== '--branch')) throw new Error('Expected --base <ref> or --branch <name>. Quote names or paths containing spaces.');
      if (key === '--base') base = value; else branchName = value;
    }
    return { action: 'enter', name, ...(base ? { base } : {}), ...(branchName ? { branchName } : {}) };
  }
  throw new Error('Use /worktree status|create|enter|exit|sync|abort|recover.');
}

export const WORKTREE_COMMANDS: readonly TuiSlashCommandDef[] = [{
  name: 'worktree', group: 'Session ops', argsHint: 'status|create|enter|exit|sync|abort|recover',
  description: 'Control this session checkout',
  async run(ctx, args) {
    if (ctx.busy) { ctx.tui.printError('Finish the current turn before switching its checkout.'); return { kind: 'handled' }; }
    try {
      const result = await ctx.client.controlSessionCheckout(ctx.session.id, parseWorktreeArguments(args));
      showPanel(ctx, 'Worktree', [
        `  ${result.state.cwd}`, `  ${result.outcome}`,
        ...(result.state.checkout ? [`  base: ${result.state.checkout.baseSha || 'unknown'}`, `  return: ${result.state.checkout.returnCwd}`] : []),
        ...(result.state.pending ? ['  Recovery required: /worktree recover'] : []),
        ...(result.conflicts?.map((name) => `  conflict: ${name}`) ?? []),
        ...(result.removal && !result.removal.removed ? [`  retained: ${result.removal.reason}`] : []),
        ...(result.sourceChangesExcluded ? ['  Uncommitted source changes were excluded.'] : []),
      ], { scrollable: true, footer: '/worktree status|create|enter|exit|sync|abort|recover' });
      const session = await ctx.client.get(ctx.session.id);
      return session ? { kind: 'session_updated', session } : { kind: 'handled' };
    } catch (error) { ctx.tui.printError(describeError(error)); return { kind: 'handled' }; }
  },
}];
