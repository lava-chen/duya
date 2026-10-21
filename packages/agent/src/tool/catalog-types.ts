import type { Tool } from '../types.js';
import type { ToolExecutor } from './registry.js';
import type {
  ToolCatalogEntry as RuntimeToolCatalogEntry,
  ToolCatalogSource,
  ToolDiscoveryMeta,
  ToolExposure,
  ToolSourceKind,
} from '@duya/agent-runtime/tools/catalog';

export type { ToolCatalogSource, ToolDiscoveryMeta, ToolExposure, ToolSourceKind };
export type ToolCatalogEntry = RuntimeToolCatalogEntry<Tool, ToolExecutor>;
