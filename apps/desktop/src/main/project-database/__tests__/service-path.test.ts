import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectDatabasePath } from '../service';

const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-project-db-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveProjectDatabasePath', () => {
  it('creates and resolves the database only under the project .duya directory', () => {
    const projectPath = makeDirectory();

    const databasePath = resolveProjectDatabasePath(projectPath);

    expect(databasePath).toBe(path.join(fs.realpathSync.native(projectPath), '.duya', 'database.sqlite'));
    expect(fs.statSync(path.dirname(databasePath)).isDirectory()).toBe(true);
  });

  it('rejects a file path as the project root', () => {
    const directory = makeDirectory();
    const filePath = path.join(directory, 'not-a-project');
    fs.writeFileSync(filePath, 'x');

    expect(() => resolveProjectDatabasePath(filePath)).toThrow('Project path must be a directory');
  });
});
