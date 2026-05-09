/**
 * Configuration management for DUYA Agent CLI
 *
 * Handles loading/saving config files and environment variables.
 * Config files are stored in ~/.duya/ for easy access.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface DUYAConfig {
  model?: {
    provider?: string;
    default?: string;
    baseURL?: string;
  };
  customProviders?: Record<string, {
    baseURL: string;
    apiKey?: string;
  }>;
  terminal?: {
    backend?: 'local' | 'docker' | 'ssh';
    cwd?: string;
    dockerImage?: string;
  };
  agent?: {
    maxTurns?: number;
  };
  compression?: {
    enabled?: boolean;
    threshold?: number;
  };
  sessionReset?: {
    mode?: 'both' | 'idle' | 'daily' | 'none';
    idleMinutes?: number;
    atHour?: number;
  };
  mcpServers?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  _configVersion?: number;
}

export const DEFAULT_CONFIG: DUYAConfig = {
  model: {
    provider: 'anthropic',
    default: 'claude-sonnet-4-20250514',
  },
  terminal: {
    backend: 'local',
  },
  agent: {
    maxTurns: 90,
  },
  compression: {
    enabled: true,
    threshold: 0.50,
  },
  sessionReset: {
    mode: 'both',
    idleMinutes: 1440,
    atHour: 4,
  },
  mcpServers: [],
  _configVersion: 1,
};

const CONFIG_VERSION = 1;

export function getDuyaHome(): string {
  return join(homedir(), '.duya');
}

export function getConfigPath(): string {
  return join(getDuyaHome(), 'config.json');
}

export function getEnvPath(): string {
  return join(getDuyaHome(), '.env');
}

export function ensureDuyaHome(): string {
  const home = getDuyaHome();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }
  return home;
}

export function loadConfig(): DUYAConfig {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: DUYAConfig): void {
  ensureDuyaHome();
  const configPath = getConfigPath();
  config._configVersion = CONFIG_VERSION;
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function getEnvValue(key: string): string | undefined {
  // First check process.env
  if (process.env[key]) {
    return process.env[key];
  }
  
  // Then check .env file
  const envPath = getEnvPath();
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match && match[1].trim() === key) {
        return match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return undefined;
}

export function saveEnvValue(key: string, value: string): void {
  ensureDuyaHome();
  const envPath = getEnvPath();
  
  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf-8');
  }
  
  const lines = content.split('\n');
  let found = false;
  const newLines = lines.map(line => {
    const match = line.match(/^([^=]+)=/);
    if (match && match[1].trim() === key) {
      found = true;
      return `${key}="${value}"`;
    }
    return line;
  });
  
  if (!found) {
    newLines.push(`${key}="${value}"`);
  }
  
  writeFileSync(envPath, newLines.join('\n'), 'utf-8');
}

export function resetConfig(): void {
  ensureDuyaHome();
  saveConfig({ ...DEFAULT_CONFIG });
}

export function getMissingEnvVars(): Array<{ name: string; description: string; isRequired: boolean }> {
  const required = [
    { name: 'ANTHROPIC_API_KEY', description: 'Anthropic API key for Claude models', isRequired: false },
    { name: 'OPENAI_API_KEY', description: 'OpenAI API key for GPT models', isRequired: false },
    { name: 'OPENROUTER_API_KEY', description: 'OpenRouter API key for multiple providers', isRequired: false },
  ];
  
  return required.filter(v => !getEnvValue(v.name));
}

export function checkConfigVersion(): { current: number; latest: number } {
  const config = loadConfig();
  return {
    current: config._configVersion || 0,
    latest: CONFIG_VERSION,
  };
}
