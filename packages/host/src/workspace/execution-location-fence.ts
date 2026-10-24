/** Per-session admission barrier for tools bound to an execution directory. */

export type ExecutionLocationErrorCode =
  | 'stale_execution_context'
  | 'execution_context_switching'
  | 'execution_context_busy'
  | 'execution_context_run_active';

export class ExecutionLocationError extends Error {
  constructor(readonly code: ExecutionLocationErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionLocationError';
  }
}

export interface ExecutionLocationDenial {
  readonly ok: false;
  readonly code: ExecutionLocationErrorCode;
  readonly message: string;
}

export interface ExecutionLocationLease {
  readonly ok: true;
  release(): void;
}

/** Process-local capability. Never serialize this into a manifest or tool input. */
export interface ExecutionLocationSnapshot {
  readonly revision: number;
  readonly workingDirectory: string | undefined;
  /** Synchronous acquisition closes the gap between the final check and execution. */
  acquire(): ExecutionLocationLease | ExecutionLocationDenial;
}

export interface ExecutionLocationSwitch {
  /** Returning undefined (not void) prevents accidental async commit callbacks. */
  commit(apply: () => undefined): void;
  /** Cancellation keeps the newer revision; old approvals must stay invalid. */
  cancel(): void;
}

export class ExecutionLocationFence {
  private revision = 0;
  private active = 0;
  private switching = false;

  constructor(private readonly readDirectory: () => string | undefined) {}

  capture(workingDirectory = this.readDirectory()): ExecutionLocationSnapshot {
    const revision = this.revision;
    return Object.freeze({
      revision,
      workingDirectory,
      acquire: (): ExecutionLocationLease | ExecutionLocationDenial => {
        if (this.switching) {
          return { ok: false, code: 'execution_context_switching', message: 'The execution directory is switching. Wait for the switch to finish and assemble a new tool context.' };
        }
        if (revision !== this.revision || workingDirectory !== this.readDirectory()) {
          return { ok: false, code: 'stale_execution_context', message: 'The execution directory changed after this tool context was assembled. Start a new turn before issuing more tool calls; approval does not refresh an old context.' };
        }
        this.active += 1;
        let released = false;
        return {
          ok: true,
          release: () => {
            if (released) return;
            released = true;
            this.active -= 1;
          },
        };
      },
    });
  }

  beginSwitch(expectedRevision: number): ExecutionLocationSwitch {
    if (this.switching) {
      throw new ExecutionLocationError('execution_context_switching', 'An execution directory switch is already in progress.');
    }
    if (expectedRevision !== this.revision) {
      throw new ExecutionLocationError('stale_execution_context', 'The execution location revision changed before the switch could start.');
    }
    if (this.active !== 0) {
      throw new ExecutionLocationError('execution_context_busy', 'Wait for running tools to finish before switching the execution directory.');
    }
    this.switching = true;
    this.revision += 1;
    let finished = false;
    return {
      commit: (apply) => {
        if (finished) throw new ExecutionLocationError('stale_execution_context', 'This execution directory switch has already finished.');
        try {
          apply();
        } finally {
          finished = true;
          this.switching = false;
        }
      },
      cancel: () => {
        if (finished) return;
        finished = true;
        this.switching = false;
      },
    };
  }
}

/** Legacy callers without a bound session fence retain their existing behavior. */
export function acquireExecutionLocation(
  context: { executionLocation?: ExecutionLocationSnapshot } | undefined,
  workingDirectory: string | undefined,
): ExecutionLocationLease | ExecutionLocationDenial {
  const snapshot = context?.executionLocation;
  if (!snapshot) return { ok: true, release() {} };
  if (workingDirectory !== snapshot.workingDirectory) {
    return { ok: false, code: 'stale_execution_context', message: 'The dispatch directory does not match the directory bound to this tool context.' };
  }
  return snapshot.acquire();
}
