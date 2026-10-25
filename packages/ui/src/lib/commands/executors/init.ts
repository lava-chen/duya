/**
 * The `/init` executor — create the repository-root `AGENTS.md`.
 *
 * codex's `/init` writes an `AGENTS.md` at the root of the code repository so
 * that every agent that opens the checkout reads the same instructions. The
 * Desktop does the same for the session's working directory.
 *
 * ## Why the executor sends a session id and not a path
 *
 * The file NAME is fixed (`AGENTS.md`) — it is not user input. The
 * DIRECTORY is, and it is the session's working directory. Sending the
 * session id lets the main process resolve that directory itself and check
 * it against the session root, so a compromised renderer cannot aim the
 * write at another directory.
 *
 * ## Why the command refuses while a turn is running
 *
 * `/init` writes a file into the user's repository. The catalog declares it
 * `availableWhileBusy: false`, and the dispatch layer enforces that before
 * the executor runs.
 */

import type { CommandExecutorFn } from './registry';
import type { CommandContext, CommandResult } from '../types';
import type { InitAgentsMdResult } from '@/contracts/doctor';

/** The outcome, as the user reads it. */
function describe(result: InitAgentsMdResult): string {
  const target = result.path ?? 'AGENTS.md';

  if (result.unchanged) {
    return [
      `${target} 已是最新版本（v${result.version}），未改动。`,
      '如需重新生成，请先删除该文件再运行 /init。',
    ].join('\n');
  }

  if (result.replacedUnmarked) {
    return [
      `已用 duya 模板覆盖 ${target}（v${result.version}）。`,
      '该文件原本没有 duya 版本标记，原内容已被替换且未保留。',
    ].join('\n');
  }

  if (result.upgraded) {
    return `已更新 ${target} 到模板版本 v${result.version}。`;
  }

  return `已创建 ${target}（模板版本 v${result.version}）。`;
}

export const INIT_EXECUTORS: Record<string, CommandExecutorFn> = {
  /** `/init` → write the AGENTS.md at the session's working directory root. */
  init: async (ctx: CommandContext): Promise<CommandResult> => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/init: app bridge unavailable' };
    if (!app.initWorkspaceAgentsMd) {
      return { type: 'error', message: '/init: 写入通道不可用，请重启应用后再试。' };
    }

    const { sessionId } = app.getSessionSnapshot();
    if (!sessionId) {
      return {
        type: 'error',
        message: '/init: 当前没有打开的会话，无法确定要写入的仓库目录。',
      };
    }

    let result: InitAgentsMdResult;
    try {
      result = await app.initWorkspaceAgentsMd(sessionId);
    } catch (error) {
      return {
        type: 'error',
        message: `/init: 写入失败（${error instanceof Error ? error.message : String(error)}）`,
      };
    }

    if (!result?.ok) {
      return { type: 'error', message: `/init: ${result?.error ?? '写入失败。'}` };
    }

    return { type: 'text', content: describe(result) };
  },
};
