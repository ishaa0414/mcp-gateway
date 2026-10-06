import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: path.resolve(__dirname, 'src') + '/' },
      // `server-only` throws unless bundled with the react-server condition; Vitest runs plain Node.
      { find: /^server-only$/, replacement: path.resolve(__dirname, 'src/test/server-only-stub.ts') },
    ],
  },
})
