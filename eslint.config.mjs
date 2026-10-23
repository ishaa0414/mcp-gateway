import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
  {
    // The web app must reach the database through the server-only wrapper so a
    // client component can never pull Prisma into the browser bundle.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/lib/db.ts', 'apps/web/src/**/*.test.ts', 'apps/web/src/test/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@mcp-gateway/db',
              allowTypeImports: true,
              message: 'Import { db } from "@/lib/db" (server-only). Type-only imports are fine.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests wait for something they can observe (an assertion, a URL, expect.poll), never for time.
    files: ['apps/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='waitForTimeout']", message: 'Do not wait for time: assert on what you expect to appear.' },
        { selector: "CallExpression[callee.property.name='waitForLoadState'][arguments.0.value='networkidle']", message: 'networkidle is a timing guess: assert on what you expect to appear.' },
      ],
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-e2e/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
      '**/generated/**',
      '**/.turbo/**',
      '**/prisma/migrations/**',
    ],
  }
)
