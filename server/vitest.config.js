import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    setupFiles: ['./test/setupEnv.js'],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
