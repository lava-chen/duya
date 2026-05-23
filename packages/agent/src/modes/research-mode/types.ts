import type { ModeContext } from '../types.js';
import { BaseMode } from '../types.js';
import type { SSEEvent } from '../../types.js';

export enum OrchestratorPhase {
  IDLE = 'idle',
  CLARIFICATION = 'clarification',
  PLANNING = 'planning',
  RESEARCH_LOOP = 'research_loop',
  SYNTHESIS = 'synthesis',
  INTERACTIVE_REPORT = 'interactive_report',
  COMPLETE = 'complete',
  ABORTED = 'aborted',
}

export interface ResearchQuestion {
  id: string;
  text: string;
  status: 'pending' | 'answered' | 'obsolete';
  priority: 'high' | 'medium' | 'low';
  parentId?: string;
  createdAt: number;
}

export interface ResearchFinding {
  id: string;
  text: string;
  sources: string[];
  questionIds: string[];
  contradictions?: FindingContradiction[];
  createdAt: number;
}

export interface FindingContradiction {
  againstFindingId: string;
  description: string;
}

export interface ResearchEntity {
  name: string;
  normalizedName: string;
  aliases: string[];
  occurrences: number;
}

export class ResearchModeStub extends BaseMode {
  readonly name = 'Research';
  readonly modeId = 'research';

  async *execute(
    _query: string,
    _ctx: ModeContext
  ): AsyncGenerator<SSEEvent, void, unknown> {
    yield { type: 'done', reason: 'completed' };
  }
}