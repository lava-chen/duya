import type { HostLocalTerminalHistoryApiV1 } from '@duya/agent-protocol/terminal-history';
import type { TerminalHistoryStore } from '@duya/data/terminal-history-store';

/** Local-only adapter; the terminal history table is owned by @duya/data. */
export function createHostLocalTerminalHistoryApi(
  store: Pick<TerminalHistoryStore, 'suggest' | 'record'>,
): HostLocalTerminalHistoryApiV1 {
  return {
    async suggestTerminalHistory(query) {
      return store.suggest({
        prefix: query.prefix,
        ...(query.shell === undefined ? {} : { shell: query.shell }),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },
    async recordTerminalCommand(input) {
      store.record({
        command: input.command,
        shell: input.shell,
        cwd: input.cwd,
        ...(input.source === undefined ? {} : { source: input.source }),
      });
    },
  };
}
