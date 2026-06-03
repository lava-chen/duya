import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

beforeAll(() => {
  // Increase timeout for CI
});

afterAll(() => {
  // Cleanup any open handles
});

beforeEach(() => {
  vi.clearAllMocks();
});
