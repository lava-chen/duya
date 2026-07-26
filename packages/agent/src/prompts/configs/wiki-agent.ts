/**
 * Wiki-Agent PromptSystem config.
 *
 * Replaces the previous WikiAgentPromptSystem subclass (~374 lines).
 *
 * Static sections: wiki-intro / wiki-task / wiki-output-format (all bypass profile).
 * Dynamic sections: wiki-context / wiki-existing-nodes (both bypass profile).
 *
 * contextExtender injects wiki-specific fields (wikiBasePath, existingNodes=[]).
 * Note: existingNodes is initialized to [] here; WikiAgentProcessor sets the
 * real nodes on the context after buildContext returns.
 *
 * The 4 parallel prompt generators (cheapClassifier, candidateExtraction,
 * mergeJudge, nodeRewrite) are NOT registered here — WikiAgentProcessor
 * imports them directly from ./wikiPromptBuilders.ts.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import {
  getWikiIntroSection,
  getWikiTaskSection,
  getWikiOutputFormatSection,
  getWikiContextSection,
  getWikiExistingNodesSection,
} from './wikiPromptBuilders.js'

export const wikiAgentConfig: PromptSystemConfig = {
  name: 'wiki-agent',
  staticSections: [
    { name: 'wiki-intro', compute: getWikiIntroSection, bypassProfile: true },
    { name: 'wiki-task', compute: getWikiTaskSection, bypassProfile: true },
    { name: 'wiki-output-format', compute: getWikiOutputFormatSection, bypassProfile: true },
  ],
  dynamicSections: [
    { name: 'wiki-context', compute: getWikiContextSection, bypassProfile: true, description: 'Context changes per extraction' },
    { name: 'wiki-existing-nodes', compute: getWikiExistingNodesSection, bypassProfile: true, description: 'Node list changes over time' },
  ],
  contextExtender: (base, options) => {
    const wikiOptions = options as typeof options & { wikiBasePath?: string }
    // Inject wiki fields. existingNodes starts empty; WikiAgentProcessor
    // populates it from the store after buildContext returns.
    return {
      wikiBasePath: wikiOptions.wikiBasePath ?? base.workingDirectory,
      existingNodes: [],
    } as Partial<typeof base>
  },
  // No preBuildHook — wiki-agent doesn't use AGENTS.md.
}
