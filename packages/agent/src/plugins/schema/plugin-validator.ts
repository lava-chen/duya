import { join } from 'path';
import { parsePluginMarkdown } from './markdown-parser.js';
import { validatePluginManifestLenient } from './lenient-validator.js';
import {
  inferCapabilitiesFromDir,
  mergeCapabilitiesWithDeclared,
} from './capability-inferrer.js';
import type {
  LenientValidationResult,
  ValidatedCapabilities,
  LenientValidationWarning,
} from './types.js';

export interface PluginValidationResult extends LenientValidationResult {
  capabilities: ValidatedCapabilities;
  agentContext: string;
}

export function validatePluginFromDir(
  dirPath: string
): PluginValidationResult {
  const pluginMdPath = join(dirPath, 'plugin.md');
  const parseResult = parsePluginMarkdown(pluginMdPath);

  const validationResult = parseResult.frontmatter
    ? validatePluginManifestLenient(parseResult.frontmatter as unknown as Record<string, unknown>)
    : {
        valid: false,
        warnings: [{ field: 'frontmatter', message: 'No frontmatter found in plugin.md' }] as LenientValidationWarning[],
        manifest: {},
        capabilities: { commands: [], skills: [], agents: [], hooks: [] } as ValidatedCapabilities,
        agentContext: '',
        complete: false,
      };

  const inferredCapabilities = inferCapabilitiesFromDir(dirPath);
  const mergedCapabilities = mergeCapabilitiesWithDeclared(
    validationResult.capabilities,
    inferredCapabilities
  );

  let agentContext = validationResult.agentContext;

  if (!agentContext && parseResult.body) {
    agentContext = parseResult.body;
  }

  if (parseResult.frontmatter?.agent_context && parseResult.body) {
    agentContext = parseResult.frontmatter.agent_context + '\n\n---\n\n' + parseResult.body;
  }
  if (parseResult.frontmatter?.agent_context && !parseResult.body) {
    agentContext = parseResult.frontmatter.agent_context;
  }

  return {
    ...validationResult,
    capabilities: mergedCapabilities,
    agentContext,
  };
}