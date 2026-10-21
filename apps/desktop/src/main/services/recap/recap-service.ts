import { BrowserWindow } from 'electron';
import { readHostMessageRows } from '../host-message-reader';
import type { MessageRow } from '../../ipc/core-db-adapters';
import { buildRecapPrompt } from './recap-prompt';
import { callLLMForRecap } from './recap-llm';
import { getProviderStore } from '../providers/provider-store-electron';

const DEFAULT_INACTIVITY_THRESHOLD_MS = 3 * 60 * 1000;
const MIN_TURN_COUNT = 3;
const DEBOUNCE_FOCUS_MS = 5_000;

interface CachedRecap {
  sessionId: string;
  recap: string;
  timestamp: number;
}

interface RecapSessionManager {
  registerSession(sessionId: string): unknown;
  getSession(sessionId: string): unknown;
}

export class RecapService {
  private enabled = true;
  private inactivityThreshold = DEFAULT_INACTIVITY_THRESHOLD_MS;
  private blurTimestamp: number | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFocusedAt = 0;
  private cachedRecap: CachedRecap | null = null;
  private lastRecapSessionId: string | null = null;
  private activeSessionId: string | null = null;

  constructor(
    private getSessionManager: () => RecapSessionManager,
  ) {}

  init(mainWindow: BrowserWindow): void {
    mainWindow.on('blur', () => {
      this.handleBlur();
    });

    mainWindow.on('focus', () => {
      this.handleFocus(mainWindow);
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setInactivityThreshold(seconds: number): void {
    this.inactivityThreshold = seconds * 1000;
  }

  getInactivityThreshold(): number {
    return Math.round(this.inactivityThreshold / 1000);
  }

  setActiveSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    // Register the session in the Main Process SessionManager so that
    // lifecycle queries (getSession, updateSessionState) work. Without
    // this, onInactivityTimeout() would always bail out because
    // getSession() returns undefined for unregistered sessions.
    this.getSessionManager().registerSession(sessionId);
  }

  getCachedRecap(): CachedRecap | null {
    return this.cachedRecap;
  }

  async requestManualRecap(sessionId: string): Promise<string | null> {
    const recap = await this.generateRecap(sessionId);
    if (recap) {
      this.cachedRecap = { sessionId, recap, timestamp: Date.now() };
    }
    return recap;
  }

  shutdown(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.cachedRecap = null;
    this.blurTimestamp = null;
  }

  private handleBlur(): void {
    this.blurTimestamp = Date.now();

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }

    this.inactivityTimer = setTimeout(() => {
      void this.onInactivityTimeout().catch(() => undefined);
    }, this.inactivityThreshold);
  }

  private handleFocus(mainWindow: BrowserWindow): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    const now = Date.now();
    if (now - this.lastFocusedAt < DEBOUNCE_FOCUS_MS) {
      return;
    }
    this.lastFocusedAt = now;

    if (!this.cachedRecap) {
      return;
    }

    if (this.activeSessionId && this.cachedRecap.sessionId !== this.activeSessionId) {
      this.cachedRecap = null;
      return;
    }

    const recap = this.cachedRecap;
    this.cachedRecap = null;

    mainWindow.webContents.send('recap:result', {
      sessionId: recap.sessionId,
      recap: recap.recap,
      timestamp: recap.timestamp,
    });
  }

  private async onInactivityTimeout(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const sessionId = this.activeSessionId;
    if (!sessionId) {
      return;
    }

    const sessionManager = this.getSessionManager();
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }

    const messages = await readHostMessageRows(sessionId);
    if (this.activeSessionId !== sessionId) {
      return;
    }
    const turnCount = messages.filter((message) => message.role === 'user').length;
    if (turnCount < MIN_TURN_COUNT) {
      return;
    }

    if (sessionId === this.lastRecapSessionId) {
      return;
    }

    this.generateRecap(sessionId, messages)
      .then((recap) => {
        if (recap) {
          this.cachedRecap = { sessionId, recap, timestamp: Date.now() };
          this.lastRecapSessionId = sessionId;
        }
      })
      .catch(() => {
        // silently ignore errors in background generation
      });
  }

  private async generateRecap(sessionId: string, knownMessages?: MessageRow[]): Promise<string | null> {
    // Read the complete Host projection and adapt it to the existing recap
    // prompt DTO. Inactivity checks pass their already-loaded rows here.
    const messages = knownMessages ?? await readHostMessageRows(sessionId);
    if (messages.length === 0) {
      return null;
    }

    const provider = getProviderStore().getDefaultLlmProvider();
    if (!provider) {
      return null;
    }

    const { systemPrompt, userContent } = buildRecapPrompt(messages);

    // Phase 3: build a ProviderRuntimeConfig via the store so the
    // recap path uses the same auth / header semantics as Chat. The
    // store falls back to the active provider's `options.defaultModel`
    // (or `options.model` / `enabled_models[0]`) when no model is
    // configured.
    const store = getProviderStore();
    const model =
      (provider.options?.defaultModel as string) ||
      (provider.options?.model as string) ||
      (Array.isArray(provider.options?.enabled_models) &&
        (provider.options?.enabled_models as string[])[0]) ||
      '';
    const runtime = await store.getProviderRuntimeConfig(provider.id, model);
    if ('error' in runtime) {
      return null;
    }
    return callLLMForRecap(runtime, systemPrompt, userContent);
  }
}
