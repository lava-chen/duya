/**
 * Environment Variable Collector for Skills
 *
 * Manages required environment variables declared by skills.
 * Collects missing values from the user and persists them securely.
 *
 * Inspired by hermes-agent's skills_tool.py implementation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { RequiredEnvVar, SkillSetupConfig, PromptSkill } from './types.js';

const ENV_FILE_PATH = path.join(os.homedir(), '.duya', '.env');

// Callback for secret capture (set by the main process)
let secretCaptureCallback: ((
  envVar: string,
  prompt: string,
  metadata: { skill_name: string; help?: string; required_for?: string }
) => Promise<{ success: boolean; stored_as: string; validated: boolean; skipped: boolean }>) | null = null;

/**
 * Set the callback for capturing secrets from the user
 */
export function setSecretCaptureCallback(
  callback: typeof secretCaptureCallback
): void {
  secretCaptureCallback = callback;
}

/**
 * Load environment variables from the duya .env file
 */
export async function loadEnvFile(): Promise<Record<string, string>> {
  const envVars: Record<string, string> = {};

  try {
    const content = await fs.readFile(ENV_FILE_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      envVars[key] = value;
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return envVars;
}

/**
 * Save an environment variable to the duya .env file
 */
export async function saveEnvVar(name: string, value: string): Promise<void> {
  // Ensure directory exists
  const dir = path.dirname(ENV_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });

  let content = '';
  try {
    content = await fs.readFile(ENV_FILE_PATH, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  const lines = content.split('\n');
  const newLine = `${name}="${value.replace(/"/g, '\\"')}"`;

  // Find and replace existing line or append
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(`${name}=`)) {
      lines[i] = newLine;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.push(newLine);
  }

  await fs.writeFile(ENV_FILE_PATH, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Check if an environment variable is set (in .env file or process.env)
 */
export function isEnvVarSet(name: string, envSnapshot: Record<string, string>): boolean {
  return Boolean(envSnapshot[name] ?? process.env[name]);
}

/**
 * Normalize required environment variables from various frontmatter formats
 */
export function normalizeRequiredEnvVars(
  frontmatter: Record<string, unknown>
): RequiredEnvVar[] {
  const required: RequiredEnvVar[] = [];
  const seen = new Set<string>();

  // Helper to add unique env var
  const addVar = (entry: RequiredEnvVar | string) => {
    let envVar: RequiredEnvVar;

    if (typeof entry === 'string') {
      envVar = { name: entry, prompt: `Enter value for ${entry}` };
    } else {
      envVar = {
        name: entry.name,
        prompt: entry.prompt || `Enter value for ${entry.name}`,
        help: entry.help,
        required_for: entry.required_for,
        optional: entry.optional,
      };
    }

    if (!envVar.name || seen.has(envVar.name)) return;
    seen.add(envVar.name);
    required.push(envVar);
  };

  // Parse required_environment_variables (new format)
  const requiredRaw = frontmatter.required_environment_variables;
  if (requiredRaw) {
    if (Array.isArray(requiredRaw)) {
      for (const item of requiredRaw) {
        if (typeof item === 'string') {
          addVar(item);
        } else if (typeof item === 'object' && item !== null) {
          addVar(item as RequiredEnvVar);
        }
      }
    }
  }

  // Parse setup.collect_secrets (alternative format)
  const setup = frontmatter.setup as SkillSetupConfig | undefined;
  if (setup?.collect_secrets) {
    for (const item of setup.collect_secrets) {
      addVar({
        name: item.env_var,
        prompt: item.prompt || `Enter value for ${item.env_var}`,
        help: item.provider_url,
      });
    }
  }

  // Parse legacy prerequisites.env_vars
  const prereqs = frontmatter.prerequisites as { env_vars?: string[] } | undefined;
  if (prereqs?.env_vars) {
    for (const name of prereqs.env_vars) {
      addVar(name);
    }
  }

  return required;
}

/**
 * Capture missing environment variables from the user
 */
export async function captureMissingEnvVars(
  skillName: string,
  missingVars: RequiredEnvVar[]
): Promise<{
  missingNames: string[];
  setupSkipped: boolean;
  captured: Record<string, string>;
}> {
  const result: {
    missingNames: string[];
    setupSkipped: boolean;
    captured: Record<string, string>;
  } = {
    missingNames: [],
    setupSkipped: false,
    captured: {},
  };

  if (missingVars.length === 0) return result;

  // Load current env snapshot
  const envSnapshot = await loadEnvFile();

  for (const entry of missingVars) {
    // Skip if already set
    if (isEnvVarSet(entry.name, envSnapshot)) {
      continue;
    }

    // Skip optional vars
    if (entry.optional) {
      continue;
    }

    // Try to capture from user
    if (secretCaptureCallback) {
      try {
        const callbackResult = await secretCaptureCallback(
          entry.name,
          entry.prompt,
          {
            skill_name: skillName,
            help: entry.help,
            required_for: entry.required_for,
          }
        );

        if (callbackResult.success && !callbackResult.skipped) {
          // Save to .env file
          await saveEnvVar(entry.name, callbackResult.stored_as);
          result.captured[entry.name] = callbackResult.stored_as;
          continue;
        }

        result.setupSkipped = true;
        result.missingNames.push(entry.name);
      } catch (error) {
        console.warn(`Secret capture callback failed for ${entry.name}:`, error);
        result.setupSkipped = true;
        result.missingNames.push(entry.name);
      }
    } else {
      // No callback available
      result.missingNames.push(entry.name);
    }
  }

  return result;
}

/**
 * Check skill environment requirements and capture missing values
 */
export async function checkSkillEnvRequirements(
  skill: PromptSkill
): Promise<{
  ready: boolean;
  missing: string[];
  setupNeeded: boolean;
  setupNote?: string;
}> {
  if (!skill.requiredEnvVars || skill.requiredEnvVars.length === 0) {
    return { ready: true, missing: [], setupNeeded: false };
  }

  const envSnapshot = await loadEnvFile();

  // Find missing required vars
  const missingRequired = skill.requiredEnvVars.filter(
    v => !v.optional && !isEnvVarSet(v.name, envSnapshot)
  );

  if (missingRequired.length === 0) {
    return { ready: true, missing: [], setupNeeded: false };
  }

  // Try to capture missing vars
  const captureResult = await captureMissingEnvVars(
    skill.name,
    missingRequired
  );

  const stillMissing = captureResult.missingNames;
  const setupNeeded = stillMissing.length > 0;

  // Build setup note
  let setupNote: string | undefined;
  if (setupNeeded) {
    const missingStr = stillMissing.map(n => `$${n}`).join(', ');
    setupNote = `Setup needed before using this skill: missing ${missingStr}.`;

    // Add help URL if available
    const helpUrl = skill.requiredEnvVars.find(
      v => stillMissing.includes(v.name) && v.help
    )?.help;
    if (helpUrl) {
      setupNote += ` See: ${helpUrl}`;
    }
  }

  return {
    ready: stillMissing.length === 0,
    missing: stillMissing,
    setupNeeded,
    setupNote,
  };
}

/**
 * Build environment variable context for a skill
 * Returns a record of env var names to values
 */
export async function buildSkillEnvContext(
  skill: PromptSkill
): Promise<Record<string, string>> {
  if (!skill.requiredEnvVars || skill.requiredEnvVars.length === 0) {
    return {};
  }

  const envSnapshot = await loadEnvFile();
  const context: Record<string, string> = {};

  for (const entry of skill.requiredEnvVars) {
    const value = envSnapshot[entry.name] ?? process.env[entry.name];
    if (value !== undefined) {
      context[entry.name] = value;
    }
  }

  return context;
}

/**
 * Format required environment variables for display
 */
export function formatRequiredEnvVars(
  requiredEnvVars: RequiredEnvVar[]
): string {
  if (!requiredEnvVars || requiredEnvVars.length === 0) return '';

  const lines = requiredEnvVars.map(v => {
    const optional = v.optional ? ' (optional)' : '';
    const help = v.help ? ` - ${v.help}` : '';
    return `  - ${v.name}${optional}${help}`;
  });

  return 'Required environment variables:\n' + lines.join('\n');
}
