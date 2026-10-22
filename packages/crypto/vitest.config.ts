import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // tsc compiles the tests into dist; without this each test would run twice after a build.
    include: ['src/**/*.test.ts'],
  },
})
