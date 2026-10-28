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
      // Resolves a `.css` import to this stub before Vite's own CSS plugin ever sees the file, so the project's
      // real PostCSS/Tailwind pipeline never runs in tests. Without this, Vitest's own CSS handling (which does
      // run that pipeline and only discards the result afterwards) cost 137-4429 ms per fresh process, almost all
      // of it in the one file that imports CSS (global-error.tsx). No test renders real CSS or asserts on it; this
      // never touches `next build` or `next dev`, which import `.css` normally. See docs/DECISIONS.md.
      // Anchored at both ends: a regex alias replaces only the matched substring, not the whole specifier, so
      // `/\.css$/` alone would turn `./globals.css` into the nonsense `./globals` + this path glued together.
      // Matches *.module.css too; there are none today, but adding one means changing this (CSS Modules'
      // per-class exports would need a real stub, not an empty one).
      { find: /^.*\.css$/, replacement: path.resolve(__dirname, 'src/test/css-stub.ts') },
    ],
  },
})
