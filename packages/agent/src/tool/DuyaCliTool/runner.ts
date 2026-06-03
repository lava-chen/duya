/**
 * packages/agent/src/tool/DuyaCliTool/runner.ts
 *
 * In-process invocation of CLI control-plane commands.
 *
 * The `run*` functions in `cli/commands/*.ts` were written to be the
 * shared backend for the `duya` CLI bundle. They write to
 * `process.stdout` / `process.stderr` directly. To use them inside
 * the agent (without spawning a subprocess and re-doing auth), we
 * temporarily swap those streams for `Writable` instances that
 * accumulate chunks, then restore them.
 *
 * Subprocess is *not* used. The agent process is the desktop
 * process; userData is the same. This is the same code path the
 * external CLI takes, with the only difference being that the IPC
 * is in-process.
 */

import { Writable } from 'node:stream';
import type { OutputFormat } from '../../cli/api/format.js';
import { runStatusCommand } from '../../cli/commands/status.js';
import { runPluginCommand } from '../../cli/commands/plugin.js';
import { runSessionCommand } from '../../cli/commands/session.js';
import { runDoctorCommand } from '../../cli/commands/doctor.js';
import {
  runSkillListCommand,
  runSkillInfoCommand,
  runSkillEnableCommand,
  runSkillDisableCommand,
} from '../../cli/commands/skill.js';
import { runMCPListCommand, runMCPInfoCommand } from '../../cli/commands/mcp.js';
import {
  runProviderListCommand,
  runProviderInfoCommand,
} from '../../cli/commands/provider.js';
import { runInstallCliCommand, runUninstallCliCommand } from '../../cli/commands/install.js';

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Capture process.stdout / process.stderr for the duration of `fn`,
 * restoring the originals on completion (success or failure).
 */
