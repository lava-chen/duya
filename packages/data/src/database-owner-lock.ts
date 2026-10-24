import { randomUUID, createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

interface OwnerRecord {
  readonly version: 1;
  readonly databasePath: string;
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly startedAt: number;
}

const MAX_ACQUIRE_ATTEMPTS = 3;

/** Prevents two Duya Host compositions from opening the same database file. */
export class DatabaseOwnerLock {
  private released = false;

  private constructor(
    readonly databasePath: string,
    private readonly lockPath: string,
    private readonly token: string,
  ) {}

  static acquire(filename: string): DatabaseOwnerLock | null {
    if (filename === ':memory:') return null;

    const unresolvedPath = path.resolve(filename);
    const directory = path.dirname(unresolvedPath);
    mkdirSync(directory, { recursive: true });
    const realDirectory = bestEffortRealpath(directory);
    const resolvedDatabasePath = existsSync(unresolvedPath)
      ? bestEffortRealpath(unresolvedPath)
      : path.join(realDirectory, path.basename(unresolvedPath));
    const identity = process.platform === 'win32'
      ? resolvedDatabasePath.toLowerCase()
      : resolvedDatabasePath;
    const databasePath = identity;
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    const lockPath = path.join(path.dirname(resolvedDatabasePath), `.duya-db-owner-${hash}.lock`);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const token = randomUUID();
      const record: OwnerRecord = {
        version: 1,
        databasePath,
        pid: process.pid,
        hostname: hostname(),
        token,
        startedAt: Date.now(),
      };

      let descriptor: number;
      try {
        descriptor = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const existing = readOwner(lockPath, databasePath);
        if (existing === null) continue;
        if (existing.hostname !== hostname() || isProcessAlive(existing.pid)) {
          throw new DatabaseOwnerLockError(databasePath, existing);
        }
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (errorCode(unlinkError) !== 'ENOENT') throw unlinkError;
        }
        continue;
      }

      let failed = false;
      let failure: unknown;
      try {
        writeFileSync(descriptor, JSON.stringify(record), 'utf8');
        fsyncSync(descriptor);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        closeSync(descriptor);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
      if (failed) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the write error; the next owner will fail closed on an
          // unreadable or incomplete owner record.
        }
        throw failure;
      }

      return new DatabaseOwnerLock(databasePath, lockPath, token);
    }

    throw new Error(`Could not acquire the database owner lock for ${databasePath}`);
  }

  release(): void {
    if (this.released) return;
    this.released = true;

    const current = readOwner(this.lockPath, this.databasePath);
    if (current?.token !== this.token) return;
    try {
      unlinkSync(this.lockPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}

export class DatabaseOwnerLockError extends Error {
  /** The process that already owns the database. */
  readonly ownerPid: number;
  /** The machine that process runs on. */
  readonly ownerHostname: string;

  constructor(databasePath: string, owner: OwnerRecord) {
    super(
      `Database is already owned by Duya process ${owner.pid} on ${owner.hostname}: ${databasePath}`,
    );
    this.name = 'DatabaseOwnerLockError';
    this.ownerPid = owner.pid;
    this.ownerHostname = owner.hostname;
  }
}

function readOwner(lockPath: string, databasePath: string): OwnerRecord | null {
  let serialized: string;
  try {
    serialized = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(`Could not inspect the database owner lock for ${databasePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Database owner lock is malformed for ${databasePath}`, { cause: error });
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    (parsed as Partial<OwnerRecord>).version !== 1 ||
    (parsed as Partial<OwnerRecord>).databasePath !== databasePath ||
    !Number.isSafeInteger((parsed as Partial<OwnerRecord>).pid) ||
    ((parsed as Partial<OwnerRecord>).pid ?? 0) < 1 ||
    typeof (parsed as Partial<OwnerRecord>).hostname !== 'string' ||
    typeof (parsed as Partial<OwnerRecord>).token !== 'string' ||
    typeof (parsed as Partial<OwnerRecord>).startedAt !== 'number'
  ) {
    throw new Error(`Database owner lock has invalid fields for ${databasePath}`);
  }
  return parsed as OwnerRecord;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function bestEffortRealpath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch (error) {
    // Some restricted runtimes deny native realpath even for a writable
    // workspace directory. Keep the lease usable there; ordinary path policy
    // validation remains the caller's responsibility.
    if (errorCode(error) === 'EPERM') return path.resolve(value);
    throw error;
  }
}
