import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import { FIXTURE_PORT, GATEWAY_PORT, REPO, WEB_PORT, WEB_URL, gatewayEnv, prepareEnvironment, webEnv } from './support/environment'

// Runs before the servers start: checks the targets, migrates the e2e database, fixes the secrets.
prepareEnvironment()

const webDir = resolve(REPO, 'apps/web')
const nextBin = createRequire(resolve(webDir, 'package.json')).resolve('next/dist/bin/next')
const here = import.meta.dirname

export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  // The flows share one database and one Redis database (each uses its own user and project); one worker keeps them simple.
  workers: 1,
  fullyParallel: false,
  // No retries: a test that passes only on a second try is a flaky test, and this is how we see it.
  retries: 0,
  forbidOnly: !!process.env['CI'],
  // One flow is several page loads and two password hashes; the limit only matters when something is stuck.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    // Locally the installed Chrome (nothing to download); CI installs Playwright's own Chromium.
    ...(process.env['CI'] ? {} : { channel: 'chrome' }),
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `node --import tsx "${resolve(here, 'support/fixture-server.ts')}"`,
      cwd: here,
      url: `http://127.0.0.1:${FIXTURE_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FIXTURE_PORT: String(FIXTURE_PORT) },
    },
    {
      command: `node "${resolve(REPO, 'apps/gateway/dist/index.js')}"`,
      cwd: resolve(REPO, 'apps/gateway'),
      url: `http://127.0.0.1:${GATEWAY_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stderr: 'pipe',
      env: gatewayEnv(),
    },
    {
      command: `node "${nextBin}" start --hostname 127.0.0.1 --port ${WEB_PORT}`,
      cwd: webDir,
      url: `${WEB_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stderr: 'pipe',
      env: webEnv(),
    },
  ],
})
