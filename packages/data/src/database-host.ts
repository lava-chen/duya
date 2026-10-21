import { CoreDataHost, type CoreDataHostOptions } from './core-data-host.js';
import { MainDatabase, type MainDatabaseOptions } from './main-database.js';
import { DatabaseOwnerLock } from './database-owner-lock.js';

/**
 * Owns the application's SQLite database lifetimes for one process.
 * Path policy and platform-specific startup work stay with the composition
 * root; opening, checkpointing, and closing the handles stay here.
 */
export class DatabaseHost {
  private main: MainDatabase | null = null;
  private core: CoreDataHost | null = null;
  private mainOwnerLock: DatabaseOwnerLock | null = null;
  private coreOwnerLock: DatabaseOwnerLock | null = null;

  openMainDatabase(options: MainDatabaseOptions): MainDatabase {
    if (this.main) return this.main;
    const ownerLock = DatabaseOwnerLock.acquire(options.filename);
    try {
      this.main = new MainDatabase(options);
      this.mainOwnerLock = ownerLock;
      return this.main;
    } catch (error) {
      ownerLock?.release();
      throw error;
    }
  }

  openCoreDatabase(options: CoreDataHostOptions): CoreDataHost {
    if (this.core) return this.core;
    const ownerLock = DatabaseOwnerLock.acquire(options.filename);
    try {
      this.core = new CoreDataHost(options);
      this.coreOwnerLock = ownerLock;
      return this.core;
    } catch (error) {
      ownerLock?.release();
      throw error;
    }
  }

  getMainDatabase(): MainDatabase | null {
    return this.main;
  }

  getCoreDataHost(): CoreDataHost | null {
    return this.core;
  }

  stopMainWalCheckpoint(): void {
    this.main?.stopWalCheckpoint();
  }

  closeCoreDatabase(): void {
    const core = this.core;
    this.core = null;
    try {
      core?.close();
    } finally {
      const ownerLock = this.coreOwnerLock;
      this.coreOwnerLock = null;
      ownerLock?.release();
    }
  }

  closeMainDatabase(): void {
    const main = this.main;
    this.main = null;
    try {
      main?.close();
    } finally {
      const ownerLock = this.mainOwnerLock;
      this.mainOwnerLock = null;
      ownerLock?.release();
    }
  }

  close(): void {
    try {
      this.closeCoreDatabase();
    } finally {
      this.closeMainDatabase();
    }
  }
}