async function captureStreams<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  // Patch process.stdout.write / process.stderr.write so any
  // `process.stdout.write(...)` call inside the run* functions ends
  // up in our chunks, not on the agent's real TTY.
  (process.stdout as unknown as { write: (b: unknown) => boolean }).write = (chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      outChunks.push(Buffer.from(chunk, 'utf-8'));
    } else if (Buffer.isBuffer(chunk)) {
      outChunks.push(chunk);
    } else {
      outChunks.push(Buffer.from(String(chunk), 'utf-8'));
    }
    return true;
  };
  (process.stderr as unknown as { write: (b: unknown) => boolean }).write = (chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      errChunks.push(Buffer.from(chunk, 'utf-8'));
    } else if (Buffer.isBuffer(chunk)) {
      errChunks.push(chunk);
    } else {
      errChunks.push(Buffer.from(String(chunk), 'utf-8'));
    }
    return true;
  };

  // Some callers also probe `.isTTY` etc. We do not mock those;
  // the run* functions are written to be safe under non-TTY
  // conditions (the CLI bundle runs in headless test environments).

  try {
    const value = await fn();
    return {
      value,
      stdout: Buffer.concat(outChunks).toString('utf-8'),
      stderr: Buffer.concat(errChunks).toString('utf-8'),
    };
  } finally {
    (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
    (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
  }
}

/**
 * Result of parsing the parser: a normalized command path + args.
 */
export interface CliInvocation {
  command: string;
  subcommand?: string;
  id?: string;
  format: OutputFormat;
  yes?: boolean;
  extraArgs?: string[];
}

/**
 * Dispatch the parsed invocation to the matching run* function.
 * Returns a structured result; never throws (failures are encoded
 * as non-zero exit codes, mirroring the CLI bundle contract).
 */
export async function runCliCommand(inv: CliInvocation): Promise<CliRunResult> {
  const format: OutputFormat = inv.format;

  let runner: () => Promise<number>;
  switch (inv.command) {
    case 'status':
      runner = () => runStatusCommand(format);
      break;

    case 'plugin': {
      const sub = inv.subcommand;
      if (sub === 'list') {
        runner = () => runPluginCommand.list(format);
      } else if (sub === 'info') {
        if (!inv.id) {
          return { exitCode: 64, stdout: '', stderr: 'plugin info requires an <id> argument' };
        }
        runner = () => runPluginCommand.info(inv.id!, format);
      } else {
        return {
          exitCode: 64,
          stdout: '',
          stderr: `unknown plugin subcommand: ${sub ?? '(none)'} (expected: list | info)`,
        };
      }
      break;
    }

    case 'session': {
      const sub = inv.subcommand;
      if (sub === 'list') {
        runner = () => runSessionCommand.list(format, {
          limit: inv.extraArgs?.[0],
          offset: inv.extraArgs?.[1],
        });
      } else if (sub === 'show') {
        if (!inv.id) {
          return { exitCode: 64, stdout: '', stderr: 'session show requires an <id> argument' };
        }
        runner = () => runSessionCommand.show(inv.id!, format);
      } else {
        return {
          exitCode: 64,
          stdout: '',
          stderr: `unknown session subcommand: ${sub ?? '(none)'} (expected: list | show)`,
        };
      }
      break;
    }

    case 'doctor':
      runner = () => runDoctorCommand(format);
      break;

    case 'skill': {
      const sub = inv.subcommand;
      if (sub === 'list') {
        runner = () => runSkillListCommand(format);
      } else if (sub === 'info') {
        if (!inv.id) {
          return { exitCode: 64, stdout: '', stderr: 'skill info requires an <id> argument' };
        }
        runner = () => runSkillInfoCommand(inv.id!, format);
      } else if (sub === 'enable') {
        if (!inv.id) {
          return { exitCode: 64, stdout: '', stderr: 'skill enable requires an <id> argument' };
        }
        runner = () => runSkillEnableCommand(inv.id!, inv.yes === true, format);
      } else if (sub === 'disable') {
        if (!inv.id) {
          return { exitCode: 64, stdout: '', stderr: 'skill disable requires an <id> argument' };
        }
        runner = () => runSkillDisableCommand(inv.id!, inv.yes === true, format);
      } else {
        return {
          exitCode: 64,
          stdout: '',
          stderr: `unknown skill subcommand: ${sub ?? '(none)'} (expected: list | info | enable | disable)`,
        };
      }
      break;
    }

    case 'mcp': {
      const sub = inv.subcommand;
      if (sub === 'list') {
        runner = () => runMCPListCommand(format);
      } else if (sub === 'info') {
        if (!inv.id) {
          return { exitCode: 64, stdout: '', stderr: 'mcp info requires an <id> argument' };
        }
        runner = () => runMCPInfoCommand(inv.id!, format);
      } else {
        return {
          exitCode: 64,
          stdout: '',
          stderr: `unknown mcp subcommand: ${sub ?? '(none)'} (expected: list | info)`,
        };
      }
      break;
    }

    case 'provider': {
      const sub = inv.subcommand;
      if (sub === 'list') {
        runner = () => runProviderListCommand(format);
      } else if (sub === 'info') {
        if (!inv.id) {
          return { exitCode: 64, stdout: '', stderr: 'provider info requires an <id> argument' };
        }
        runner = () => runProviderInfoCommand(inv.id!, format);
      } else {
        return {
          exitCode: 64,
          stdout: '',
          stderr: `unknown provider subcommand: ${sub ?? '(none)'} (expected: list | info)`,
        };
      }
      break;
    }

    case 'install-cli':
      runner = () => runInstallCliCommand(format);
      break;

    case 'uninstall-cli':
      runner = () => runUninstallCliCommand(format);
      break;

    default:
      return {
        exitCode: 64,
        stdout: '',
        stderr: `unknown command: ${inv.command} (allowed: status | plugin | session | doctor | skill | mcp | provider | install-cli | uninstall-cli)`,
      };
  }

  try {
    const { value, stdout, stderr } = await captureStreams(runner);
    return { exitCode: value, stdout, stderr };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `internal error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
