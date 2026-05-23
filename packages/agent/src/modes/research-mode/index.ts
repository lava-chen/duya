import { ModeRegistry } from '../index.js';
import { ResearchModeStub } from './types.js';

ModeRegistry.register('research', ResearchModeStub);

export { ResearchModeStub as ResearchMode } from './types.js';
export {
  OrchestratorPhase,
  type ResearchQuestion,
  type ResearchFinding,
  type FindingContradiction,
  type ResearchEntity,
} from './types.js';