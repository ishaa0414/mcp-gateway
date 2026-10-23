import { expect, test } from '@playwright/test'
import { createProject, importFixtureSpec, signUpAndSignIn, whenHydrated } from '../support/app'

test('sign up, create a project from a spec, toggle and rename a tool', async ({ page }) => {
  await signUpAndSignIn(page)
  const slug = await createProject(page)
  await importFixtureSpec(page, slug)

  await page.goto(`/projects/${slug}/tools`)
  const toggle = page.getByRole('switch', { name: 'Toggle getPetById' })
  await expect(toggle).toBeChecked()
  await whenHydrated(toggle)

  // Toggle off. It is saved on the server: a reload shows the same.
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await page.reload()
  await expect(page.getByRole('switch', { name: 'Toggle getPetById' })).not.toBeChecked()
  // The other tools were not touched.
  await expect(page.getByRole('switch', { name: 'Toggle findPetsByStatus' })).toBeChecked()

  // Rename.
  const edit = page.getByRole('button', { name: 'Edit getPetById' })
  await whenHydrated(edit)
  await edit.click()
  const dialog = page.getByRole('dialog', { name: 'Edit tool' })
  await dialog.getByLabel('Tool name').fill('find_pet')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('switch', { name: 'Toggle find_pet' })).not.toBeChecked()

  // The new name and the disabled state are what a reload shows.
  await page.reload()
  await expect(page.getByRole('switch', { name: 'Toggle find_pet' })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: 'Toggle getPetById' })).toHaveCount(0)
})
