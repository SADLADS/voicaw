import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://localhost:3002/api/'),
    'import.meta.env.VITE_WS_URL': JSON.stringify('ws://localhost:3002/'),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['./src/test/setupTests.js'],
    testTimeout: 10000,
    // At most 2 test files at once, each worker's heap capped: several chats run suites at the
    // same time on a 4-core, 16 GB host, and one worker per core filled it (see Tests in CLAUDE.md).
    maxWorkers: 2,
    execArgv: ['--max-old-space-size=2048'],
  },
});
