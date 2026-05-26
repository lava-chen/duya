/**
 * WikiNodeStore - Manages wiki-llm/ directory structure and node operations
 * Handles canonical nodes, index.md, log.md, and inbox/
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  WikiNode,
  WikiNodeType,
  WikiIndexEntry,
  WikiLogEntry,
} from './types.js';

/**
 * Path security error
 */
export class PathSecurityError extends Error {
  constructor(message: string, public readonly attemptedPath: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/**
 * Wiki directory structure configuration
 */
const WIKI_STRUCTURE = {
  root: 'wiki-llm',
  concepts: 'concepts',
  modules: 'modules',
  classes: 'classes',
  workflows: 'workflows',
  devops: 'devops',
  inbox: 'inbox',
};

/**
 * Maps node type to directory
 */
const TYPE_TO_DIR: Record<WikiNodeType, string> = {
  concept: WIKI_STRUCTURE.concepts,
  module: WIKI_STRUCTURE.modules,
  class: WIKI_STRUCTURE.classes,
  function: WIKI_STRUCTURE.classes,
  workflow: WIKI_STRUCTURE.workflows,
  devops: WIKI_STRUCTURE.devops,
  inbox: WIKI_STRUCTURE.inbox,
};

/**
 * WikiNodeStore - Manages wiki nodes in the file system
 */
export class WikiNodeStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = path.resolve(basePath);
  }

  /**
   * Get the wiki root path
   */
  getRootPath(): string {
    return path.join(this.basePath, WIKI_STRUCTURE.root);
  }

  /**
   * Validate that a path is within the wiki directory (security check)
   */
  private validatePath(targetPath: string): string {
    const resolvedPath = path.resolve(targetPath);
    const rootPath = this.getRootPath();

    // Ensure the resolved path starts with the root path
    const relative = path.relative(rootPath, resolvedPath);

    if (relative.startsWith('..') || relative === '..') {
      throw new PathSecurityError(
        `Path traversal detected: ${targetPath} is outside wiki directory`,
        targetPath
      );
    }

    return resolvedPath;
  }

  /**
   * Initialize the wiki directory structure
   */
  initialize(): void {
    const root = this.getRootPath();

    // Create root directory
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }

    // Create subdirectories
    const dirs = [
      WIKI_STRUCTURE.concepts,
      WIKI_STRUCTURE.modules,
      WIKI_STRUCTURE.classes,
      WIKI_STRUCTURE.workflows,
      WIKI_STRUCTURE.devops,
      WIKI_STRUCTURE.inbox,
    ];

    for (const dir of dirs) {
      const dirPath = path.join(root, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    }

    // Create index.md if it doesn't exist
    const indexPath = path.join(root, 'index.md');
    if (!fs.existsSync(indexPath)) {
      this.writeIndex([]);
    }

    // Create log.md if it doesn't exist
    const logPath = path.join(root, 'log.md');
    if (!fs.existsSync(logPath)) {
      this.writeLog([]);
    }
  }

  /**
   * Check if wiki is initialized
   */
  isInitialized(): boolean {
    const root = this.getRootPath();
    return fs.existsSync(root) && fs.existsSync(path.join(root, 'index.md'));
  }

