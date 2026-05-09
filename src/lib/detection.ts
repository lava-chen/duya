/**
 * Auto-detection of installed MCP servers, Claude Code skills, and CLI tools.
 * Inspired by CodePilot's detection patterns.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { MCPServerConfig } from '@duya/agent';

const execFileAsync = promisify(execFile);

// ── Paths ────────────────────────────────────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const MCP_CONFIG_PATHS = [
  path.join(os.homedir(), '.mcp.json'),           // User-level
  path.join(CLAUDE_DIR, 'settings.json'),          // Claude Code settings
  path.join(process.cwd(), '.mcp.json'),           // Project-level
];
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');

// ── Cache ──────────────────────────────────────────────────────────────────────

interface DetectionCache {
  mcpServers: DetectedMCP[];
  skills: DetectedSkill[];
  cliTools: CliToolRuntimeInfo[];
  timestamp: number;
}

const CACHE_TTL = 120_000; // 2 minutes
let _cache: DetectionCache | null = null;

function isCacheValid(): boolean {
  return _cache !== null && Date.now() - _cache.timestamp < CACHE_TTL;
}

function invalidateCache(): void {
  _cache = null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DetectedMCP {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  isAutoDetected?: boolean;
}

export interface DetectedSkill {
  name: string;
  description?: string;
  path: string;
  source: 'skills' | 'plugin';
  hasCommands?: boolean;
  hasAgents?: boolean;
}

export interface CliToolRuntimeInfo {
  id: string;
  status: 'installed' | 'not_installed';
  version: string | null;
  binPath: string | null;
}

export interface DetectionResult {
  mcpServers: DetectedMCP[];
  skills: DetectedSkill[];
  cliTools: CliToolRuntimeInfo[];
  errors: string[];
}

// ── CLI Tools Catalog ─────────────────────────────────────────────────────────

interface CliToolDefinition {
  id: string;
  binNames: string[];
}

const CLI_TOOLS_CATALOG: CliToolDefinition[] = [
  { id: 'docker', binNames: ['docker'] },
  { id: 'git', binNames: ['git'] },
  { id: 'npm', binNames: ['npm'] },
  { id: 'node', binNames: ['node'] },
  { id: 'python', binNames: ['python', 'python3'] },
  { id: 'pip', binNames: ['pip', 'pip3'] },
  { id: 'uv', binNames: ['uv'] },
  { id: 'cargo', binNames: ['cargo'] },
  { id: 'rustc', binNames: ['rustc'] },
  { id: 'go', binNames: ['go'] },
  { id: 'kubectl', binNames: ['kubectl'] },
  { id: 'helm', binNames: ['helm'] },
  { id: 'terraform', binNames: ['terraform'] },
  { id: 'ansible', binNames: ['ansible'] },
  { id: 'mysql', binNames: ['mysql'] },
  { id: 'psql', binNames: ['psql'] },
  { id: 'mongosh', binNames: ['mongosh'] },
  { id: 'redis-cli', binNames: ['redis-cli'] },
  { id: 'docker-compose', binNames: ['docker-compose', 'docker compose'] },
  { id: 'kubectl', binNames: ['kubectl'] },
];

// ── MCP Detection ─────────────────────────────────────────────────────────────

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function detectMCPServersFromPath(configPath: string): Record<string, MCPServerConfig> {
  const config = readJsonFile(configPath);
  if (!config || typeof config !== 'object') return {};

  // Handle different config formats
  const mcpServers = config.mcpServers || config;
  if (mcpServers && typeof mcpServers === 'object') {
    const result: Record<string, MCPServerConfig> = {};
    for (const [name, server] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (name === 'mcpServers') continue; // Skip nested mcpServers
      if (server && typeof server === 'object') {
        const s = server as Record<string, unknown>;
        if (typeof s.command === 'string') {
          result[name] = {
            name,
            command: s.command,
            args: Array.isArray(s.args) ? s.args as string[] : undefined,
            env: s.env && typeof s.env === 'object' ? s.env as Record<string, string> : undefined,
          };
        }
      }
    }
    return result;
  }
  return {};
}

export function detectMCPServers(): DetectedMCP[] {
  const servers: DetectedMCP[] = [];
  const seen = new Set<string>();

  for (const configPath of MCP_CONFIG_PATHS) {
    const configs = detectMCPServersFromPath(configPath);
    for (const [name, server] of Object.entries(configs)) {
      if (!seen.has(name)) {
        seen.add(name);
        servers.push({
          name,
          command: server.command,
          args: server.args,
          env: server.env,
          isAutoDetected: true,
        });
      }
    }
  }

  return servers;
}

// ── Skills Detection ───────────────────────────────────────────────────────────

function readPluginManifest(pluginDir: string): { name?: string; description?: string } | null {
  const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

function detectSkillsFromDir(skillsDir: string, source: 'skills' | 'plugin'): DetectedSkill[] {
  const skills: DetectedSkill[] = [];
  if (!fs.existsSync(skillsDir)) return skills;

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(skillsDir, entry.name);
      const skillJsonPath = path.join(skillPath, 'skill.json');

      let description: string | undefined;
      if (fs.existsSync(skillJsonPath)) {
        try {
          const content = fs.readFileSync(skillJsonPath, 'utf-8');
          const skillMeta = JSON.parse(content);
          description = skillMeta.description;
        } catch {
          // Ignore parse errors
        }
      }

      skills.push({
        name: entry.name,
        description,
        path: skillPath,
        source,
        hasCommands: fs.existsSync(path.join(skillPath, 'commands')),
        hasAgents: fs.existsSync(path.join(skillPath, 'agents')),
      });
    }
  } catch {
    // Ignore directory read errors
  }

  return skills;
}

export function detectSkills(): DetectedSkill[] {
  const skills: DetectedSkill[] = [];

  // Detect from ~/.claude/skills/
  skills.push(...detectSkillsFromDir(SKILLS_DIR, 'skills'));

  // Detect from Claude Code plugins: ~/.claude/plugins/marketplaces/*/plugins/*/skills/
  // and ~/.claude/plugins/external_plugins/*/skills/
  if (fs.existsSync(PLUGINS_DIR)) {
    try {
      // Check marketplaces
      const marketplacesDir = path.join(PLUGINS_DIR, 'marketplaces');
      if (fs.existsSync(marketplacesDir)) {
        for (const marketplace of fs.readdirSync(marketplacesDir, { withFileTypes: true })) {
          if (!marketplace.isDirectory()) continue;
          const pluginsDir = path.join(marketplacesDir, marketplace.name, 'plugins');
          if (!fs.existsSync(pluginsDir)) continue;

          for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
            if (!plugin.isDirectory()) continue;
            const pluginSkillsDir = path.join(pluginsDir, plugin.name, 'skills');
            if (fs.existsSync(pluginSkillsDir)) {
              const manifest = readPluginManifest(path.join(pluginsDir, plugin.name));
              skills.push(...detectSkillsFromDir(pluginSkillsDir, 'plugin').map(s => ({
                ...s,
                description: s.description || manifest?.description,
              })));
            }
          }
        }
      }

      // Check external_plugins
      const externalDir = path.join(PLUGINS_DIR, 'external_plugins');
      if (fs.existsSync(externalDir)) {
        for (const plugin of fs.readdirSync(externalDir, { withFileTypes: true })) {
          if (!plugin.isDirectory()) continue;
          const pluginSkillsDir = path.join(externalDir, plugin.name, 'skills');
          if (fs.existsSync(pluginSkillsDir)) {
            const manifest = readPluginManifest(path.join(externalDir, plugin.name));
            skills.push(...detectSkillsFromDir(pluginSkillsDir, 'plugin').map(s => ({
              ...s,
              description: s.description || manifest?.description,
            })));
          }
        }
      }
    } catch {
      // Ignore plugin directory errors
    }
  }

  return skills;
}

