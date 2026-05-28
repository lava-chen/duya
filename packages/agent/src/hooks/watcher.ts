/**
 * HookWatcher - File watcher for hot reload of hooks.json
 *
 * Monitors plugin directories for hooks.json changes and
 * automatically reloads hooks without restarting the agent.
 */

import { watch, FSWatcher } from 'fs';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { HooksSettings, HookMatcher } from './types.js';
import { HooksSettingsSchema } from './types.js';
import { clearSessionHooks, addSessionHook } from './utils/sessionHooks.js';

interface WatchEntry {
  watcher: FSWatcher;
  pluginDir: string;
}

interface HookWatcherOptions {
  onReload?: (pluginDir: string, hooks: HooksSettings) => void;
  onError?: (pluginDir: string, error: Error) => void;
}

/**
 * HookWatcher monitors plugin hooks.json files for changes
 * and triggers hot reload of hook configurations.
 */
export class HookWatcher {
  private watchers: Map<string, WatchEntry> = new Map();
  private options: HookWatcherOptions;

  constructor(options: HookWatcherOptions = {}) {
    this.options = options;
  }

  /**
   * Start watching a plugin directory for hooks.json changes
   */
  watchPlugin(pluginDir: string): void {
    if (this.watchers.has(pluginDir)) {
      return;
    }

    const hooksPath = join(pluginDir, 'hooks', 'hooks.json');

    if (!existsSync(hooksPath)) {
      return;
    }

    const watcher = watch(hooksPath, (eventType) => {
      if (eventType === 'change') {
        this.reloadHooks(pluginDir);
      }
    });

    this.watchers.set(pluginDir, {
      watcher,
      pluginDir,
    });
  }

  /**
   * Stop watching a specific plugin directory
   */
  unwatchPlugin(pluginDir: string): void {
    const entry = this.watchers.get(pluginDir);
    if (entry) {
      entry.watcher.close();
      this.watchers.delete(pluginDir);
    }
  }

  /**
   * Stop all watchers
   */
  unwatchAll(): void {
    for (const [, entry] of this.watchers) {
      entry.watcher.close();
    }
    this.watchers.clear();
  }

  /**
   * Reload hooks from a plugin directory
   */
  private reloadHooks(pluginDir: string): void {
    try {
      const hooksPath = join(pluginDir, 'hooks', 'hooks.json');

      if (!existsSync(hooksPath)) {
        this.options.onError?.(pluginDir, new Error(`hooks.json not found: ${hooksPath}`));
        return;
      }

      const raw = readFileSync(hooksPath, 'utf-8');
      const parsed = JSON.parse(raw);

      const validation = HooksSettingsSchema.safeParse(parsed);
      if (!validation.success) {
        this.options.onError?.(pluginDir, new Error(`Invalid hooks.json: ${validation.error.message}`));
        return;
      }

      const hooksSettings = validation.data;
      this.options.onReload?.(pluginDir, hooksSettings);
    } catch (error) {
      this.options.onError?.(pluginDir, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Register loaded hooks for a session.
   */
  registerHooksForSession(
    sessionId: string,
    pluginDir: string,
    hooksSettings: HooksSettings,
  ): void {
    clearSessionHooks(sessionId);

    for (const [eventName, matchers] of Object.entries(hooksSettings)) {
      if (!matchers) continue;

      for (const matcher of matchers as HookMatcher[]) {
        for (const hook of matcher.hooks) {
          addSessionHook(
            sessionId,
            eventName as Parameters<typeof addSessionHook>[1],
            matcher.matcher || '',
            hook,
            undefined,
            pluginDir,
          );
        }
      }
    }
  }

  /**
   * Get the list of currently watched plugin directories
   */
  getWatchedPlugins(): string[] {
    return Array.from(this.watchers.keys());
  }
}

export default HookWatcher;