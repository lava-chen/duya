import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import { CODE_REVIEW_AGENT } from './built-in/codeReviewAgent.js'
import { RESEARCH_AGENT } from './built-in/researchAgent.js'
import { SKILL_CREATOR_AGENT } from './built-in/creatorAgent.js'
import { SKILL_EVALUATOR_AGENT } from './built-in/evaluatorAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

export function getBuiltInAgents(): AgentDefinition[] {
  const agents: AgentDefinition[] = [
    GENERAL_PURPOSE_AGENT,
    EXPLORE_AGENT,
    PLAN_AGENT,
    VERIFICATION_AGENT,
    CODE_REVIEW_AGENT,
    RESEARCH_AGENT,
    SKILL_CREATOR_AGENT,
    SKILL_EVALUATOR_AGENT,
  ]

  return agents
}

export { EXPLORE_AGENT, GENERAL_PURPOSE_AGENT, PLAN_AGENT, VERIFICATION_AGENT, CODE_REVIEW_AGENT, RESEARCH_AGENT, SKILL_CREATOR_AGENT, SKILL_EVALUATOR_AGENT }
