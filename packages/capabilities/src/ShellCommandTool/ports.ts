/** Host-owned services used by a shell capability. */
export interface ShellCommandCompletion {
  readonly taskId: string;
  readonly status: 'completed' | 'failed' | 'timeout' | 'canceled';
  readonly exitCode: number;
  readonly text: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface ShellCommandHandle {
  readonly taskId: string;
  readonly pid: number;
  readonly outputFile: string;
  readonly settled: Promise<ShellCommandCompletion>;
  promoteToBackground(): void;
}

export interface StartShellCommand {
  readonly taskId: string;
  readonly command: string;
  readonly shellPath: string;
  readonly shellArgs: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly foregroundTimeoutMs: number | null;
  readonly sessionId?: string;
  readonly abortSignal?: AbortSignal;
}

export interface ShellCommandRuntimePorts {
  /** Start and durably track a command; the host owns cancellation and notification. */
  readonly start: (params: StartShellCommand) => Promise<ShellCommandHandle>;
  /** Directory for bounded output spill files. */
  readonly outputDirectory: () => string;
  /** Optional lifecycle-aware reminder renderer supplied by the host. */
  readonly gitReminder?: (command: string) => string | null | Promise<string | null>;
}
