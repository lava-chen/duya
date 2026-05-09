/**
 * Config file reader for agent package
 * Reads the same config file as the frontend to get database path
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface AppConfig {
  databasePath?: string;
}

const CONFIG_FILE_NAME = 'duya-config.json';

/**
 * Get the config file path
 * Uses APPDATA/DUYA/duya-config.json on Windows, or equivalent on other platforms
 */
function getConfigFilePath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'DUYA', CONFIG_FILE_NAME);
  } else if (process.platform === 'darwin') {
    return path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support', 'DUYA', CONFIG_FILE_NAME);
  } else {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'DUYA', CONFIG_FILE_NAME);
  }
}

/**
 * Read the config file
 */
export function readConfig(): AppConfig {
  const configPath = getConfigFilePath();
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as AppConfig;
    }
  } catch (err) {
    // Silent fail - config file is optional
  }
  return {};
}

/**
 * Get the custom database path from config
 */
export function getConfigDatabasePath(): string | undefined {
  const config = readConfig();
  return config.databasePath;
}
