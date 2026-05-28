export type ResearchTaskIntent =
  | 'paper_reading'
  | 'literature_review'
  | 'research_planning'
  | 'hypothesis_update'
  | 'experiment_planning'
  | 'writing_assistance'
  | 'citation_check'
  | 'memory_review'
  | 'general_research_chat'

export interface ResearchPromptRuntimeContext {
  intent: ResearchTaskIntent
  projectId?: string
}

