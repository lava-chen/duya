/**
 * Project PromptSystem config — Project Coordinator.
 *
 * A self-contained composition rather than the general config: the
 * Coordinator has no filesystem, shell, browser or device tools, so
 * file-editing rules, skills, vision and desktop capability guidance would
 * only mislead it. The profile suppresses the runtime identity block
 * (`suppressIdentityBlock`), so `projectIdentity` is the first thing the
 * model reads and the whole system prompt is owned by this configuration.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'

export const projectConfig: PromptSystemConfig = {
  name: 'project',
  sections: [
    {
      name: 'projectIdentity',
      template: 'project/identity.hbs',
      cachePolicy: 'once',
      description: 'Project Coordinator identity and boundaries',
    },
    {
      name: 'projectOperation',
      template: 'project/operation.hbs',
      cachePolicy: 'once',
      description: 'Project read, dispatch, reconciliation and durable records',
    },
    {
      name: 'projectDelegation',
      template: 'project/delegation.hbs',
      cachePolicy: 'once',
      description: 'Project Task dispatch contract',
    },
    {
      name: 'projectReporting',
      template: 'project/reporting.hbs',
      cachePolicy: 'once',
      description: 'Evidence-based project reporting and acceptance',
    },
    {
      name: 'projectContextPolicy',
      template: 'project/context-policy.hbs',
      cachePolicy: 'once',
      description: 'Context authority, replacement and recovery',
    },
    { module: 'finalAnswer', cachePolicy: 'once' },
  ],
}
