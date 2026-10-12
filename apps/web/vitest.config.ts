import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
    // Many files run at once on a few cores and several of them cold-import the whole action graph
    // (auth, argon2, swagger-parser) in a hook. Measured: that import takes 2.5 s alone and 8 s on a
    // starved CPU, which blew the 10 s default. These limits only bound a hang; the tests that care
    // about speed assert their own, much tighter, bounds.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: path.resolve(__dirname, 'src') + '/' },
      // `server-only` throws unless bundled with the react-server condition; Vitest runs plain Node.
      { find: /^server-only$/, replacement: path.resolve(__dirname, 'src/test/server-only-stub.ts') },
    ],
  },
})
