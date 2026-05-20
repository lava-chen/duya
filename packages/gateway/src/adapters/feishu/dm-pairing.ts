/**
 * Feishu DM Pairing
 *
 * Handles DM (direct message) gating with pairing mode support.
 * Manages pairing code generation, approval, and user verification.
 */

import { randomBytes } from 'crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PendingPairing {
  code: string;
  platform: string;
  platformUserId: string;
  platformChatId: string;
  userName: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApprovedUser {
  platform: string;
  platformUserId: string;
  userName: string;
  approvedAt: number;
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

export interface DmPairingConfig {
  /** Base URL for Feishu API */
  baseUrl: string;
  /** App ID */
  appId: string;
  /** App Secret */
  appSecret: string;
  /** Domain (feishu or lark) */
  domain: string;
  /** Callback when a new pairing request needs approval */
  onPairingRequest?: (pairing: PendingPairing) => void;
  /** Callback when a user is approved */
  onUserApproved?: (user: ApprovedUser) => void;
}

export class DmPairingHandler {
  private config: DmPairingConfig;
  private pending: Map<string, PendingPairing> = new Map();
  private approved: Map<string, ApprovedUser> = new Map();

  constructor(config: DmPairingConfig) {
    this.config = config;
  }

  /** Update configuration */
  configure(config: Partial<DmPairingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Check if a user is approved for DM access */
  isApproved(platformUserId: string): boolean {
    const key = `${this.config.appId}:${platformUserId}`;
    const user = this.approved.get(key);
    return user !== undefined;
  }

  /** Approve a user by pairing code */
  approveByCode(code: string): ApprovedUser | null {
    const upperCode = code.toUpperCase();

    for (const [key, pairing] of this.pending.entries()) {
      if (pairing.code === upperCode && Date.now() < pairing.expiresAt) {
        const approved: ApprovedUser = {
          platform: 'feishu',
          platformUserId: pairing.platformUserId,
          userName: pairing.userName,
          approvedAt: Date.now(),
        };
        this.approved.set(key, approved);
        this.pending.delete(key);

        if (this.config.onUserApproved) {
          this.config.onUserApproved(approved);
        }

        return approved;
      }
    }
    return null;
  }

  /** Approve a user directly by user ID */
  approveByUserId(platformUserId: string, userName?: string): ApprovedUser | null {
    const key = `${this.config.appId}:${platformUserId}`;
    const existing = this.approved.get(key);
    if (existing) return existing;

    const approved: ApprovedUser = {
      platform: 'feishu',
      platformUserId,
      userName: userName ?? platformUserId,
      approvedAt: Date.now(),
    };
    this.approved.set(key, approved);

    if (this.config.onUserApproved) {
      this.config.onUserApproved(approved);
    }

    return approved;
  }

  /** Revoke a user's approval */
  revoke(platformUserId: string): boolean {
    const key = `${this.config.appId}:${platformUserId}`;
    return this.approved.delete(key);
  }

  /** Get all pending pairing requests */
  getPending(): PendingPairing[] {
    const now = Date.now();
    const result: PendingPairing[] = [];

    for (const pairing of this.pending.values()) {
      if (now < pairing.expiresAt) {
        result.push(pairing);
      } else {
        // Clean up expired
        const key = `${this.config.appId}:${pairing.platformUserId}`;
        this.pending.delete(key);
      }
    }

    return result;
  }

  /** Get all approved users */
  getApproved(): ApprovedUser[] {
    return Array.from(this.approved.values());
  }

  /** Generate a pairing code for a user */
  generateCode(
    platformUserId: string,
    platformChatId: string,
    userName: string
  ): { code: string; error?: string } {
    const key = `${this.config.appId}:${platformUserId}`;

    // Check if already approved
    if (this.approved.has(key)) {
      return { code: '', error: 'already_approved' };
    }

    // Check if there's a recent pending code
    const existing = this.pending.get(key);
    if (existing && Date.now() < existing.expiresAt) {
      return { code: existing.code };
    }

    // Generate new code
    const code = generateCode();
    const pairing: PendingPairing = {
      code,
      platform: 'feishu',
      platformUserId,
      platformChatId,
      userName,
      createdAt: Date.now(),
      expiresAt: Date.now() + CODE_TTL_MS,
    };

    this.pending.set(key, pairing);

    if (this.config.onPairingRequest) {
      this.config.onPairingRequest(pairing);
    }

    return { code };
  }

  /** Handle incoming DM - returns whether user is allowed */
  checkDmAccess(
    platformUserId: string,
    platformChatId: string,
    userName: string,
    dmPolicy: 'open' | 'allowlist' | 'pairing' | 'disabled',
    allowFrom?: string[]
  ): { allowed: boolean; reason?: string; pairingCode?: string } {
    // Disabled - no DMs allowed
    if (dmPolicy === 'disabled') {
      return { allowed: false, reason: 'DM disabled' };
    }

    // Open - everyone allowed
    if (dmPolicy === 'open') {
      return { allowed: true };
    }

    // Allowlist - check against specific users
    if (dmPolicy === 'allowlist') {
      if (allowFrom?.includes(platformUserId)) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'User not in allowlist' };
    }

    // Pairing - check if approved, or generate code
    if (dmPolicy === 'pairing') {
      const key = `${this.config.appId}:${platformUserId}`;

      // Already approved
      if (this.approved.has(key)) {
        return { allowed: true };
      }

      // Generate or return existing code
      const result = this.generateCode(platformUserId, platformChatId, userName);
      if (result.error === 'already_approved') {
        return { allowed: true };
      }

      return {
        allowed: false,
        reason: 'Pairing required',
        pairingCode: result.code,
      };
    }

    return { allowed: false, reason: 'Unknown policy' };
  }
}
