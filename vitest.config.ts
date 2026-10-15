import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Session 1 ships no code to test yet. Remove this in Session 2.
    passWithNoTests: true,
  },
});
