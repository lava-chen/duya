export enum SessionState {
  IDLE = 'IDLE',
  STREAMING = 'STREAMING',
  COMPLETING = 'COMPLETING',
  CRASHED = 'CRASHED',
  ERROR = 'ERROR',
  COMPLETED = 'COMPLETED',
}

export interface Session {
  id: string;
  state: SessionState;
  createdAt: number;
  workerPid?: number;
  lastCheckpoint?: unknown;
  lastCheckpointTime?: number;
  turnCount: number;
  lastEventId: number;
  exitCode?: number;
  exitSignal?: string;
  errorMessage?: string;
  errorRetryable?: boolean;
  lastDoneData?: unknown;
  lastMessages?: unknown;
}

export interface AgentEvent {
  event: string;
  data: unknown;
}

export interface SessionEventRecord {
  eventId: number;
  eventType: string;
  data: unknown;
  timestamp: number;
}

export const SESSION_EVENT_BUFFER_SIZE = 500;

export enum ConductorSessionState {
  IDLE = 'IDLE',
  EXECUTING = 'EXECUTING',
  ERROR = 'ERROR',
}

export interface CanvasPosition {
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  rotation: number;
}

export interface VizSpec {
  kind: string;
  title?: string;
  description?: string;
  payload: Record<string, unknown>;
}

export interface CanvasElement {
  id: string;
  canvasId: string;
  elementKind: string;
  position: CanvasPosition;
  config: Record<string, unknown>;
  state: string;
  dataVersion: number;
  vizSpec: VizSpec | null;
  sourceCode: string | null;
  permissions: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CanvasInfo {
  id: string;
  name: string;
  description: string | null;
  layoutConfig: Record<string, unknown>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CanvasState {
  canvas: CanvasInfo;
  elements: CanvasElement[];
  conversationHistory: Array<{ role: string; content: string }>;
}

export interface SubAgentInfo {
  agentId: string;
  agentName: string;
  workerSessionId: string;
  startedAt: number;
  status: 'spawning' | 'streaming' | 'done' | 'error' | 'crashed';
}

export interface ConductorSession {
  id: string;
  canvasId: string;
  state: ConductorSessionState;
  canvasState: CanvasState;
  subAgents: Map<string, SubAgentInfo>;
  sseClients: Set<import('http').ServerResponse>;
  createdAt: number;
  lastActionAt: number;
  eventSeqNum: number;
}

export type ConductorAction =
  | { action: 'canvas.rename'; name: string }
  | { action: 'element.create'; elementKind: string; position: CanvasPosition; vizSpec?: VizSpec | null; config?: Record<string, unknown> }
  | { action: 'element.update'; elementId: string; vizSpec?: VizSpec | null; position?: Partial<CanvasPosition>; config?: Record<string, unknown> }
  | { action: 'element.delete'; elementId: string }
  | { action: 'element.move'; elementId: string; position: CanvasPosition }
  | { action: 'element.arrange'; layout: Array<{ elementId: string; position: CanvasPosition }> }
  | { action: string; [key: string]: unknown };

export interface ConductorSSEEvent {
  event: string;
  data: Record<string, unknown>;
}

const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  [SessionState.IDLE]: [SessionState.STREAMING],
  [SessionState.STREAMING]: [SessionState.COMPLETING, SessionState.COMPLETED, SessionState.CRASHED, SessionState.ERROR],
  [SessionState.COMPLETING]: [SessionState.COMPLETED, SessionState.CRASHED],
  [SessionState.CRASHED]: [SessionState.IDLE],
  [SessionState.ERROR]: [SessionState.IDLE],
  [SessionState.COMPLETED]: [SessionState.STREAMING],
};

export function isValidTransition(from: SessionState, to: SessionState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}