import * as fs from 'node:fs';
import type { MemoryToolFilePort } from '@duya/capabilities';

export const nodeMemoryToolFilePort: MemoryToolFilePort = {
  ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
  },
  readTextFileIfExists(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  },
  writeTextFile(filePath, content) {
    fs.writeFileSync(filePath, content, 'utf8');
  },
};
