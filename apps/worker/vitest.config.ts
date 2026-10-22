import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // tsc compiles the tests into dist; without this each test would run twice after a build.
    include: ['src/**/*.test.ts'],
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
