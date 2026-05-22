/**
 * PairingStore - Multi-platform user pairing/approval system
 *
 * Manages pairing codes for user verification. Platforms can require users to
 * request a pairing code which is then approved via an external mechanism.
 *
 * Security features:
 * - 8-character pairing codes with 32-character non-confusing alphabet
 * - Cryptographically random code generation
 * - 1-hour code expiration
 * - Rate limiting (1 request per user per 10 minutes)
 * - Global lockout after 5 failed verification attempts
 * - Atomic file writes (temp file + rename)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface PairingSession {
  code: string;
  openId: string;
  chatId: string;
  platform: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  approved: boolean;
}

interface PairingState {
  sessions: Record<string, PairingSession>;
  lockedUntil: number;
  globalFailCount: number;
  userRequestTimes: Record<string, number[]>;
}

// Config
const PAIRING_CODE_LENGTH = 8;
const SESSION_EXPIRE_MS = 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 3;
const MAX_REQUESTS_PER_USER_PER_10MIN = 1;
const MAX_GLOBAL_FAIL_COUNT = 5;
const GLOBAL_LOCKOUT_MS = 60 * 60 * 1000;
const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_STATE_FILE = 'pairing_state.json';

let _pairingState: PairingState = {
  sessions: {},
  lockedUntil: 0,
  globalFailCount: 0,
  userRequestTimes: {},
};

let _initialized = false;

function getStateDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || '/tmp';
  const dir = path.join(home, '.duya', 'gateway');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadPairingState(): void {
  try {
    const filePath = path.join(getStateDir(), PAIRING_STATE_FILE);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const loaded = JSON.parse(raw) as PairingState;
      if (loaded.sessions && typeof loaded.lockedUntil === 'number' && typeof loaded.globalFailCount === 'number') {
        const now = Date.now();
        const cleanedSessions: Record<string, PairingSession> = {};
        for (const [key, session] of Object.entries(loaded.sessions)) {
          if (session.expiresAt > now) {
            cleanedSessions[key] = session;
          }
        }
        loaded.sessions = cleanedSessions;
        loaded.userRequestTimes = loaded.userRequestTimes || {};
        _pairingState = loaded;
      }
    }
  } catch {
    _pairingState = { sessions: {}, lockedUntil: 0, globalFailCount: 0, userRequestTimes: {} };
  }
}

function savePairingState(): void {
  try {
    const filePath = path.join(getStateDir(), PAIRING_STATE_FILE);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(_pairingState, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {}
}

export function initPairingStore(): void {
  if (_initialized) return;
  loadPairingState();
  _initialized = true;
}

export function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

export function checkGlobalLockout(): { locked: boolean; remainingMs: number } {
  const now = Date.now();
  if (_pairingState.lockedUntil > now) {
    return { locked: true, remainingMs: _pairingState.lockedUntil - now };
  }
  return { locked: false, remainingMs: 0 };
}

export function checkUserRateLimit(platform: string, userId: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const key = `${platform}:${userId}`;
  const times = _pairingState.userRequestTimes[key] || [];
  const recent = times.filter(t => now - t < REQUEST_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_USER_PER_10MIN) {
    const oldestAllowed = recent[0] + REQUEST_WINDOW_MS;
    const retryAfter = Math.max(0, oldestAllowed - now);
    return { allowed: false, retryAfterMs: retryAfter };
  }
  return { allowed: true, retryAfterMs: 0 };
}

function recordUserRequest(platform: string, userId: string): void {
  const now = Date.now();
  const key = `${platform}:${userId}`;
  if (!_pairingState.userRequestTimes[key]) {
    _pairingState.userRequestTimes[key] = [];
  }
  _pairingState.userRequestTimes[key] = _pairingState.userRequestTimes[key].filter(
    t => now - t < REQUEST_WINDOW_MS
  );
  _pairingState.userRequestTimes[key].push(now);
  savePairingState();
}

/**
 * Create a new pairing session for a user
 */
