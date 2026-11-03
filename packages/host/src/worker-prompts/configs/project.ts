/**
 * Project PromptSystem config — Project Coordinator.
 *
 * A dedicated composition rather than the general config: the Coordinator
 * has no filesystem, shell, browser or device tools, so file-editing rules,
 * skills, vision and desktop capability guidance would only mislead it. The
 * profile's identity prompt is prepended by the runtime (`host:identity`),
 * so this config carries the delegation and reporting contracts rather than
 * a second identity.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'

export const projectConfig: PromptSystemConfig = {
  name: 'project',
  sections: [
    { module: 'system', cachePolicy: 'once' },
    { module: 'tools', cachePolicy: 'once' },
    { module: 'tasks', cachePolicy: 'once' },
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
    { module: 'finalAnswer', cachePolicy: 'once' },
  ],
}
