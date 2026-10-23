import { randomInt } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createProject, importFixtureSpec, pointProjectAtFixture, signUpAndSignIn, unique, whenHydrated } from '../support/app'
import { callGateway, upstreamRequests } from '../support/gateway'

test('create an API key, call the gateway with it, revoke it and see it rejected', async ({ page }) => {
  await signUpAndSignIn(page)
  const slug = await createProject(page)
  await importFixtureSpec(page, slug)
  await pointProjectAtFixture(slug)

  // Create a key. Its full value is shown once, in a dialog.
  const keyName = `key ${unique()}`
  await page.goto(`/projects/${slug}/api-keys`)
  const create = page.getByRole('button', { name: 'Create your first key' })
  await whenHydrated(create)
  await create.click()
  const createDialog = page.getByRole('dialog', { name: 'Create an API key' })
  await createDialog.getByLabel('Name').fill(keyName)
  await createDialog.getByRole('button', { name: 'Create key' }).click()

  const revealDialog = page.getByRole('dialog', { name: 'Copy your API key' })
  const apiKey = await revealDialog.getByLabel('New API key').inputValue()
  expect(apiKey).toMatch(/^mcpg_[A-Za-z0-9_-]{32}$/)
  await revealDialog.getByRole('button', { name: 'I have saved it' }).click()
  await expect(revealDialog).toBeHidden()

  // Shown once: after a reload only the prefix is listed, never the key.
  await page.reload()
  const row = page.getByRole('row', { name: new RegExp(keyName) })
  await expect(row).toContainText(apiKey.slice(0, 9)) // "mcpg_" and the first four characters, then an ellipsis
  await expect(page.getByText(apiKey)).toHaveCount(0)

  // The key works against the real gateway: it lists the tools and calls the upstream.
  const list = await callGateway(slug, apiKey, 'tools/list')
  expect(list.status).toBe(200)
  expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['addPet', 'findPetsByStatus', 'getPetById'])

  const petId = randomInt(10_000, 1_000_000)
  const call = await callGateway(slug, apiKey, 'tools/call', { name: 'getPetById', arguments: { petId } })
  expect(call.status).toBe(200)
  expect(call.body.result.isError).not.toBe(true)
  expect(JSON.stringify(call.body.result)).toContain(`fixture-pet-${petId}`)
  expect(await upstreamRequests()).toContainEqual(expect.objectContaining({ method: 'GET', url: `/pet/${petId}` }))

  // Revoke it in the dashboard.
  const revoke = page.getByRole('button', { name: `Revoke ${keyName}` })
  await whenHydrated(revoke)
  await revoke.click()
  await page.getByRole('dialog', { name: 'Revoke this key?' }).getByRole('button', { name: 'Revoke key' }).click()
  await expect(row).toContainText('Revoked')

  // The gateway turns it away. The dashboard clears the gateway's cached key as it revokes, so this is immediate; the poll
  // (on tools/list, which never reaches the upstream) only gives the Redis delete a moment on a slow machine.
  await expect.poll(async () => (await callGateway(slug, apiKey, 'tools/list')).status).toBe(401)
  const callsBefore = (await upstreamRequests()).length
  const rejected = await callGateway(slug, apiKey, 'tools/call', { name: 'getPetById', arguments: { petId } })
  expect(rejected.status).toBe(401)
  expect(rejected.body.error.message).toContain('API key missing, invalid or revoked')
  expect((await upstreamRequests()).length).toBe(callsBefore)
})
