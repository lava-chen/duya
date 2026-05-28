/**
 * Agent Hook Executor
 *
 * Launches a lightweight sub-agent to perform verification/check tasks.
 * Used for complex multi-step validation flows.
 *
 * The sub-agent receives a focused prompt with the hook input context
 * and returns structured findings.
 */

import { spawn } from 'child_process';
import path from 'path';
import type { HookResult, AgentHook } from '../types.js';

interface HookExecutorOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface AgentHookResponse {
  passed: boolean;
  summary: string;
  findings?: string[];
  decision?: 'approve' | 'block';
}

const DEFAULT_AGENT_TIMEOUT = 120 * 1000;

function getAgentCLIPath(): string {
  return path.resolve(
    __dirname,
    '..', '..', '..', 'dist', 'cli', 'index.js',
  );
}

/**
 * Execute an agent hook - spawns a sub-agent for verification
 */
export async function executeAgentHook(
  hook: AgentHook,
  jsonInput: string,
  options: HookExecutorOptions = {},
): Promise<Omit<HookResult, 'hook'>> {
  const timeoutMs = (hook.timeout ? hook.timeout * 1000 : 0) || options.timeoutMs || DEFAULT_AGENT_TIMEOUT;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal || controller.signal;

    const model = hook.model || process.env.DUYA_MODEL || 'claude-sonnet-4-20250514';
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
    const baseURL = process.env.ANTHROPIC_BASE_URL || '';

    const task = `${hook.prompt}\n\nContext (JSON): ${jsonInput}\n\nRespond with a single JSON object: { "passed": true/false, "summary": "...", "findings": [...], "decision": "approve"|"block" }`;

    const agentPath = getAgentCLIPath();

    try {
      require.resolve(agentPath);
    } catch {
      return {
        outcome: 'non_blocking_error',
        systemMessage: 'Agent hook not supported in current environment (no agent CLI available)',
      };
    }

    const abortHandler = () => {
      controller.abort();
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        agentPath,
        '--task', task,
        '--print',
        '--format', 'json',
        '--api-key', apiKey,
        '--model', model,
        ...(baseURL ? ['--base-url', baseURL] : []),
      ], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve({ stdout, stderr });
        } else {
          resolve({ stdout, stderr });
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });

    clearTimeout(timeoutId);

    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }

    try {
      const parsed = JSON.parse(result.stdout.trim()) as AgentHookResponse;
      const hookResult: Omit<HookResult, 'hook'> = {
        outcome: parsed.passed ? 'success' : 'non_blocking_error',
        additionalContext: parsed.summary,
      };

      if (parsed.decision === 'approve') {
        hookResult.permissionBehavior = 'allow';
      } else if (parsed.decision === 'block') {
        hookResult.permissionBehavior = 'deny';
        hookResult.blockingError = {
          blockingError: parsed.summary || 'Blocked by agent hook',
          command: hook.prompt,
        };
        hookResult.outcome = 'blocking';
      }

      return hookResult;
    } catch {
      return {
        outcome: 'non_blocking_error',
        systemMessage: 'Agent hook returned non-JSON response',
      };
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { outcome: 'cancelled' };
    }
    return {
      outcome: 'non_blocking_error',
      systemMessage: `Agent hook error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export default executeAgentHook;