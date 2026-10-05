import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
    alias: {
      '@/': path.resolve(__dirname, 'src/'),
    },
  },
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, 'src/'),
    },
  },
})
