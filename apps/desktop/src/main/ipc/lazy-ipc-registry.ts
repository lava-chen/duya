/**
 * lazy-ipc-registry.ts
 *
 * Lazy IPC registration for handler groups whose transitive module graph is
 * only needed after the user exercises the corresponding feature.
 *
 * Some handler modules pull in heavy graphs (scanners, writers, MCP + skill
 * resolution). Registering them eagerly at startup inflates the main process
 * module graph for functionality most sessions never touch. Instead of
 * importing them up front, `registerLazyIpcHandlers` installs a thin proxy for
 * every channel in the group. The first invoke of any channel triggers a
 * dynamic import of the real module; its register function publishes the
 * listeners through a capturing registrar, and those listeners serve every
 * subsequent call.
 *
 * Registration order and behaviour are unchanged for callers that invoke the
 * module's register function directly (the registrar parameter defaults to
 * `ipcMain.handle`).
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';

/** Listener type accepted by `ipcMain.handle`. */
export type IpcHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown;

/**
 * Sink a handler module uses to publish a channel -> listener binding.
 * Defaults to `ipcMain.handle` so direct registration keeps working.
 */
export type IpcRegistrar = (channel: string, handler: IpcHandler) => void;

export interface LazyIpcGroup {
  /** Group name, used in logs and error messages. */
  label: string;
  /** Every invoke channel the group is expected to register. */
  channels: readonly string[];
  /**
   * Dynamically import the module and call its register function, forwarding
   * the capturing registrar. Runs at most once, on first invoke.
   */
  load: (register: IpcRegistrar) => Promise<void> | void;
}

export function registerLazyIpcHandlers(group: LazyIpcGroup): void {
  const logger = getLogger();
  const listeners = new Map<string, IpcHandler>();
  let pending: Promise<void> | null = null;

  async function loadOnce(): Promise<void> {
    const captured = new Map<string, IpcHandler>();
    const register: IpcRegistrar = (channel, handler) => {
      captured.set(channel, handler);
    };

    await group.load(register);

    for (const [channel, handler] of captured) {
      if (group.channels.includes(channel)) {
        listeners.set(channel, handler);
      } else {
        // Defensive: the module registered a channel the group did not
        // declare. Keep it functional instead of silently dropping it.
        logger.warn(
          `Lazy IPC group "${group.label}" registered undeclared channel "${channel}"`,
          { channel },
          LogComponent.Main,
        );
        ipcMain.handle(channel, handler);
      }
    }

    for (const channel of group.channels) {
      if (!listeners.has(channel)) {
        logger.warn(
          `Lazy IPC group "${group.label}" did not register "${channel}"`,
          { channel },
          LogComponent.Main,
        );
      }
    }
  }

  const ensureLoaded = (): Promise<void> => {
    if (!pending) {
      pending = loadOnce().catch((error) => {
        // Allow a later invoke to retry after a transient failure.
        pending = null;
        throw error;
      });
    }
    return pending;
  };

  for (const channel of group.channels) {
    ipcMain.handle(channel, async (event, ...args) => {
      await ensureLoaded();
      const handler = listeners.get(channel);
      if (!handler) {
        throw new Error(
          `Lazy IPC channel "${channel}" is not registered (group "${group.label}")`,
        );
      }
      return handler(event, ...args);
    });
  }
}
