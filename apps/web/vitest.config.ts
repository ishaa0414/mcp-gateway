import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  // tsconfig keeps JSX for Next to compile; tests that import a page or component need it compiled.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
    // Hooks create the fixtures (3 to 21 inserts in 16 of the files). With the CPU starved each insert took 0.3 to
    // 1 s, and four different files hit the 10 s default. A hook is not what a test measures, and a hung one
    // still fails at 60 s. The test timeout stays at the 5 s default on purpose.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: path.resolve(__dirname, 'src') + '/' },
      // `server-only` throws unless bundled with the react-server condition; Vitest runs plain Node.
      { find: /^server-only$/, replacement: path.resolve(__dirname, 'src/test/server-only-stub.ts') },
    ],
  },
})
