import { randomInt } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createProject, importFixtureSpec, pointProjectAtFixture, signUpAndSignIn, whenHydrated } from '../support/app'
import { upstreamRequests } from '../support/gateway'

test('run a tool in the Playground and see the request and the upstream response', async ({ page }) => {
  await signUpAndSignIn(page)
  const slug = await createProject(page)
  await importFixtureSpec(page, slug)
  await pointProjectAtFixture(slug)

  await page.goto(`/projects/${slug}/playground`)
  const picker = page.getByLabel('Tool')
  await whenHydrated(picker)
  await picker.selectOption({ label: 'GET /pet/{petId} — getPetById' })

  const petId = randomInt(10_000, 1_000_000)
  await page.getByLabel('petId').fill(String(petId))
  await page.getByRole('button', { name: 'Run' }).click()

  // The request is shown (a GET needs no confirmation) and so is the upstream's answer.
  const request = page.getByRole('region', { name: 'Request' })
  await expect(request).toContainText(`/pet/${petId}`)
  const response = page.getByRole('region', { name: 'Response' })
  await expect(response).toContainText('HTTP 200')
  await expect(response.getByLabel('Response body')).toContainText(`fixture-pet-${petId}`)

  // It went through the gateway to the fixture upstream.
  expect(await upstreamRequests()).toContainEqual(expect.objectContaining({ method: 'GET', url: `/pet/${petId}` }))
})
