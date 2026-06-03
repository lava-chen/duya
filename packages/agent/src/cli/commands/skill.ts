/**
 * packages/agent/src/cli/commands/skill.ts
 *
 * `duya skill list` / `duya skill info <id>` read-only commands.
 *
 * Reads the available-skill DTO list from the main process via
 * /v1/skills. The main process is the single source of truth for
 * winner selection (resolver) and provenance classification.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';

interface SkillListItemDTO {
  id: string;
  name: string;
  description: string;
  source: 'bundled' | 'user' | 'plugin';
  sourceId?: string;
  enabled: boolean;
}

interface SkillInfoItemDTO extends SkillListItemDTO {
  category: string;
  customized: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  platforms: string[];
}

function renderListText(skills: SkillListItemDTO[]): string {
  if (skills.length === 0) return '(no skills available)';
  const lines: string[] = [];
  lines.push(`${skills.length} skill${skills.length !== 1 ? 's' : ''} available`);
  for (const s of skills) {
    const enabled = s.enabled ? 'on' : 'off';
    const src = s.sourceId ? `${s.source}:${s.sourceId}` : s.source;
    lines.push(`  ${s.id.padEnd(36)} ${enabled}  ${src.padEnd(10)} ${s.description}`);
  }
  return lines.join('\n');
}

function renderInfoText(s: SkillInfoItemDTO): string {
  const lines: string[] = [];
  lines.push(`${s.id}`);
  lines.push(`  name:          ${s.name}`);
  lines.push(`  description:   ${s.description}`);
  lines.push(`  source:        ${s.source}${s.sourceId ? ` (${s.sourceId})` : ''}`);
  lines.push(`  category:      ${s.category}`);
  lines.push(`  enabled:       ${s.enabled ? 'yes' : 'no'}`);
  lines.push(`  userInvocable: ${s.userInvocable ? 'yes' : 'no'}`);
  if (s.customized) {
    lines.push(`  customized:    yes`);
  }
  if (s.allowedTools.length > 0) {
    lines.push(`  allowedTools:  ${s.allowedTools.join(', ')}`);
  }
  if (s.platforms.length > 0) {
    lines.push(`  platforms:     ${s.platforms.join(', ')}`);
  }
  return lines.join('\n');
}

async function fetchSkills(): Promise<SkillListItemDTO[]> {
  const client = await CliApiClient.connect();
  const body = await client.get<{ skills: SkillListItemDTO[] }>('/v1/skills');
  return body.skills;
}

async function fetchSkillInfo(id: string): Promise<SkillInfoItemDTO> {
  const client = await CliApiClient.connect();
  const body = await client.get<{ skill: SkillInfoItemDTO }>(`/v1/skills/${encodeURIComponent(id)}`);
  return body.skill;
}

export async function runSkillListCommand(format: OutputFormat): Promise<number> {
  try {
    const skills = await fetchSkills();
    if (format === 'json') {
      process.stdout.write(renderJson({ skills }) + '\n');
    } else {
      process.stdout.write(renderListText(skills) + '\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}

export async function runSkillInfoCommand(id: string, format: OutputFormat): Promise<number> {
  try {
    const info = await fetchSkillInfo(id);
    if (format === 'json') {
      process.stdout.write(renderJson({ skill: info }) + '\n');
    } else {
      process.stdout.write(renderInfoText(info) + '\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof CliApiError) {
      // 404 from server means skill_not_found; surface hint
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}

// ============================================================================
// Phase 7: write operations
// ============================================================================

function isInteractive(): boolean {
  return Boolean(stdin.isTTY);
}

async function promptConfirm(message: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === 'y' || v === 'yes');
    });
  });
}

async function runSkillWrite(
  id: string,
  action: 'enable' | 'disable',
  yes: boolean,
  format: OutputFormat,
): Promise<number> {
  if (!yes && !isInteractive()) {
    process.stderr.write(
      'interactive_required: write operation requires --yes in non-interactive mode\n',
    );
    return 3;
  }
  if (!yes) {
    const confirmed = await promptConfirm(`Confirm ${action} skill '${id}'?`);
    if (!confirmed) {
      process.stderr.write(`aborted: ${action} of '${id}' cancelled\n`);
      return 1;
    }
  }

  const correlationId = randomUUID();
  const client = await CliApiClient.connect();
  try {
    const body = await client.post<{ skill: { id: string; name: string; enabled: boolean } }>(
      `/v1/skills/${encodeURIComponent(id)}/${action}`,
      {},
      { correlationId },
    );
    if (format === 'json') {
      process.stdout.write(renderJson({ skill: body.skill, correlationId }) + '\n');
    } else {
      const state = body.skill.enabled ? 'enabled' : 'disabled';
      process.stdout.write(`${state} skill '${id}' (correlationId=${correlationId})\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof CliApiError) {
      process.stderr.write(err.hint + '\n');
      return err.isAppUnavailable() ? 2 : 1;
    }
    throw err;
  }
}

export async function runSkillEnableCommand(id: string, yes: boolean, format: OutputFormat): Promise<number> {
  return runSkillWrite(id, 'enable', yes, format);
}

export async function runSkillDisableCommand(id: string, yes: boolean, format: OutputFormat): Promise<number> {
  return runSkillWrite(id, 'disable', yes, format);
}