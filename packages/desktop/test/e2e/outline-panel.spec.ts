import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { clickMenuById, launchWithMarkdown } from './helpers'

test.describe('outline panel on the right', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown('# Doc\n\n## A\n\n## B\n')
    app = launched.app
    page = launched.page
  })

  test.afterAll(async() => {
    if (app) await app.close()
  })

  test('outline panel is visible by default and toggles via View menu', async() => {
    const panel = page.locator('.outline-panel')
    await expect(panel).toBeVisible()

    await clickMenuById(app, 'tocMenuItem')
    await expect(panel).toBeHidden()

    await clickMenuById(app, 'tocMenuItem')
    await expect(panel).toBeVisible()
  })

  test('outline panel lists document headings', async() => {
    const tree = page.locator('.outline-panel .el-tree')
    await expect(tree).toBeVisible()
    await expect(tree.locator('text=Doc')).toBeVisible()
    await expect(tree.locator('text=A')).toBeVisible()
    await expect(tree.locator('text=B')).toBeVisible()
  })
})
