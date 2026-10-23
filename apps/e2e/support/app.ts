import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { db } from '@mcp-gateway/db'
import { invalidateProjectConfig } from '@mcp-gateway/shared'
import { expect, type Locator, type Page } from '@playwright/test'
import { Redis } from 'ioredis'
import { FIXTURE_URL } from './environment'

/** Short unique text for names, emails and slugs, so every test works on rows nobody else touches. */
export const unique = (): string => randomBytes(4).toString('hex')

/**
 * Waits until React has attached to an element (hydration is done), so a click or a submit reaches its handler.
 * Without it a fast test submits the form natively, before the page's JavaScript is running. React puts a
 * `__reactProps$…` property on every element it manages; this polls for it instead of waiting for a time.
 */
export async function whenHydrated(element: Locator): Promise<void> {
  await expect.poll(() => element.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps$')))).toBe(true)
}

/**
 * Upper bound for the two steps that hash a password (argon2 in the server action): sign-up and sign-in. On a loaded
 * machine they take well over the default 10 s; on a quiet one a second or two. It is a limit, not a wait.
 */
const PASSWORD_HASHING_MS = 45_000

export interface Account {
  name: string
  email: string
  password: string
}

/** Signs up through the form and signs in with the new account; ends on the projects page. */
export async function signUpAndSignIn(page: Page): Promise<Account> {
  const id = unique()
  const account = { name: `E2E ${id}`, email: `e2e-${id}@example.com`, password: `pw-${id}-${id}` }

  await page.goto('/sign-up')
  await whenHydrated(page.getByLabel('Email'))
  await page.getByLabel('Name').fill(account.name)
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(account.password)
  await page.getByLabel('Confirm password').fill(account.password)
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page).toHaveURL(/\/sign-in\?registered=1/, { timeout: PASSWORD_HASHING_MS })
  await whenHydrated(page.getByLabel('Email'))
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/projects$/, { timeout: PASSWORD_HASHING_MS })
  return account
}

/** Creates a project with no upstream URL (the dashboard refuses local addresses); returns its slug. */
export async function createProject(page: Page): Promise<string> {
  const slug = `e2e-${unique()}`
  await page.goto('/projects/new')
  await whenHydrated(page.getByLabel('Project name'))
  await page.getByLabel('Project name').fill(`Project ${slug}`)
  await page.getByLabel(/^Slug/).fill(slug)
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/overview`))
  return slug
}

/** Uploads the fixture OpenAPI file on the project's Spec tab and waits for the import summary. */
export async function importFixtureSpec(page: Page, slug: string): Promise<void> {
  await page.goto(`/projects/${slug}/spec`)
  await whenHydrated(page.getByLabel('File', { exact: true }))
  await page.getByLabel('File', { exact: true }).setInputFiles(resolve(import.meta.dirname, '../fixtures/petstore.json'))
  await page.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByText('Import successful')).toBeVisible()
  await expect(page.getByText('3 added')).toBeVisible()
}

/**
 * Points the project at the fixture upstream. The dashboard's own form refuses a local address (production builds
 * cannot be told otherwise), so the test writes the URL to the e2e database, then clears the gateway's cached
 * configuration with the function the dashboard itself uses after an edit (packages/shared, via CacheInvalidator).
 */
export async function pointProjectAtFixture(slug: string): Promise<void> {
  await db.project.update({ where: { slug }, data: { upstreamBaseUrl: FIXTURE_URL } })
  const redis = new Redis(process.env['REDIS_URL']!, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await redis.connect()
    await invalidateProjectConfig(redis, slug)
  } finally {
    redis.disconnect()
  }
}
