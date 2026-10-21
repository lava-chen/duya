import type { Tool } from '../types.js';
import type { ToolExecutor } from './registry.js';
import type { ToolSnapshot as RuntimeToolSnapshot } from '@duya/agent-runtime/tools/catalog';

/** Agent-specialized view over the Runtime-owned immutable catalog snapshot. */
export type ToolSnapshot = RuntimeToolSnapshot<Tool, ToolExecutor>;
