export interface AgentProfilePromptOverride {
  readonly disableSections?: readonly string[];
  readonly enableSections?: readonly string[];
}

/** Raw legacy SQLite row shape retained for the Desktop IPC adapter. */
export interface AgentProfileRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly allowed_tools: string | null;
  readonly disallowed_tools: string | null;
  readonly prompt_system: string | null;
  readonly prompt_profile: string | null;
  readonly default_model: string | null;
  readonly profile_kind: string | null;
  readonly user_visible: number | null;
  readonly is_preset: number | null;
  readonly is_enabled: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface AgentProfileCreateInput {
  readonly id?: string;
  readonly name?: string | null;
  readonly description?: string | null;
  readonly allowed_tools?: readonly string[] | null;
  readonly disallowed_tools?: readonly string[] | null;
  readonly prompt_system?: string | null;
  readonly prompt_profile?: AgentProfilePromptOverride | null;
  readonly default_model?: string | null;
  readonly profile_kind?: string | null;
  readonly user_visible?: boolean | null;
  readonly is_preset?: boolean | null;
  readonly is_enabled?: boolean | null;
}

/** Fields that the existing update handler allows to change. */
export interface AgentProfileUpdateInput {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly allowed_tools?: readonly string[] | null;
  readonly disallowed_tools?: readonly string[] | null;
  readonly prompt_system?: string | null;
  readonly prompt_profile?: AgentProfilePromptOverride | null;
  readonly default_model?: string | null;
  readonly profile_kind?: string | null;
  readonly is_enabled?: boolean | null;
}

/** Local-only Agent profile persistence. */
export interface HostLocalAgentProfileApiV1 {
  listAgentProfiles(): Promise<readonly AgentProfileRow[]>;
  getAgentProfile(id: string): Promise<AgentProfileRow | null>;
  createAgentProfile(input: AgentProfileCreateInput): Promise<AgentProfileRow | null>;
  updateAgentProfile(id: string, input: AgentProfileUpdateInput): Promise<AgentProfileRow | null>;
  deleteAgentProfile(id: string): Promise<boolean>;
}
