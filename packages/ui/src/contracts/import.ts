export type ImportSource = 'claude-code' | 'codex';

export type ImportItemType =
  | 'user_preference'
  | 'project_instruction'
  | 'project_memory'
  | 'skill'
  | 'mcp'
  | 'agent'
  | 'hook'
  | 'knowledge_doc'
  | 'session';

export type RiskLevel = 'safe' | 'review' | 'restricted';

export interface ImportItem {
  id: string;
  source: ImportSource;
  sourcePath: string;
  sourceHash?: string;
  type: ImportItemType;
  title: string;
  summary: string;
  contentPreview: string;
  scope: 'user' | 'project' | 'local-private';
  riskLevel: RiskLevel;
  requiresAuthorization: boolean;
  conflictKeys: string[];
  defaultSelected: boolean;
}

export interface ScanResult {
  source: ImportSource;
  detectedInstallation: boolean;
  projectPath?: string;
  userScopeItems: ImportItem[];
  projectScopeItems: ImportItem[];
  summary: {
    projectInstructions: number;
    projectMemory: number;
    skills: number;
    mcp: number;
    agents: number;
    hooks: number;
    knowledgeDocs: number;
    restricted: number;
  };
  sessions: SessionImportItem[];
}

export interface ConflictResolution {
  itemId: string;
  resolution: 'keep_duya' | 'use_imported' | 'keep_both_as_note';
}

export interface ApplyImportParams {
  items: ImportItem[];
  conflictResolutions: ConflictResolution[];
  targetProjectPath?: string;
  sessions?: SessionImportItem[];
}

export interface ImportManifest {
  batchId: string;
  source: ImportSource;
  appliedCount: number;
  skippedCount: number;
  needsAuthCount: number;
  disabledCount: number;
  sessionCount: number;
  createdAt: number;
}

export interface ImportBatch {
  id: string;
  source: string;
  sourceProjectPath: string | null;
  targetProjectPath: string | null;
  status: string;
  totalItems: number;
  appliedItems: number;
  createdAt: number;
  rolledBackAt: number | null;
}

export interface ImportItemRecord {
  id: string;
  batchId: string;
  sourceType: string;
  sourcePath: string;
  sourceHash: string | null;
  targetType: string;
  targetPath: string;
  title: string;
  summary: string | null;
  riskLevel: string;
  requiresAuth: number;
  isEnabled: number;
  status: string;
  createdAt: number;
}

export interface SessionImportItem {
  id: string;
  source: ImportSource;
  sourcePath: string;
  sessionId: string;
  title: string;
  messageCount: number;
  workingDirectory: string;
  projectName: string;
  createdAt: number;
  lastActivityAt: number;
  sizeBytes: number;
  defaultSelected: boolean;
}