// ── CLI Tools Detection ────────────────────────────────────────────────────────

function isWindows(): boolean {
  return process.platform === 'win32';
}

function getExpandedPath(): string {
  const pathEnv = process.env.PATH || '';
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';

  if (isWindows()) {
    // Include Windows system paths
    const systemPaths = [
      path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ];
    return [...systemPaths, pathEnv].join(path.delimiter);
  }
  return pathEnv;
}

async function detectCliTool(tool: CliToolDefinition): Promise<CliToolRuntimeInfo> {
  const expandedPath = getExpandedPath();
  const env = { ...process.env, PATH: expandedPath };

  for (const bin of tool.binNames) {
    try {
      const whichCmd = isWindows() ? 'where' : '/usr/bin/which';
      const { stdout } = await execFileAsync(whichCmd, [bin], {
        timeout: 5000,
        env,
        shell: isWindows(),
      });
      const resolvedPath = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (!resolvedPath) continue;

      let version: string | null = null;
      try {
        const { stdout: versionOut, stderr: versionErr } = await execFileAsync(
          resolvedPath,
          ['--version'],
          { timeout: 5000, env }
        );
        const versionText = (versionOut || versionErr).trim();
        const match = versionText.split('\n')[0]?.match(/(\d+\.\d+[\w.-]*)/);
        if (match) {
          version = match[1];
        }
      } catch {
        // Version extraction optional
      }

      return {
        id: tool.id,
        status: 'installed',
        version,
        binPath: resolvedPath,
      };
    } catch {
      // Try next bin name
    }
  }

  return {
    id: tool.id,
    status: 'not_installed',
    version: null,
    binPath: null,
  };
}

export async function detectCliTools(): Promise<CliToolRuntimeInfo[]> {
  return Promise.all(CLI_TOOLS_CATALOG.map(tool => detectCliTool(tool)));
}

// ── Main API ───────────────────────────────────────────────────────────────────

export async function detectAll(forceRefresh = false): Promise<DetectionResult> {
  if (!forceRefresh && isCacheValid()) {
    return {
      mcpServers: _cache!.mcpServers,
      skills: _cache!.skills,
      cliTools: _cache!.cliTools,
      errors: [],
    };
  }

  const [mcpServers, skills, cliTools] = await Promise.all([
    Promise.resolve(detectMCPServers()),
    Promise.resolve(detectSkills()),
    detectCliTools(),
  ]);

  _cache = {
    mcpServers,
    skills,
    cliTools,
    timestamp: Date.now(),
  };

  return { mcpServers, skills, cliTools, errors: [] };
}

export function invalidateDetectionCache(): void {
  invalidateCache();
}
