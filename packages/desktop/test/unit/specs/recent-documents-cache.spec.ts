import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Preference from 'main_renderer/preferences'
import type Keybindings from 'main_renderer/keyboard/shortcutHandler'

const { readFile, writeFile, lstat, readlink, mkdir, buildFromTemplate } = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  lstat: vi.fn(),
  readlink: vi.fn(),
  mkdir: vi.fn(),
  buildFromTemplate: vi.fn(() => ({ getMenuItemById: () => ({ checked: false }) }))
}))

vi.mock('fs/promises', () => ({ default: { readFile, writeFile, lstat, readlink, mkdir } }))
vi.mock('electron', () => ({
  app: { addRecentDocument: vi.fn(), clearRecentDocuments: vi.fn() },
  ipcMain: { on: vi.fn() },
  Menu: { buildFromTemplate, getApplicationMenu: vi.fn(), setApplicationMenu: vi.fn() },
  BrowserWindow: { fromId: () => null }
}))
vi.mock('main_renderer/config', () => ({ isOsx: false, isWindows: false }))
vi.mock('main_renderer/menu/actions/edit', () => ({ updateSidebarMenu: vi.fn() }))
vi.mock('main_renderer/menu/actions/format', () => ({ updateFormatMenu: vi.fn() }))
vi.mock('main_renderer/menu/actions/paragraph', () => ({ updateSelectionMenus: vi.fn() }))
vi.mock('main_renderer/menu/actions/view', () => ({ viewLayoutChanged: vi.fn() }))
vi.mock('main_renderer/utils/internalIpc', () => ({ onInternalChannel: vi.fn() }))
vi.mock('main_renderer/i18n.js', () => ({ setLanguage: vi.fn() }))
vi.mock('main_renderer/menu/templates', () => ({
  default: vi.fn(() => []),
  configSettingMenu: vi.fn()
}))

import AppMenu from 'main_renderer/menu'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
const regularFile = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
const stores: AppMenu[] = []
function createMenu(): AppMenu {
  const menu = new AppMenu(
    { getItem: () => 'en' } as unknown as Preference,
    { registerEditorKeyHandlers: vi.fn() } as unknown as Keybindings,
    '/test/recents'
  )
  stores.push(menu)
  return menu
}

beforeEach(() => {
  vi.clearAllMocks()
  lstat.mockResolvedValue(regularFile)
  readFile.mockResolvedValue('[]')
  writeFile.mockResolvedValue(undefined)
  mkdir.mockResolvedValue(undefined)
})
afterEach(async () => {
  await Promise.all(stores.splice(0).map((menu) => menu.flushRecentDocuments()))
})

describe('in-memory recent documents', () => {
  it('merges opens during startup with hydrated recents without synchronous disk access', async () => {
    const disk = deferred<string>()
    readFile.mockReturnValueOnce(disk.promise)
    const menu = createMenu()
    menu.addRecentlyUsedDocument('/notes/new.md')
    menu.addRecentlyUsedDocument('/notes/old.md')
    disk.resolve(JSON.stringify(['/notes/old.md', '/notes/other.md']))
    await menu.flushRecentDocuments()
    expect(menu.getRecentlyUsedDocuments()).toEqual([
      '/notes/old.md',
      '/notes/new.md',
      '/notes/other.md'
    ])
    const reads = readFile.mock.calls.length
    menu.getRecentlyUsedDocuments()
    menu.updateAppMenu()
    expect(readFile).toHaveBeenCalledTimes(reads)
    expect(JSON.parse(writeFile.mock.calls.at(-1)![1])).toEqual(menu.getRecentlyUsedDocuments())
  })

  it('a startup clear is a barrier against restoring older disk entries', async () => {
    const disk = deferred<string>()
    readFile.mockReturnValueOnce(disk.promise)
    const menu = createMenu()
    menu.addRecentlyUsedDocument('/notes/before-clear.md')
    menu.clearRecentlyUsedDocuments()
    menu.addRecentlyUsedDocument('/notes/after-clear.md')
    disk.resolve(JSON.stringify(['/notes/old.md']))
    await menu.flushRecentDocuments()
    expect(menu.getRecentlyUsedDocuments()).toEqual(['/notes/after-clear.md'])
  })

  it('coalesces bursts to one menu rebuild and one write', async () => {
    const menu = createMenu()
    await menu.flushRecentDocuments()
    menu.addEditorMenu({ id: 1 } as never)
    buildFromTemplate.mockClear()
    writeFile.mockClear()
    for (let i = 0; i < 30; i++) menu.addRecentlyUsedDocument(`/notes/${i}.md`)
    await menu.flushRecentDocuments()
    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(menu.getRecentlyUsedDocuments()).toHaveLength(12)
    expect(menu.getRecentlyUsedDocuments()[0]).toBe('/notes/29.md')
    const returned = menu.getRecentlyUsedDocuments()
    returned.length = 0
    expect(menu.getRecentlyUsedDocuments()).toHaveLength(12)
  })

  it('serializes writes and includes changes accepted during an in-flight write', async () => {
    const menu = createMenu()
    await menu.flushRecentDocuments()
    const first = deferred<void>()
    const started = deferred<void>()
    writeFile.mockImplementationOnce(() => {
      started.resolve()
      return first.promise
    })
    menu.addRecentlyUsedDocument('/notes/first.md')
    const flush = menu.flushRecentDocuments()
    await started.promise
    menu.clearRecentlyUsedDocuments()
    menu.addRecentlyUsedDocument('/notes/last.md')
    expect(writeFile).toHaveBeenCalledTimes(1)
    first.resolve()
    await flush
    expect(writeFile).toHaveBeenCalledTimes(2)
    expect(JSON.parse(writeFile.mock.calls[1][1])).toEqual(['/notes/last.md'])
  })

  it('preserves one-hop symlink validation and excludes broken links', async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify(['/notes/link.md', '/notes/broken.md', '/notes/chain.md'])
    )
    lstat.mockImplementation(async (pathname: string) => {
      if (
        pathname.endsWith('link.md') ||
        pathname.endsWith('broken.md') ||
        pathname.endsWith('chain.md') ||
        pathname.endsWith('second.md')
      ) {
        return { ...regularFile, isFile: () => false, isSymbolicLink: () => true }
      }
      if (pathname.endsWith('missing.md')) throw new Error('missing')
      return regularFile
    })
    readlink.mockImplementation(async (pathname: string) => {
      if (pathname.endsWith('link.md')) return 'target.md'
      if (pathname.endsWith('chain.md')) return 'second.md'
      return 'missing.md'
    })
    const menu = createMenu()
    await menu.flushRecentDocuments()
    expect(menu.getRecentlyUsedDocuments()).toEqual(['/notes/link.md'])
  })
})
