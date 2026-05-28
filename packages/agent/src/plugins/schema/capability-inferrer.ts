import { readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import type { ValidatedCapabilities, ValidatedCapability, ValidatedHook } from './types.js';

function isMarkdownFile(name: string): boolean {
  return name.endsWith('.md');
}

function scanCapabilityDir(
  dir: string,
  kind: string
): ValidatedCapability[] {
  if (!existsSync(dir)) return [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (kind === 'commands' || kind === 'skills' || kind === 'agents') {
          return entry.isFile() && isMarkdownFile(entry.name);
        }
        return entry.isFile();
      })
      .map((entry) => {
        const name = basename(entry.name, kind === 'commands' || kind === 'skills' || kind === 'agents' ? '.md' : '');
        const file = join(kind, entry.name);
        return {
          name,
          file,
        };
      });
  } catch {
    return [];
  }
}

function scanHooksDir(dir: string): ValidatedHook[] {
  if (!existsSync(dir)) return [];

  const hooks: ValidatedHook[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const content = require(join(dir, entry.name));
          const hookConfig = content as Record<string, unknown>;

          if (Array.isArray(hookConfig.hooks)) {
            for (const hook of hookConfig.hooks) {
              if (
                typeof hook === 'object' &&
                hook !== null &&
                typeof (hook as Record<string, unknown>).event === 'string' &&
                typeof (hook as Record<string, unknown>).handler === 'string'
              ) {
                hooks.push({
                  event: (hook as Record<string, unknown>).event as string,
                  handler: (hook as Record<string, unknown>).handler as string,
                });
              }
            }
          }
        } catch {
        }
      }
    }
  } catch {
  }

  return hooks;
}

export function inferCapabilitiesFromDir(dirPath: string): ValidatedCapabilities {
  const capabilities: ValidatedCapabilities = {
    commands: [],
    skills: [],
    agents: [],
    hooks: [],
  };

  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    return capabilities;
  }

  capabilities.commands = scanCapabilityDir(join(dirPath, 'commands'), 'commands');
  capabilities.skills = scanCapabilityDir(join(dirPath, 'skills'), 'skills');
  capabilities.agents = scanCapabilityDir(join(dirPath, 'agents'), 'agents');
  capabilities.hooks = scanHooksDir(join(dirPath, 'hooks'));

  return capabilities;
}

export function mergeCapabilitiesWithDeclared(
  declared: ValidatedCapabilities,
  inferred: ValidatedCapabilities
): ValidatedCapabilities {
  const merge = (
    declaredItems: ValidatedCapability[],
    inferredItems: ValidatedCapability[]
  ): ValidatedCapability[] => {
    const declaredNames = new Set(declaredItems.map((d) => d.name));
    const merged = [...declaredItems];

    for (const item of inferredItems) {
      if (!declaredNames.has(item.name)) {
        merged.push(item);
      }
    }

    return merged;
  };

  const mergeHooks = (
    declaredHooks: ValidatedHook[],
    inferredHooks: ValidatedHook[]
  ): ValidatedHook[] => {
    const declaredKeys = new Set(declaredHooks.map((d) => `${d.event}:${d.handler}`));
    const merged = [...declaredHooks];

    for (const hook of inferredHooks) {
      const key = `${hook.event}:${hook.handler}`;
      if (!declaredKeys.has(key)) {
        merged.push(hook);
      }
    }

    return merged;
  };

  return {
    commands: merge(declared.commands, inferred.commands),
    skills: merge(declared.skills, inferred.skills),
    agents: merge(declared.agents, inferred.agents),
    hooks: mergeHooks(declared.hooks, inferred.hooks),
  };
}