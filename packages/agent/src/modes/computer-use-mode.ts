import { computerUseMode as hostComputerUseMode, COMPUTER_USE_MODE_ID } from '@duya/host/worker-modes/modifiers/computer-use-mode';
import {
  getComputerUseToolsWithCua,
  shouldInjectComputerUseContext,
} from '../tool/OSTool/index.js';
import type { ModeModifier } from './types.js';

/**
 * Legacy Agent adapter keeps its capability executors bound to the real
 * Agent ToolUseContext (IPC and decision ports); the prompt and lifecycle
 * hooks come from Host's canonical mode implementation.
 */
export const computerUseMode: ModeModifier = {
  ...hostComputerUseMode,
  tools: {
    ...hostComputerUseMode.tools,
    inject: (context) => getComputerUseToolsWithCua(
      shouldInjectComputerUseContext(context.sessionId),
    ),
  },
};

export { COMPUTER_USE_MODE_ID };
