// useBangMode.ts — `!cmd` bash-prefix runner for the chat composer.
//
// Architecture (minimax / codex `!` bash-mode parity):
//   1. Main process: `apps/desktop/src/main/ipc/bang-handlers.ts` registers the
//      `bang:run` IPC channel. It validates the payload, resolves the cwd
//      (session working directory, falling back to the main process cwd) and
//      runs the command through a shell (`node:child_process.spawn`,
//      `shell: true`) with a bounded timeout. stdout + stderr are captured,
//      merged and capped at 256 KB; the child is killed on timeout. It returns
//      `{ ok, output, durationMs, exitCode? , error? }`.
//   2. Preload: `apps/desktop/src/preload/index.ts` exposes the channel as
//      `window.electronAPI.bang.run(command, cwd?, timeoutMs?)`.
//   3. Renderer (this hook): `run()` forwards the call and normalises the
//      result into `BangRunResult`. It NEVER throws — every failure path
//      (bridge missing, IPC rejection, malformed payload) is caught and
//      returned as `{ ok: false, error }` so the composer's
//      CommandResultDialog always has something to render.
//
// Call site: `apps/desktop/src/renderer/components/chat/MessageInput.tsx`
// (the `// Bang prefix:` branch of `handleSubmit`) — `!cmd` → bangRun(cmd) →
// output rendered in the shared CommandResultDialog (mono mode). No
// confirmation dialog is shown: the renderer is trusted (same model as the
// agent's BashTool) because `!` mode is explicit user intent.

export interface BangRunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs?: number;
}

export interface BangModeApi {
  /** Run a shell command; never throws. */
  run: (command: string, cwd?: string) => Promise<BangRunResult>;
}

export function useBangMode(): BangModeApi {
  return {
    run: async (command: string, cwd?: string) => {
      try {
        // Optional chaining keeps tests / non-electron contexts (where the
        // preload bridge never ran) from crashing the hook.
        const bridge = window.electronAPI?.bang;
        if (typeof bridge?.run !== 'function') {
          return {
            ok: false,
            output: '',
            error: 'bash 模式不可用（electronAPI.bang 未暴露）',
            durationMs: 0,
          };
        }
        const result = await bridge.run(command, cwd);
        return normalizeBangResult(result);
      } catch (err) {
        return {
          ok: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        };
      }
    },
  };
}

/**
 * Coerce whatever the IPC returned into `BangRunResult`: missing/blank output
 * becomes an empty string, missing duration 0, and a missing error message
 * falls back to a generic one so the dialog never shows `undefined`.
 */
function normalizeBangResult(result: unknown): BangRunResult {
  if (!result || typeof result !== 'object') {
    return { ok: false, output: '', error: 'bash 模式返回了无效结果', durationMs: 0 };
  }
  const r = result as {
    ok?: unknown;
    output?: unknown;
    error?: unknown;
    durationMs?: unknown;
  };
  const ok = r.ok === true;
  const output = typeof r.output === 'string' ? r.output : '';
  const durationMs =
    typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
      ? r.durationMs
      : 0;
  const error =
    typeof r.error === 'string' && r.error.trim()
      ? r.error
      : ok
        ? undefined
        : '命令失败';
  return { ok, output, error, durationMs };
}
