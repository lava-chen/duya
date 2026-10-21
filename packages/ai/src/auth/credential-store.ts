import type { Credential, CredentialStore } from './types.js';

/** In-memory credential store. Not persisted across restarts. */
export class InMemoryCredentialStore implements CredentialStore {
  private map = new Map<string, Credential>();

  async get(providerId: string): Promise<Credential | undefined> {
    return this.map.get(providerId);
  }

  async set(credential: Credential): Promise<void> {
    this.map.set(credential.providerId, credential);
  }

  async delete(providerId: string): Promise<void> {
    this.map.delete(providerId);
  }

  async list(): Promise<Credential[]> {
    return Array.from(this.map.values());
  }
}