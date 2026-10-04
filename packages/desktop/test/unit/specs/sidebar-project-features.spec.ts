import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  updateFile: vi.fn(),
  create: vi.fn(async() => {}),
  stateFromData: vi.fn((data: unknown) => data),
  menus: [] as Array<Array<{ id?: string; enabled?: boolean; click?: () => void }>>
}))
vi.hoisted(() => {
  Object.assign(window, {
    path: { sep: '/' },
    fileUtils: {},
    electron: { ipcRenderer: {} }
  })
})
vi.mock('@/util', () => ({ getUniqueId: () => 'node-id' }))
vi.mock('@/store/preferences', () => ({
  usePreferencesStore: () => ({ fileSortBy: 'title', fileSortOrder: 'asc' })
}))
vi.mock('@/store/editor', () => ({
  useEditorStore: () => ({ UPDATE_CURRENT_FILE: mocks.updateFile })
}))
vi.mock('@/store/layout', () => ({
  useLayoutStore: () => ({ SET_LAYOUT: vi.fn(), DISPATCH_LAYOUT_MENU_ITEMS: vi.fn() })
}))
vi.mock('@/store/help', () => ({ getFileStateFromData: mocks.stateFromData }))
vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))
vi.mock('@/services/notification', () => ({ default: { notify: vi.fn() } }))
vi.mock('@/util/fileSystem', () => ({ create: mocks.create, paste: vi.fn(), rename: vi.fn() }))
vi.mock('@/i18n', () => ({ t: (key: string) => key }))
vi.mock('@/contextMenu/popupMenu', () => ({
  popupContextMenu: (items: (typeof mocks.menus)[number]) => mocks.menus.push(items)
}))

import { useProjectStore } from '@/store/project'
import { showContextMenu } from '@/contextMenu/sideBar'
import bus from '@/bus'

let project: ReturnType<typeof useProjectStore>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.menus.length = 0
  Object.assign(window, {
    path: path.posix,
    fileUtils: {
      pathExists: vi.fn(async() => false),
      hasMarkdownExtension: (name: string) => name.endsWith('.md')
    },
    electron: {
      clipboard: { writeText: vi.fn() },
      shell: { showItemInFolder: vi.fn() },
      ipcRenderer: { on: vi.fn(() => vi.fn()), send: vi.fn(), invoke: vi.fn(async() => false) }
    }
  })
  setActivePinia(createPinia())
  project = useProjectStore()
  project.projectTree = {
    pathname: '/docs',
    name: 'docs',
    isDirectory: true,
    isFile: false,
    isMarkdown: false,
    folders: [],
    files: []
  }
})

afterEach(() => project.$dispose())

const add = (extra: Record<string, unknown> = {}): void => {
  project.LISTEN_FOR_UPDATE_PROJECT()
  const handler = vi
    .mocked(window.electron.ipcRenderer.on)
    .mock.calls.find(([channel]) => channel === 'mt::update-object-tree')![1]
  handler(
    {},
    {
      type: 'add',
      change: {
        pathname: '/docs/new.md',
        name: 'new.md',
        isFile: true,
        isDirectory: false,
        isMarkdown: true,
        ...extra
      }
    }
  )
}

describe('sidebar metadata-only additions', () => {
  it('seeds an app-created empty file and clears its cache', () => {
    project.newFileNameCache = '/docs/new.md'
    add()
    expect(mocks.stateFromData).toHaveBeenCalledWith({
      pathname: '/docs/new.md',
      filename: 'new.md',
      markdown: ''
    })
    expect(mocks.updateFile).toHaveBeenCalledTimes(1)
    expect(project.newFileNameCache).toBe('')
    expect(project.projectTree!.files.map((file) => file.pathname)).toEqual(['/docs/new.md'])
  })

  it('preserves the legacy content payload', () => {
    project.newFileNameCache = '/docs/new.md'
    const data = {
      pathname: '/docs/new.md',
      filename: 'new.md',
      markdown: '# loaded',
      encoding: { encoding: 'utf16le', isBom: true }
    }
    add({ data })
    expect(mocks.stateFromData).toHaveBeenCalledWith(data)
  })

  it('does not create empty tabs for unrelated scanned files or non-Markdown adds', () => {
    project.newFileNameCache = '/docs/other.md'
    add()
    expect(mocks.updateFile).not.toHaveBeenCalled()
    expect(project.newFileNameCache).toBe('/docs/other.md')
    project.newFileNameCache = '/docs/new.md'
    add({ isMarkdown: false })
    expect(mocks.updateFile).not.toHaveBeenCalled()
  })
})

describe('sidebar native context-menu targeting and cleanup', () => {
  it.each(['/docs/a.md', '/docs/sub', '/docs'])(
    'copies the captured absolute target %s rather than the later selection',
    (pathname) => {
      project.LISTEN_FOR_SIDEBAR_CONTEXT_MENU()
      showContextMenu({ clientX: 1, clientY: 2 }, false, pathname)
      project.CHANGE_ACTIVE_ITEM({ pathname: '/docs/stale.md' })
      const item = mocks.menus[0].find((entry) => entry.id === 'copyPathMenuItem')!
      expect(item.enabled).toBe(true)
      item.click!()
      expect(window.electron.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(pathname)
    }
  )

  it.each(['', 'relative.md'])('disables path copying for %j', (pathname) => {
    project.LISTEN_FOR_SIDEBAR_CONTEXT_MENU()
    showContextMenu({ clientX: 1, clientY: 2 }, true, pathname)
    const item = mocks.menus[0].find((entry) => entry.id === 'copyPathMenuItem')!
    expect(item.enabled).toBe(false)
    item.click!()
    expect(window.electron.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('does not accumulate bus listeners after repeated setup or disposal', () => {
    project.LISTEN_FOR_SIDEBAR_CONTEXT_MENU()
    project.LISTEN_FOR_SIDEBAR_CONTEXT_MENU()
    bus.emit('SIDEBAR::copy-path', '/docs/a.md')
    expect(window.electron.clipboard.writeText).toHaveBeenCalledTimes(1)
    project.$dispose()
    bus.emit('SIDEBAR::copy-path', '/docs/b.md')
    expect(window.electron.clipboard.writeText).toHaveBeenCalledTimes(1)
  })

  it('preserves selection when trash is cancelled and clears it only on success', async() => {
    project.LISTEN_FOR_SIDEBAR_CONTEXT_MENU()
    project.CHANGE_ACTIVE_ITEM({ pathname: '/docs/a.md', isFile: true })
    bus.emit('SIDEBAR::remove')
    await Promise.resolve()
    expect(project.activeItem.pathname).toBe('/docs/a.md')
    vi.mocked(window.electron.ipcRenderer.invoke).mockResolvedValueOnce(true)
    bus.emit('SIDEBAR::remove')
    await Promise.resolve()
    expect(project.activeItem).toEqual({})
  })

  it('does not clear a different selection when an earlier trash operation completes', async() => {
    project.LISTEN_FOR_SIDEBAR_CONTEXT_MENU()
    let finish!: (value: boolean) => void
    vi.mocked(window.electron.ipcRenderer.invoke).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    project.CHANGE_ACTIVE_ITEM({ pathname: '/docs/a.md', isFile: true })
    bus.emit('SIDEBAR::remove')
    project.CHANGE_ACTIVE_ITEM({ pathname: '/docs/b.md', isFile: true })
    finish(true)
    await Promise.resolve()
    expect(project.activeItem.pathname).toBe('/docs/b.md')
  })
})
