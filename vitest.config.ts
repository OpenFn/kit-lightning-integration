import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    globalSetup: './src/globalSetup.ts',
    // The stack + worker round-trip is not instant; give runs room.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Contract tests share one Lightning instance — keep them serial and
    // predictable rather than racing for the same work orders.
    fileParallelism: false,
  },
});
