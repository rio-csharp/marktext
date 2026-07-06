import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clickMenuById, launchElectron, launchWithMarkdown, waitForEditor, waitForMenuReady } from './helpers'

const buildDoc = (): string => {
  const parts: string[] = []
  for (let i = 1; i <= 4; i++) {
    parts.push(`# Section ${i}`)
    for (let p = 0; p < 8; p++) {
      parts.push(`Paragraph ${p} in section ${i}.`)
    }
  }
  return parts.join('\n\n') + '\n'
}

const activeMarkdown = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const paragraphs = Array.from(document.querySelectorAll('.mu-container > *'))
    return paragraphs.map((node) => node.textContent || '').join('\n')
  })

interface TwoFileFixture {
  dir: string
  first: string
  second: string
}

const createTwoFileFixture = (): TwoFileFixture => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marktext-e2etest-file-nav-'))
  const first = path.join(dir, 'alpha.md')
  const second = path.join(dir, 'beta.md')
  fs.writeFileSync(first, '# Alpha\n\nFirst file body.\n', 'utf8')
  fs.writeFileSync(second, '# Beta\n\nSecond file body.\n', 'utf8')
  return { dir, first, second }
}

test.describe('Read-only mode and section navigation', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown(buildDoc())
    app = launched.app
    page = launched.page
    await waitForEditor(page)
  })

  test.afterAll(async() => {
    if (app) await app.close()
  })

  test('read-only mode blocks editing while keeping document readable', async() => {
    const before = await activeMarkdown(page)

    await clickMenuById(app, 'readOnlyModeMenuItem')
    await expect(page.locator('.editor-component')).toHaveAttribute('contenteditable', 'false')

    await page.locator('.mu-container h1').first().click()
    await page.keyboard.type(' blocked')
    await page.waitForTimeout(250)

    expect(await activeMarkdown(page)).toBe(before)

    await clickMenuById(app, 'readOnlyModeMenuItem')
    await expect(page.locator('.editor-component')).toHaveAttribute('contenteditable', 'true')
  })

  test('outline panel does not own file navigation controls', async() => {
    await expect(page.locator('.outline-panel-toolbar')).toHaveCount(0)
  })
})

test.describe('File navigation', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async() => {
    const { dir, first } = createTwoFileFixture()
    const launched = await launchElectron()
    app = launched.app
    page = launched.page
    await app.evaluate(({ BrowserWindow, ipcMain }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      ipcMain.emit('app-open-directory-by-id', win.id, payload.dir, true)
      ipcMain.emit('app-open-file-by-id', win.id, payload.first)
    }, { dir, first })
    await waitForEditor(page)
    await waitForMenuReady(app)
    await expect(page.locator('.side-bar-file', { hasText: 'beta.md' })).toBeVisible()
  })

  test.afterAll(async() => {
    if (app) await app.close()
  })

  test('floating file controls follow project tree files and open unopened targets', async() => {
    await expect(page.locator('.mu-container h1').first()).toContainText('Alpha')
    await expect(page.locator('.opened-file.active .name')).toHaveText('alpha.md')
    await expect(page.locator('.opened-file .name')).toHaveCount(1)

    await page.getByRole('button', { name: 'Next file' }).click()
    await expect(page.locator('.mu-container h1').first()).toContainText('Beta')
    await expect(page.locator('.mu-container')).toContainText('Second file body.')
    await expect(page.locator('.mu-container')).not.toContainText('First file body.')
    await expect(page.locator('.opened-file.active .name')).toHaveText('beta.md')
    await expect(page.locator('.editor-tabs li.active span').first()).toHaveText('beta.md')
    await expect(page.locator('.opened-file .name')).toHaveCount(1)

    await page.getByRole('button', { name: 'Previous file' }).click()
    await expect(page.locator('.mu-container h1').first()).toContainText('Alpha')
    await expect(page.locator('.mu-container')).toContainText('First file body.')
    await expect(page.locator('.mu-container')).not.toContainText('Second file body.')
    await expect(page.locator('.opened-file.active .name')).toHaveText('alpha.md')
    await expect(page.locator('.opened-file .name')).toHaveCount(1)
  })
})
