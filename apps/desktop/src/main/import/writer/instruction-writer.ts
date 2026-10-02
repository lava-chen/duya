import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { ImportItem } from '../types';
import { getLogger, LogComponent } from '../../logging/logger';

const logger = getLogger();
const COMPONENT = 'ImportWriter' as LogComponent;

const IMPORT_BLOCK_START = '<!-- IMPORT_BLOCK_START:';
const IMPORT_BLOCK_END = '<!-- IMPORT_BLOCK_END:';

function formatImportedContent(content: string, item: ImportItem, batchId: string): string {
  return `
${IMPORT_BLOCK_START} ${batchId} ${item.id} -->
<!--
  Imported from ${item.source}: ${item.sourcePath}
  Imported at: ${new Date().toISOString()}
  Source hash: ${item.sourceHash ?? 'N/A'}
  Status: pending review
  Original content preserved. You may edit below this line.
-->
${content}
${IMPORT_BLOCK_END} ${batchId} ${item.id} -->
`;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function appendToFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const exists = await fileExists(filePath);
  if (exists) {
    await fs.promises.appendFile(filePath, '\n' + content, 'utf-8');
  } else {
    await fs.promises.writeFile(filePath, content.trim(), 'utf-8');
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeInstructions(
  items: ImportItem[],
  batchId: string,
  targetProjectPath?: string,
): Promise<{ written: number; paths: string[] }> {
  const writtenPaths: string[] = [];
  let written = 0;

  for (const item of items) {
    if (item.scope !== 'user' && item.scope !== 'project' && item.scope !== 'local-private') {
      continue;
    }

    const sourceContent = await fs.promises.readFile(item.sourcePath, 'utf-8');
    const fileName = path.basename(item.sourcePath);
    const formattedContent = formatImportedContent(sourceContent, item, batchId);

    if (item.scope === 'user') {
      const userAgentsMd = path.join(os.homedir(), '.duya', 'AGENTS.md');
      await appendToFile(userAgentsMd, formattedContent);
      writtenPaths.push(userAgentsMd);
      written++;
    }

    if (item.scope === 'project' && targetProjectPath) {
      const rulesDir = path.join(targetProjectPath, '.duya', 'rules');
      await ensureDir(rulesDir);
      const targetPath = path.join(rulesDir, `imported-${fileName}`);
      await fs.promises.writeFile(targetPath, formattedContent, 'utf-8');
      writtenPaths.push(targetPath);
      written++;
    }

    if (item.scope === 'local-private' && targetProjectPath) {
      const rulesDir = path.join(targetProjectPath, '.duya', 'rules');
      await ensureDir(rulesDir);
      const targetPath = path.join(rulesDir, `private-${fileName}`);
      await fs.promises.writeFile(targetPath, formattedContent, 'utf-8');
      writtenPaths.push(targetPath);
      written++;
    }
  }

  logger.info('Instructions written', { written, batchId }, COMPONENT);
  return { written, paths: writtenPaths };
}

export async function rollbackInstructions(items: Array<{ targetPath: string; batchId: string; itemId: string }>): Promise<void> {
  for (const { targetPath, batchId, itemId } of items) {
    if (!(await fileExists(targetPath))) continue;

    const content = await fs.promises.readFile(targetPath, 'utf-8');
    const startMarker = `${IMPORT_BLOCK_START} ${batchId} ${itemId} -->`;
    const endMarker = `${IMPORT_BLOCK_END} ${batchId} ${itemId} -->`;

    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1) {
      const before = content.slice(0, startIdx);
      const after = content.slice(endIdx + endMarker.length);
      const cleaned = (before + after).trim();
      if (cleaned) {
        await fs.promises.writeFile(targetPath, cleaned + '\n', 'utf-8');
      } else {
        try {
          await fs.promises.unlink(targetPath);
        } catch {
          // file may have been removed already
        }
      }
    }
  }

  logger.info('Instructions rolled back', { count: items.length }, COMPONENT);
}