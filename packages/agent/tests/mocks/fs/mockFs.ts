import { vi } from 'vitest';

export interface MockFs {
  files: Map<string, string>;
  writtenFiles: Map<string, string>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
  reset: () => void;
  addFile: (path: string, content: string) => void;
  removeFile: (path: string) => void;
}

/**
 * Create a mock file system for testing tools
 */
export function createMockFs(files: Record<string, string> = {}): MockFs {
  const mockFiles = new Map<string, string>(Object.entries(files));
  const writtenFiles = new Map<string, string>();

  const mock: MockFs = {
    files: mockFiles,
    writtenFiles,

    readFile: vi.fn(async (path: string) => {
      if (mockFiles.has(path)) {
        return mockFiles.get(path)!;
      }
      const error = new Error(`ENOENT: ${path}`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }),

    writeFile: vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
      mockFiles.set(path, content);
    }),

    stat: vi.fn(async (path: string) => {
      if (mockFiles.has(path)) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: mockFiles.get(path)!.length,
        };
      }
      const error = new Error(`ENOENT: ${path}`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }),

    mkdir: vi.fn(async () => {}),

    access: vi.fn(async (path: string) => {
      if (!mockFiles.has(path)) {
        const error = new Error(`ENOENT: ${path}`);
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      }
    }),

    reset() {
      this.readFile.mockClear();
      this.writeFile.mockClear();
      this.stat.mockClear();
    },

    addFile(path: string, content: string) {
      mockFiles.set(path, content);
    },

    removeFile(path: string) {
      mockFiles.delete(path);
    },
  };

  return mock;
}

/**
 * Create a mock path module
 */
export function createMockPath() {
  return {
    resolve: vi.fn((...args: string[]) => args.join('/')),
    isAbsolute: vi.fn((p: string) => p.startsWith('/')),
    dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
  };
}
