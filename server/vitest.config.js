import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    setupFiles: ['./test/setupEnv.js'],
    hookTimeout: 20000,
    testTimeout: 20000,
    // At most 2 test files at once, each worker's heap capped: several chats run suites at the
    // same time on a 4-core, 16 GB host, and one worker per core filled it (see Tests in CLAUDE.md).
    maxWorkers: 2,
    execArgv: ['--max-old-space-size=2048'],
  },
});
