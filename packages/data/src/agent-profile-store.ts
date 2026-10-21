import { randomUUID } from 'node:crypto';
import type {
  AgentProfileCreateInput,
  AgentProfileRow,
  AgentProfileUpdateInput,
} from '@duya/agent-protocol/agent-profiles';
import type { SqliteDatabase } from './sqlite-connection.js';

/** Data-owned SQLite access for persisted Agent profiles. */
export class AgentProfileStore {
  constructor(private readonly db: SqliteDatabase) {}

  list(): AgentProfileRow[] {
    return this.db
      .prepare('SELECT * FROM agent_profiles ORDER BY is_preset DESC, name ASC')
      .all() as AgentProfileRow[];
  }

  get(id: string): AgentProfileRow | null {
    return (this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as AgentProfileRow | undefined) ?? null;
  }

  create(input: AgentProfileCreateInput, now = Date.now()): AgentProfileRow | null {
    const id = input.id || randomUUID();
    this.db.prepare(`
      INSERT INTO agent_profiles (
        id, name, description, allowed_tools, disallowed_tools, prompt_system, prompt_profile, default_model,
        profile_kind, user_visible, is_preset, is_enabled, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @allowed_tools, @disallowed_tools, @prompt_system, @prompt_profile, @default_model,
        @profile_kind, @user_visible, @is_preset, @is_enabled, @created_at, @updated_at
      )
    `).run({
      id,
      name: input.name || 'New Agent',
      description: input.description ?? null,
      allowed_tools: input.allowed_tools ? JSON.stringify(input.allowed_tools) : null,
      disallowed_tools: input.disallowed_tools ? JSON.stringify(input.disallowed_tools) : null,
      prompt_system: input.prompt_system ?? null,
      prompt_profile: input.prompt_profile ? JSON.stringify(input.prompt_profile) : null,
      default_model: input.default_model ?? null,
      profile_kind: input.profile_kind ?? 'main',
      user_visible: input.user_visible !== undefined ? (input.user_visible ? 1 : 0) : 1,
      is_preset: input.is_preset !== undefined ? (input.is_preset ? 1 : 0) : 0,
      is_enabled: input.is_enabled !== undefined ? (input.is_enabled ? 1 : 0) : 1,
      created_at: now,
      updated_at: now,
    });
    return this.get(id);
  }

  update(id: string, input: AgentProfileUpdateInput, now = Date.now()): AgentProfileRow | null {
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: now };
    const fieldMap: Record<string, [string, (value: unknown) => unknown]> = {
      name: ['name', (value) => value],
      description: ['description', (value) => value ?? null],
      allowed_tools: ['allowed_tools', (value) => value ? JSON.stringify(value) : null],
      disallowed_tools: ['disallowed_tools', (value) => value ? JSON.stringify(value) : null],
      prompt_system: ['prompt_system', (value) => value ?? null],
      prompt_profile: ['prompt_profile', (value) => value ? JSON.stringify(value) : null],
      default_model: ['default_model', (value) => value ?? null],
      profile_kind: ['profile_kind', (value) => value ?? 'main'],
      is_enabled: ['is_enabled', (value) => value !== undefined ? (value ? 1 : 0) : 1],
    };

    for (const [key, [column, transform]] of Object.entries(fieldMap)) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined) continue;
      fields.push(`${column} = @${column}`);
      params[column] = transform(value);
    }

    this.db.prepare(`UPDATE agent_profiles SET ${fields.join(', ')} WHERE id = @id`).run(params);
    return this.get(id);
  }

  delete(id: string): boolean {
    const profile = this.db
      .prepare('SELECT is_preset FROM agent_profiles WHERE id = ?')
      .get(id) as { is_preset: number } | undefined;
    if (!profile) return false;
    if (profile.is_preset === 1) throw new Error('Cannot delete preset agent profiles');
    return Number(this.db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id).changes) > 0;
  }
}
