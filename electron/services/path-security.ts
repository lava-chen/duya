import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { homedir } from 'os';

/**
 * Check if a path is within allowed directories (userData or home directory)
 */
export function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const userDataDir = path.resolve(app.getPath('userData'));
  const homeDir = path.resolve(homedir());

  if (resolved.startsWith(userDataDir + path.sep) || resolved === userDataDir) return true;
  if (resolved.startsWith(homeDir + path.sep) || resolved === homeDir) return true;

  return false;
}