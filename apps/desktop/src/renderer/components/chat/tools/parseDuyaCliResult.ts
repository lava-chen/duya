// duya_cli result parser — extracts { stdout, stderr, exitCode, ok } from
// the LLM-facing JSON envelope. Falls back to treating the raw result as
// stdout when the result is a plain string (some duya subcommands
// return text directly).

export interface DuyaCliResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  ok?: boolean;
  command?: string;
}

export function parseDuyaCliResult(result: string | undefined): DuyaCliResult | null {
  if (!result) return null;
  try {
    const data = JSON.parse(result);
    if (typeof data === 'object' && data !== null) {
      return data as DuyaCliResult;
    }
  } catch {
    // Fall through: result might be a plain string. Treat it as stdout.
  }
  return { stdout: result };
}
