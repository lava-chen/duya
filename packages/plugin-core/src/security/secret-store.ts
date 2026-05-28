export interface SecretEntry {
  key: string;
  value: string;
}

export class PluginSecretStore {
  private secrets: Map<string, SecretEntry[]> = new Map();

  storeSecret(pluginId: string, key: string, value: string): void {
    const pluginSecrets = this.secrets.get(pluginId) ?? [];
    const existing = pluginSecrets.findIndex((s) => s.key === key);

    if (existing >= 0) {
      pluginSecrets[existing] = { key, value };
    } else {
      pluginSecrets.push({ key, value });
    }

    this.secrets.set(pluginId, pluginSecrets);
  }

  getSecret(pluginId: string, key: string): string | undefined {
    const pluginSecrets = this.secrets.get(pluginId);
    if (!pluginSecrets) return undefined;
    const entry = pluginSecrets.find((s) => s.key === key);
    return entry?.value;
  }

  getAllSecrets(pluginId: string): SecretEntry[] {
    return this.secrets.get(pluginId) ?? [];
  }

  removeSecret(pluginId: string, key: string): void {
    const pluginSecrets = this.secrets.get(pluginId);
    if (!pluginSecrets) return;
    this.secrets.set(
      pluginId,
      pluginSecrets.filter((s) => s.key !== key),
    );
  }

  removeAllSecrets(pluginId: string): void {
    this.secrets.delete(pluginId);
  }

  redactValue(value: string): string {
    if (value.length <= 4) return '****';
    return value.substring(0, 2) + '****' + value.substring(value.length - 2);
  }

  toSafeSerializable(pluginId: string): Record<string, string> {
    const pluginSecrets = this.secrets.get(pluginId);
    if (!pluginSecrets) return {};
    const result: Record<string, string> = {};
    for (const s of pluginSecrets) {
      result[s.key] = this.redactValue(s.value);
    }
    return result;
  }
}