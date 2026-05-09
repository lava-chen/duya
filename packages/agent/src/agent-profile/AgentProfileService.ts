/**
 * AgentProfileService - CRUD operations and preset initialization
 * Manages agent profile persistence and tool resolution
 */

import type {
  AgentProfile,
  AgentProfileDbRow,
} from './types.js';
import {
  PRESET_AGENT_PROFILES,
} from './types.js';
export { PRESET_AGENT_PROFILES };

// ============================================================
// Serialization Helpers
// ============================================================

function parseJson<T>(value: string | null, defaultValue: T): T {
  if (!value) return defaultValue;
  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

function rowToAgentProfile(row: AgentProfileDbRow): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    allowedTools: parseJson<string[] | undefined>(row.allowed_tools, undefined),
    disallowedTools: parseJson<string[] | undefined>(row.disallowed_tools, undefined),
    defaultModel: row.default_model ?? undefined,
    userVisible: row.user_visible === 1,
    isPreset: row.is_preset === 1,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function profileToRow(profile: AgentProfile): Omit<AgentProfileDbRow, 'created_at' | 'updated_at'> {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description ?? null,
    allowed_tools: profile.allowedTools ? JSON.stringify(profile.allowedTools) : null,
    disallowed_tools: profile.disallowedTools ? JSON.stringify(profile.disallowedTools) : null,
    default_model: profile.defaultModel ?? null,
    user_visible: profile.userVisible ? 1 : 0,
    is_preset: profile.isPreset ? 1 : 0,
    is_enabled: profile.isEnabled ? 1 : 0,
  };
}

// ============================================================
// Service Interface
// ============================================================

export interface AgentProfileService {
  create(profile: Omit<AgentProfile, 'createdAt' | 'updatedAt'>): AgentProfile;
  get(id: string): AgentProfile | undefined;
  list(): AgentProfile[];
  listEnabled(): AgentProfile[];
  listUserVisible(): AgentProfile[];
  update(id: string, patch: Partial<AgentProfile>): AgentProfile | undefined;
  delete(id: string): boolean;
}

// ============================================================
// In-Memory Implementation (for agent process usage)
// ============================================================

export class InMemoryAgentProfileService implements AgentProfileService {
  private profiles: Map<string, AgentProfile> = new Map();
  private initialized = false;

  constructor() {
    this.initPresets();
  }

  private initPresets(): void {
    if (this.initialized) return;

    const now = Date.now();
    for (const profile of PRESET_AGENT_PROFILES) {
      this.profiles.set(profile.id, {
        ...profile,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.initialized = true;
  }

  create(profile: Omit<AgentProfile, 'createdAt' | 'updatedAt'>): AgentProfile {
    if (this.profiles.has(profile.id)) {
      throw new Error(`AgentProfile with id "${profile.id}" already exists`);
    }

    const now = Date.now();
    const newProfile: AgentProfile = {
      ...profile,
      createdAt: now,
      updatedAt: now,
    };

    this.profiles.set(newProfile.id, newProfile);
    return newProfile;
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values()).sort((a, b) => {
      if (a.isPreset !== b.isPreset) return a.isPreset ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  listEnabled(): AgentProfile[] {
    return this.list().filter(p => p.isEnabled);
  }

  listUserVisible(): AgentProfile[] {
    return this.listEnabled().filter(p => p.userVisible);
  }

  update(id: string, patch: Partial<AgentProfile>): AgentProfile | undefined {
    const existing = this.profiles.get(id);
    if (!existing) return undefined;

    if (existing.isPreset) {
      const allowedFields: (keyof AgentProfile)[] = ['isEnabled', 'defaultModel'];
      for (const key of Object.keys(patch) as (keyof AgentProfile)[]) {
        if (!allowedFields.includes(key)) {
          throw new Error(`Cannot modify preset profile field: ${key}`);
        }
      }
    }

    const updated: AgentProfile = {
      ...existing,
      ...patch,
      id: existing.id,
      isPreset: existing.isPreset,
      updatedAt: Date.now(),
    };

    this.profiles.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.profiles.get(id);
    if (!existing) return false;
    if (existing.isPreset) {
      throw new Error('Cannot delete preset profiles');
    }
    return this.profiles.delete(id);
  }

  /**
   * Initialize from database rows (called when loading from SQLite)
   */
  loadFromRows(rows: AgentProfileDbRow[]): void {
    for (const [id, profile] of this.profiles) {
      if (!profile.isPreset) {
        this.profiles.delete(id);
      }
    }

    for (const row of rows) {
      const profile = rowToAgentProfile(row);
      if (!profile.isPreset) {
        this.profiles.set(profile.id, profile);
      }
    }
  }

  /**
   * Export all non-preset profiles as DB rows
   */
  exportToRows(): AgentProfileDbRow[] {
    const rows: AgentProfileDbRow[] = [];
    for (const profile of this.profiles.values()) {
      if (!profile.isPreset) {
        const base = profileToRow(profile);
        rows.push({
          ...base,
          created_at: profile.createdAt,
          updated_at: profile.updatedAt,
        });
      }
    }
    return rows;
  }
}

// ============================================================
// Singleton
// ============================================================

let defaultService: AgentProfileService | null = null;

export function getAgentProfileService(): AgentProfileService {
  if (!defaultService) {
    defaultService = new InMemoryAgentProfileService();
  }
  return defaultService;
}

export function resetAgentProfileService(): void {
  defaultService = null;
}

export function setAgentProfileService(service: AgentProfileService): void {
  defaultService = service;
}

export { rowToAgentProfile, profileToRow, parseJson };
