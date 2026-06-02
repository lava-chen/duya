import { ipcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger, LogComponent } from '../logging/logger';
import { scanClaudeCode } from './scanner/claude-code-scanner';
import { scanCodexSessions } from './scanner/codex-session-scanner';
import { scanClaudeSessions } from './scanner/claude-session-scanner';
import { createBatch, addItem, updateBatchStatus, rollbackBatchItems, getBatchItems, listBatches } from './batch-store';
import { writeInstructions, rollbackInstructions } from './writer/instruction-writer';
import { writeMemories, rollbackMemories } from './writer/memory-writer';
import { writeSessions, rollbackSessions } from './writer/session-writer';
import type { ImportSource, ScanResult, ApplyImportParams, ImportManifest, ImportBatch, ImportItem } from '../types';

const logger = getLogger();
const COMPONENT = 'ImportHandlers' as LogComponent;

function isClaudeCodeInstalled(): boolean {
  const userDir = path.join(os.homedir(), '.claude');
  try {
    return fs.existsSync(userDir);
  } catch {
    return false;
  }
}

function isCodexInstalled(): boolean {
  const userDir = path.join(os.homedir(), '.codex');
  try {
    return fs.existsSync(userDir);
  } catch {
    return false;
  }
}

export function registerImportHandlers(): void {
  ipcMain.handle('import:detect', async (): Promise<{ claude: boolean; codex: boolean }> => {
    return {
      claude: isClaudeCodeInstalled(),
      codex: isCodexInstalled(),
    };
  });

  ipcMain.handle('import:scan', async (
    _event,
    params: { source: ImportSource; projectPath?: string },
  ): Promise<ScanResult> => {
    try {
      logger.info('Starting import scan', { source: params.source, projectPath: params.projectPath }, COMPONENT);

      if (params.source === 'claude-code') {
        const result = await scanClaudeCode(params.projectPath);
        const sessions = await scanClaudeSessions();
        return { ...result, sessions };
      }

      if (params.source === 'codex') {
        const sessions = await scanCodexSessions();
        return {
          source: 'codex',
          detectedInstallation: isCodexInstalled(),
          projectPath: params.projectPath,
          userScopeItems: [],
          projectScopeItems: [],
          summary: {
            projectInstructions: 0,
            projectMemory: 0,
            skills: 0,
            mcp: 0,
            agents: 0,
            hooks: 0,
            knowledgeDocs: 0,
            restricted: 0,
          },
          sessions,
        };
      }

      throw new Error(`Unsupported source: ${params.source}`);
    } catch (error) {
      logger.error('Import scan failed', error instanceof Error ? error : new Error(String(error)), COMPONENT);
      throw error;
    }
  });

  ipcMain.handle('import:apply', async (
    _event,
    params: ApplyImportParams,
  ): Promise<ImportManifest> => {
    try {
      const totalItems = params.items.length + (params.sessions?.length ?? 0);
      logger.info('Applying import', { itemCount: totalItems }, COMPONENT);

      const batch = createBatch({
        source: params.items[0]?.source ?? params.sessions?.[0]?.source ?? 'unknown',
        sourceProjectPath: params.targetProjectPath,
        targetProjectPath: params.targetProjectPath,
        totalItems,
      });

      const instructionItems: ImportItem[] = [];
      const memoryItems: ImportItem[] = [];
      let skippedCount = 0;
      let needsAuthCount = 0;
      let disabledCount = 0;

      for (const item of params.items) {
        if (!item.defaultSelected) {
          skippedCount++;
          continue;
        }

        if (item.requiresAuthorization) {
          needsAuthCount++;
          skippedCount++;
          continue;
        }

        const itemType = item.type;
        if (itemType === 'user_preference' || itemType === 'project_instruction' || itemType === 'knowledge_doc') {
          instructionItems.push(item);
        } else if (itemType === 'project_memory') {
          memoryItems.push(item);
        } else {
          skippedCount++;
        }
      }

      const instructionResult = await writeInstructions(instructionItems, batch.id, params.targetProjectPath);
      for (let i = 0; i < instructionItems.length; i++) {
        addItem({
          batchId: batch.id,
          item: instructionItems[i],
          targetType: instructionItems[i].type,
          targetPath: instructionResult.paths[i] ?? '',
        });
      }

      const memoryResult = await writeMemories(memoryItems, batch.id, params.targetProjectPath);
      for (let i = 0; i < memoryItems.length; i++) {
        addItem({
          batchId: batch.id,
          item: memoryItems[i],
          targetType: memoryItems[i].type,
          targetPath: memoryResult.paths[i] ?? '',
        });
      }

      let sessionCount = 0;
      if (params.sessions && params.sessions.length > 0) {
        const sessionResults = await writeSessions(params.sessions, batch.id);
        sessionCount = sessionResults.length;

        for (const result of sessionResults) {
          const sessionItem = params.sessions.find((s) => s.sessionId === result.sessionId);
          if (sessionItem) {
            addItem({
              batchId: batch.id,
              item: {
                id: sessionItem.id,
                source: sessionItem.source,
                sourcePath: sessionItem.sourcePath,
                sourceHash: undefined,
                type: 'session',
                title: sessionItem.title,
                summary: `${sessionItem.messageCount} messages`,
                contentPreview: '',
                scope: 'project',
                riskLevel: 'safe',
                requiresAuthorization: false,
                conflictKeys: [],
                defaultSelected: true,
              },
              targetType: 'session',
              targetPath: `chat_sessions:${result.sessionId}`,
            });
          }
        }
      }

      const appliedCount = instructionResult.written + memoryResult.written;
      updateBatchStatus(batch.id, 'applied', appliedCount + sessionCount);

      const manifest: ImportManifest = {
        batchId: batch.id,
        source: batch.source as ImportSource,
        appliedCount,
        skippedCount,
        needsAuthCount,
        disabledCount,
        sessionCount,
        createdAt: batch.createdAt,
      };

      logger.info('Import applied', manifest, COMPONENT);
      return manifest;
    } catch (error) {
      logger.error('Import apply failed', error instanceof Error ? error : new Error(String(error)), COMPONENT);
      throw error;
    }
  });

  ipcMain.handle('import:rollback', async (
    _event,
    params: { batchId: string },
  ): Promise<void> => {
    try {
      logger.info('Rolling back import', { batchId: params.batchId }, COMPONENT);

      const items = getBatchItems(params.batchId);
      const instructionRollbacks: Array<{ targetPath: string; batchId: string; itemId: string }> = [];
      const memoryRollbacks: Array<{ targetPath: string; batchId: string; itemId: string }> = [];
      const sessionRollbackIds: string[] = [];

      for (const item of items) {
        if (item.status !== 'imported') continue;

        if (item.targetType === 'session') {
          const sessionId = item.targetPath.startsWith('chat_sessions:')
            ? item.targetPath.slice('chat_sessions:'.length)
            : item.targetPath;
          sessionRollbackIds.push(sessionId);
        } else if (item.targetType === 'user_preference' || item.targetType === 'project_instruction' || item.targetType === 'knowledge_doc') {
          instructionRollbacks.push({
            targetPath: item.targetPath,
            batchId: item.batchId,
            itemId: item.id,
          });
        } else if (item.targetType === 'project_memory') {
          memoryRollbacks.push({
            targetPath: item.targetPath,
            batchId: item.batchId,
            itemId: item.id,
          });
        }
      }

      if (instructionRollbacks.length > 0) {
        await rollbackInstructions(instructionRollbacks);
      }
      if (memoryRollbacks.length > 0) {
        await rollbackMemories(memoryRollbacks);
      }
      if (sessionRollbackIds.length > 0) {
        await rollbackSessions(sessionRollbackIds);
      }

      rollbackBatchItems(params.batchId);
      updateBatchStatus(params.batchId, 'rolled_back', 0);

      logger.info('Import rolled back', { batchId: params.batchId }, COMPONENT);
    } catch (error) {
      logger.error('Import rollback failed', error instanceof Error ? error : new Error(String(error)), COMPONENT);
      throw error;
    }
  });

  ipcMain.handle('import:history', async (): Promise<ImportBatch[]> => {
    try {
      return listBatches();
    } catch (error) {
      logger.error('Import history failed', error instanceof Error ? error : new Error(String(error)), COMPONENT);
      throw error;
    }
  });
}