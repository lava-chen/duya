export interface MemoryToolFilePort {
  ensureDirectory(directoryPath: string): void | Promise<void>;
  readTextFileIfExists(filePath: string): string | undefined | Promise<string | undefined>;
  writeTextFile(filePath: string, content: string): void | Promise<void>;
}
