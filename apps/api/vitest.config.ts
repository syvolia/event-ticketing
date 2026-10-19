// Vitest config. Single fork so all test files share one Node process and one
// pg pool; DB tests cannot run in parallel against the same database without
// cross-file truncation races. Fast enough, and the semantics are obvious.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});