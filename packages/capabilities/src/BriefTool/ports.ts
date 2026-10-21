import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface BriefDirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/** File access required by BriefTool, scoped by the caller's workspace root. */
export interface BriefWorkspacePort {
  readDirectory(workspaceRoot: string, relativePath: string): Promise<readonly BriefDirectoryEntry[]>;
  readTextFile(workspaceRoot: string, relativePath: string): Promise<string>;
}

/** Node adapter used by the legacy Agent singleton and Node hosts by default. */
export class NodeBriefWorkspacePort implements BriefWorkspacePort {
  async readDirectory(workspaceRoot: string, relativePath: string): Promise<readonly BriefDirectoryEntry[]> {
    const directoryPath = resolve(workspaceRoot, relativePath);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  }

  readTextFile(workspaceRoot: string, relativePath: string): Promise<string> {
    return readFile(resolve(workspaceRoot, relativePath), 'utf-8');
  }
}