  /**
   * Generate a safe filename from title
   */
  private sanitizeFilename(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 100);
  }

  /**
   * Generate node path from type and title
   */
  private getNodePath(type: WikiNodeType, title: string): string {
    const dir = TYPE_TO_DIR[type];
    const filename = `${this.sanitizeFilename(title)}.md`;
    return path.join(this.getRootPath(), dir, filename);
  }

  /**
   * Get full path from relative path
   */
  getNodeFullPath(relativePath: string): string {
    return path.join(this.getRootPath(), relativePath);
  }

  /**
   * Parse frontmatter from markdown content
   */
  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return { frontmatter: {}, body: content };
    }

    const frontmatter: Record<string, unknown> = {};
    const lines = match[1].split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();

        // Handle arrays (e.g., aliases: ["foo", "bar"])
        if (value.startsWith('[') && value.endsWith(']')) {
          try {
            frontmatter[key] = JSON.parse(value.replace(/'/g, '"'));
          } catch {
            frontmatter[key] = value;
          }
        } else {
          frontmatter[key] = value;
        }
      }
    }

    return { frontmatter, body: match[2].trim() };
  }

  /**
   * Serialize frontmatter to YAML-like format
   */
  private serializeFrontmatter(frontmatter: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        lines.push(`${key}: [${value.map(v => `"${v}"`).join(', ')}]`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    return `---\n${lines.join('\n')}\n---\n\n`;
  }

  /**
   * Read a node by path
   */
  readNode(nodePath: string): WikiNode {
    const validatedPath = this.validatePath(nodePath);

    if (!fs.existsSync(validatedPath)) {
      throw new Error(`Node not found: ${nodePath}`);
    }

    const content = fs.readFileSync(validatedPath, 'utf-8');
    const { frontmatter, body } = this.parseFrontmatter(content);

    // Determine type from path
    const relativePath = path.relative(this.getRootPath(), validatedPath);
    const typeDir = relativePath.split(path.sep)[0];
    const type = (Object.entries(TYPE_TO_DIR).find(([, dir]) => dir === typeDir)?.[0] || 'concept') as WikiNodeType;

    return {
      id: (frontmatter.id as string) || path.basename(validatedPath, '.md'),
      type,
      title: (frontmatter.title as string) || path.basename(validatedPath, '.md'),
      path: relativePath,
      content: body,
      aliases: (frontmatter.aliases as string[]) || [],
      tags: (frontmatter.tags as string[]) || [],
      createdAt: (frontmatter.createdAt as number) || Date.now(),
      updatedAt: (frontmatter.updatedAt as number) || Date.now(),
      backlinks: (frontmatter.backlinks as string[]) || [],
    };
  }

  /**
   * Write a node to disk
   */
  writeNode(node: WikiNode): void {
    const nodePath = this.getNodePath(node.type, node.title);
    const validatedPath = this.validatePath(nodePath);

    // Ensure directory exists
    const dir = path.dirname(validatedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const frontmatter = {
      id: node.id,
      title: node.title,
      type: node.type,
      aliases: node.aliases,
      tags: node.tags,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      backlinks: node.backlinks,
    };

    const content = this.serializeFrontmatter(frontmatter) + node.content;
    fs.writeFileSync(validatedPath, content, 'utf-8');
  }

  /**
   * Delete a node
   */
  deleteNode(nodePath: string): void {
    const validatedPath = this.validatePath(nodePath);

    if (fs.existsSync(validatedPath)) {
      fs.unlinkSync(validatedPath);
    }
  }

  /**
   * Read the index
   */
  readIndex(): WikiIndexEntry[] {
    const indexPath = path.join(this.getRootPath(), 'index.md');
    this.validatePath(indexPath);

    if (!fs.existsSync(indexPath)) {
      return [];
    }

    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.split('\n');
    const entries: WikiIndexEntry[] = [];

    for (const line of lines) {
      // Parse markdown links: - [Title](path) - summary
      const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)(?: - (.+))?$/);
      if (match) {
        entries.push({
          id: path.basename(match[2], '.md'),
          title: match[1],
          path: match[2],
          type: this.inferTypeFromPath(match[2]),
          aliases: [],
          summary: match[3],
        });
      }
    }

    return entries;
  }

  /**
   * Write the index
   */
  writeIndex(entries: WikiIndexEntry[]): void {
    const indexPath = path.join(this.getRootPath(), 'index.md');
    this.validatePath(indexPath);

    const lines = [
      '# Wiki Index',
      '',
      '## Nodes',
      '',
    ];

    // Group by type
    const byType: Record<string, WikiIndexEntry[]> = {};
    for (const entry of entries) {
      if (!byType[entry.type]) {
        byType[entry.type] = [];
      }
      byType[entry.type].push(entry);
    }

    for (const [type, typeEntries] of Object.entries(byType)) {
      lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`, '');
      for (const entry of typeEntries) {
        const summary = entry.summary ? ` - ${entry.summary}` : '';
        lines.push(`- [${entry.title}](${entry.path})${summary}`);
      }
      lines.push('');
    }

    fs.writeFileSync(indexPath, lines.join('\n'), 'utf-8');
  }

  /**
   * Infer node type from path
   */
  private inferTypeFromPath(nodePath: string): WikiNodeType {
    const parts = nodePath.split('/');
    const dir = parts[0];

    const typeMap: Record<string, WikiNodeType> = {
      [WIKI_STRUCTURE.concepts]: 'concept',
      [WIKI_STRUCTURE.modules]: 'module',
      [WIKI_STRUCTURE.classes]: 'class',
      [WIKI_STRUCTURE.workflows]: 'workflow',
      [WIKI_STRUCTURE.devops]: 'devops',
      [WIKI_STRUCTURE.inbox]: 'inbox',
    };

    return typeMap[dir] || 'concept';
  }

  /**
   * Read the log
   */
  readLog(): WikiLogEntry[] {
    const logPath = path.join(this.getRootPath(), 'log.md');
    this.validatePath(logPath);

    if (!fs.existsSync(logPath)) {
      return [];
    }

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    const entries: WikiLogEntry[] = [];

    for (const line of lines) {
      // Parse log entries: - [timestamp] operation: details
      const match = line.match(/^- \[(\d+)\] (\w+):?\s*(.*)?$/);
      if (match) {
        entries.push({
          timestamp: parseInt(match[1], 10),
          operation: match[2],
          details: match[3] ? { message: match[3] } : undefined,
        });
      }
    }

    return entries;
  }

  /**
   * Write the log
   */
  writeLog(entries: WikiLogEntry[]): void {
    const logPath = path.join(this.getRootPath(), 'log.md');
    this.validatePath(logPath);

    const lines = [
      '# Wiki Log',
      '',
    ];

    // Sort by timestamp descending
    const sortedEntries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

    for (const entry of sortedEntries) {
      const detailsMessage = entry.details && typeof entry.details.message === 'string'
        ? `: ${entry.details.message}`
        : '';
      lines.push(`- [${entry.timestamp}] ${entry.operation}${detailsMessage}`);
    }

    fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');
  }

  /**
   * Append to log
   */
  appendLog(entry: WikiLogEntry): void {
    const entries = this.readLog();
    entries.push(entry);
    this.writeLog(entries);
  }

  /**
   * List all nodes in the wiki
   */
  listAllNodes(): WikiIndexEntry[] {
    const entries: WikiIndexEntry[] = [];
    const root = this.getRootPath();

    const scanDir = (dir: string, type: WikiNodeType) => {
      const fullPath = path.join(root, dir);
      if (!fs.existsSync(fullPath)) return;

      const files = fs.readdirSync(fullPath);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const filePath = path.join(fullPath, file);
          try {
            const node = this.readNode(filePath);
            entries.push({
              id: node.id,
              title: node.title,
              path: path.relative(root, filePath),
              type: node.type,
              aliases: node.aliases,
            });
          } catch {
            // Skip invalid files
          }
        }
      }
    };

    for (const [type, dir] of Object.entries(TYPE_TO_DIR)) {
      scanDir(dir, type as WikiNodeType);
    }

    return entries;
  }

  /**
   * Search nodes by query
   */
  searchNodes(query: string): WikiIndexEntry[] {
    const allNodes = this.listAllNodes();
    const lowerQuery = query.toLowerCase();

    return allNodes.filter(node => {
      // Search in title
      if (node.title.toLowerCase().includes(lowerQuery)) return true;
      // Search in aliases
      if (node.aliases.some(alias => alias.toLowerCase().includes(lowerQuery))) return true;
      return false;
    });
  }
}

/**
 * Create a WikiNodeStore instance
 */
export function createWikiNodeStore(basePath: string): WikiNodeStore {
  return new WikiNodeStore(basePath);
}
