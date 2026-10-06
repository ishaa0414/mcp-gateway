import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
    // Integration tests share one Postgres and one Redis; each file uses its own projects and keys.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
