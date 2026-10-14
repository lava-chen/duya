export interface PlanStatusInput {
  projectId: string;
  status?: 'active' | 'all';
}

export interface PlanStatusResult {
  projectId: string;
  plans: Array<{
    id: number | null;
    slug: string;
    title: string;
    status: string;
    priority?: string;
    tags?: string[];
    file: string;
    created?: string;
    updated?: string;
  }>;
  idHealth?: {
    hasIssues: boolean;
    missingIds: number[];
    skips: Array<{ from: number; to: number; missing: number[] }>;
    warning: string | null;
  };
}

export interface PlanSearchInput {
  query: string;
  scope?: 'all' | 'project';
  projectId?: string;
}

export interface PlanSearchResult {
  results: Array<{
    projectId: string;
    id: number | null;
    slug: string;
    title: string;
    status: string;
    file: string;
    snippet: string;
  }>;
}

export interface PlanCompleteInput {
  projectId: string;
  planId: number;
}

export interface PlanCompleteResult {
  ok: boolean;
  newFile: string;
}

/** Filesystem access for the plans tool stays in Host. */
export interface PlanStoragePort {
  planStatus(input: PlanStatusInput): PlanStatusResult | Promise<PlanStatusResult>;
  planSearch(input: PlanSearchInput): PlanSearchResult | Promise<PlanSearchResult>;
  planComplete(input: PlanCompleteInput): PlanCompleteResult | Promise<PlanCompleteResult>;
  getPlansDirectory(projectId: string): string;
}