export function createPairingSession(
  platform: string,
  userId: string,
  chatId: string
): { code: string; session: PairingSession } | { error: string } {
  loadPairingState();

  const lockCheck = checkGlobalLockout();
  if (lockCheck.locked) {
    const remainingMin = Math.ceil(lockCheck.remainingMs / 60000);
    return { error: `Pairing is temporarily locked due to too many failed attempts. Try again in ${remainingMin} minute(s).` };
  }

  const rateCheck = checkUserRateLimit(platform, userId);
  if (!rateCheck.allowed) {
    const remainingSec = Math.ceil(rateCheck.retryAfterMs / 1000);
    return { error: `Too many pairing requests. Please wait ${remainingSec} second(s) before trying again.` };
  }

  const now = Date.now();
  const activeCount = Object.values(_pairingState.sessions).filter(
    s => s.expiresAt > now && !s.approved
  ).length;
  if (activeCount >= MAX_ACTIVE_SESSIONS) {
    return { error: 'Too many pending pairing requests. Please wait for existing requests to be processed or expire.' };
  }

  const code = generatePairingCode();
  const session: PairingSession = {
    code,
    openId: userId,
    chatId,
    platform,
    createdAt: now,
    expiresAt: now + SESSION_EXPIRE_MS,
    attempts: 0,
    approved: false,
  };

  _pairingState.sessions[code] = session;
  recordUserRequest(platform, userId);
  savePairingState();

  return { code, session };
}

/**
 * Approve a pairing code (case-insensitive, strips whitespace)
 */
export function approvePairingCode(inputCode: string): { success: boolean; session?: PairingSession; error?: string } {
  loadPairingState();

  const normalizedCode = inputCode.toUpperCase().replace(/\s/g, '');
  const now = Date.now();

  const session = _pairingState.sessions[normalizedCode];
  if (!session) {
    _pairingState.globalFailCount++;
    if (_pairingState.globalFailCount >= MAX_GLOBAL_FAIL_COUNT) {
      _pairingState.lockedUntil = now + GLOBAL_LOCKOUT_MS;
      savePairingState();
      return { success: false, error: 'Invalid pairing code. Pairing is now locked for 1 hour due to too many failed attempts.' };
    }
    savePairingState();
    return { success: false, error: `Invalid pairing code. ${MAX_GLOBAL_FAIL_COUNT - _pairingState.globalFailCount} attempt(s) remaining before lockout.` };
  }

  if (session.expiresAt < now) {
    delete _pairingState.sessions[normalizedCode];
    _pairingState.globalFailCount++;
    savePairingState();
    return { success: false, error: 'This pairing code has expired.' };
  }

  session.attempts++;
  if (session.approved) {
    return { success: true, session };
  }

  session.approved = true;
  _pairingState.globalFailCount = 0;
  savePairingState();

  return { success: true, session };
}

export function rejectPairingCode(inputCode: string): { success: boolean; error?: string } {
  loadPairingState();
  const normalizedCode = inputCode.toUpperCase().replace(/\s/g, '');
  const session = _pairingState.sessions[normalizedCode];
  if (!session) return { success: false, error: 'Pairing code not found.' };
  delete _pairingState.sessions[normalizedCode];
  savePairingState();
  return { success: true };
}

/**
 * Get all pending (non-approved, non-expired) pairing sessions
 */
export function getPendingPairingSessions(platform?: string): PairingSession[] {
  loadPairingState();
  const now = Date.now();
  return Object.values(_pairingState.sessions)
    .filter(s => s.expiresAt > now && !s.approved && (!platform || s.platform === platform))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Get all approved pairing sessions
 */
export function getApprovedPairingSessions(platform?: string): PairingSession[] {
  loadPairingState();
  const now = Date.now();
  return Object.values(_pairingState.sessions)
    .filter(s => s.approved && (!platform || s.platform === platform))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function revokePairingSession(code: string): void {
  loadPairingState();
  const normalizedCode = code.toUpperCase().replace(/\s/g, '');
  delete _pairingState.sessions[normalizedCode];
  savePairingState();
}

export function revokeUserPairing(platform: string, userId: string): boolean {
  loadPairingState();
  let found = false;
  for (const [code, session] of Object.entries(_pairingState.sessions)) {
    if (session.platform === platform && session.openId === userId) {
      delete _pairingState.sessions[code];
      found = true;
    }
  }
  if (found) savePairingState();
  return found;
}

/**
 * Verify if a user is approved for a platform+chat
 */
export function verifyPairingApproval(platform: string, userId: string, chatId: string): boolean {
  loadPairingState();
  const now = Date.now();
  return Object.values(_pairingState.sessions).some(
    s => s.platform === platform && s.openId === userId && s.chatId === chatId && s.approved && s.expiresAt > now
  );
}

/**
 * Clear all pending pairing sessions
 */
export function clearPendingSessions(platform?: string): number {
  loadPairingState();
  const now = Date.now();
  let count = 0;
  for (const [code, session] of Object.entries(_pairingState.sessions)) {
    if (!session.approved && session.expiresAt > now && (!platform || session.platform === platform)) {
      delete _pairingState.sessions[code];
      count++;
    }
  }
  if (count > 0) savePairingState();
  return count;
}

// Initialize on module load
initPairingStore();
