import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The tests use steady-socket from source, so they do not need the package built first.
    alias: { 'steady-socket': fileURLToPath(new URL('../../src/index.ts', import.meta.url)) },
  },
  test: { include: ['test/**/*.test.ts'] },
});
