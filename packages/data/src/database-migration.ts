import * as fs from 'node:fs';
import * as path from 'node:path';

interface MigrationManifest {
  readonly version: 1;
  readonly state: 'pending' | 'complete';
  readonly previousMainPath: string;
  readonly currentMainPath: string;
  readonly copied: readonly string[];
}

interface DatabaseBundle {
  readonly sourceCandidates: readonly string[];
  readonly destinationPath: string;
}

const DATABASE_SUFFIXES = ['', '-wal', '-shm'] as const;
const MANIFEST_NAME = 'previous-electron-database-migration.json';

/**
 * Copy the old Electron-default database set before opening any destination.
 *
 * The source files are retained as recoverable backups. A manifest makes a
 * completed copy idempotent across later starts. If a target already exists
 * without a matching completed migration, this fails closed instead of
 * silently opening a newly-created empty database while the old data remains
 * elsewhere.
 */
export function migratePreviousDefaultDatabases(
  previousMainPath: string,
  currentMainPath: string,
): { copied: string[] } {
  const previousMain = path.resolve(previousMainPath);
  const currentMain = path.resolve(currentMainPath);
  if (samePath(previousMain, currentMain)) return { copied: [] };

  const currentDir = path.dirname(currentMain);
  const previousDir = path.dirname(previousMain);
  fs.mkdirSync(currentDir, { recursive: true });

  const manifestPath = path.join(currentDir, MANIFEST_NAME);
  const existingManifest = readManifest(manifestPath);
  if (existingManifest) {
    if (!samePath(existingManifest.previousMainPath, previousMain) ||
        !samePath(existingManifest.currentMainPath, currentMain)) {
      throw new Error(`Previous database migration manifest does not match ${currentMain}`);
    }
    if (existingManifest.state === 'complete') {
      const missing = existingManifest.copied.filter((destination) => !fs.existsSync(destination));
      if (missing.length > 0) {
        throw new Error(
          `Previously migrated database files are missing from ${currentMain}: ${missing.join(', ')}`,
        );
      }
      return { copied: [] };
    }
  } else if (fs.existsSync(manifestPath)) {
    throw new Error(`Previous database migration manifest is invalid: ${manifestPath}`);
  }

  const bundles: readonly DatabaseBundle[] = [
    {
      sourceCandidates: [previousMain, path.join(previousDir, 'duya.db')],
      destinationPath: currentMain,
    },
    {
      sourceCandidates: [path.join(previousDir, 'duya-core.db')],
      destinationPath: path.join(currentDir, 'duya-core.db'),
    },
    {
      sourceCandidates: [path.join(previousDir, 'memory-state.db')],
      destinationPath: path.join(currentDir, 'memory-state.db'),
    },
  ];

  const sources = bundles.flatMap((bundle) => {
    const sourcePath = bundle.sourceCandidates.find((candidate) => fs.existsSync(candidate));
    return sourcePath ? [{ ...bundle, sourcePath }] : [];
  });
  if (sources.length === 0) {
    if (existingManifest?.state === 'pending') {
      throw new Error(`Previous database migration cannot resume because its source files are missing: ${previousMain}`);
    }
    return { copied: [] };
  }

  if (!existingManifest) {
    const conflicts = bundles.flatMap(({ destinationPath }) =>
      DATABASE_SUFFIXES
        .map((suffix) => `${destinationPath}${suffix}`)
        .filter((destination) => fs.existsSync(destination)),
    );
    if (conflicts.length > 0) {
      throw new Error(
        `Previous database data exists at ${previousMain}, but destination files already exist ` +
        `without a completed migration manifest: ${conflicts.join(', ')}`,
      );
    }
  } else {
    // A prior attempt stopped after publishing one or more staged bundles.
    // Host startup always retries this migration before opening SQLite, so it
    // is safe to remove only the known target files and re-copy from the
    // retained source set.
    for (const bundle of bundles) removeBundleFiles(bundle.destinationPath);
  }

  writeManifest(manifestPath, {
    version: 1,
    state: 'pending',
    previousMainPath: previousMain,
    currentMainPath: currentMain,
    copied: sources.map(({ destinationPath }) => destinationPath),
  });

  try {
    for (const { sourcePath, destinationPath } of sources) {
      const files = DATABASE_SUFFIXES
        .map((suffix) => ({
          suffix,
          source: `${sourcePath}${suffix}`,
          destination: `${destinationPath}${suffix}`,
        }))
        .filter(({ source }) => fs.existsSync(source));
      for (const { source, destination } of files) {
        fs.copyFileSync(source, `${destination}.migrating`);
      }

      // Publish journals before the main file, so a partial copy cannot make
      // a database appear complete. A pending manifest makes interrupted
      // publication safe to retry on the next startup.
      for (const { suffix, destination } of files) {
        if (suffix === '') continue;
        fs.renameSync(`${destination}.migrating`, destination);
      }
      const main = files.find(({ suffix }) => suffix === '');
      if (!main) throw new Error(`Database source has no main file: ${sourcePath}`);
      fs.renameSync(`${main.destination}.migrating`, main.destination);
    }

    const copied = sources.map(({ destinationPath }) => destinationPath);
    writeManifest(manifestPath, {
      version: 1,
      state: 'complete',
      previousMainPath: previousMain,
      currentMainPath: currentMain,
      copied,
    });
    return { copied };
  } catch (error) {
    for (const { destinationPath } of bundles) {
      for (const suffix of DATABASE_SUFFIXES) {
        const staged = `${destinationPath}${suffix}.migrating`;
        if (fs.existsSync(staged)) fs.unlinkSync(staged);
      }
    }
    throw error;
  }
}

function readManifest(filePath: string): MigrationManifest | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<MigrationManifest>;
    if (
      candidate.version !== 1 ||
      (candidate.state !== 'pending' && candidate.state !== 'complete') ||
      typeof candidate.previousMainPath !== 'string' ||
      typeof candidate.currentMainPath !== 'string' ||
      !Array.isArray(candidate.copied) ||
      !candidate.copied.every((entry) => typeof entry === 'string')
    ) {
      return null;
    }
    return candidate as MigrationManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function writeManifest(filePath: string, manifest: MigrationManifest): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function removeBundleFiles(databasePath: string): void {
  for (const suffix of DATABASE_SUFFIXES) {
    const filePath = `${databasePath}${suffix}`;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const stagedPath = `${filePath}.migrating`;
    if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
