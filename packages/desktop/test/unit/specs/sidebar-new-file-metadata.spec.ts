import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Directory `add` events carry metadata only (content loads on demand), so
// opening an app-created file from its `add` event must seed the tab from the
// path instead of relying on a `data` payload.

// `@/store/project` reaches window.path and window.fileUtils at runtime, and
// `@/store/editor` reaches window.fileUtils plus the preload ipc bridge. Stub
// the surfaces before the hoisted imports run.
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: {
        sep: string
        normalize: (p: string) => string
        basename: (p: string) => string
        dirname: (p: string) => string
        isAbsolute: (p: string) => boolean
        relative: (from: string, to: string) => string
      }
      fileUtils?: {
        hasMarkdownExtension: (n: string) => boolean
        pathExists: (p: string) => Promise<boolean>
        isSamePathSync: (a: string, b: string) => boolean
      }
      electron?: { ipcRenderer: { send: (...a: unknown[]) => void; on: Mock } }
    }
  }
  w.window ??= {}
  w.window.path ??= {
    sep: '/',
    normalize: (p) => p,
    basename: (p) => p.split('/').pop() ?? p,
    dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    isAbsolute: (p) => p.startsWith('/'),
    relative: (from, to) => {
      if (to === from) return ''
      return to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to
    }
  }
  w.window.fileUtils ??= {
    hasMarkdownExtension: (n) => n.endsWith('.md'),
    pathExists: () => Promise.resolve(false),
    isSamePathSync: (a, b) => a === b
  }
  w.window.electron ??= { ipcRenderer: { send: () => {}, on: vi.fn() } }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))

import { useProjectStore } from '@/store/project'
import { useEditorStore } from '@/store/editor'

describe('sidebar new file opens from metadata-only add', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(window.electron.ipcRenderer.on as Mock).mockReset()
  })

  const setup = () => {
    const project = useProjectStore()
    const editor = useEditorStore()
    project.projectTree = {
      pathname: '/proj',
      name: 'proj',
      isDirectory: true,
      isFile: false,
      isMarkdown: false,
      folders: [],
      files: []
    } as never
    project.newFileNameCache = '/proj/new-note.md'
    const updateSpy = vi.spyOn(editor, 'UPDATE_CURRENT_FILE').mockImplementation(() => {})
    project.LISTEN_FOR_UPDATE_PROJECT()
    const onMock = window.electron.ipcRenderer.on as Mock
    const handler = onMock.mock.calls.find((c) => c[0] === 'mt::update-object-tree')![1] as (
      e: unknown,
      payload: unknown
    ) => void
    return { project, handler, updateSpy }
  }

  const metadataAdd = (extra: Record<string, unknown> = {}) => ({
    type: 'add',
    change: {
      pathname: '/proj/new-note.md',
      name: 'new-note.md',
      isFile: true,
      isDirectory: false,
      isMarkdown: true,
      birthTime: new Date(0),
      mtimeMs: 1,
      ...extra
    }
  })

  it('seeds an empty tab from the path when no data payload arrives', () => {
    const { project, handler, updateSpy } = setup()

    handler(null, metadataAdd())

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const state = updateSpy.mock.calls[0][0] as {
      pathname: string
      filename: string
      markdown: string
    }
    expect(state.pathname).toBe('/proj/new-note.md')
    expect(state.filename).toBe('new-note.md')
    expect(state.markdown).toBe('')
    expect(project.newFileNameCache).toBe('')
    // The node itself is still listed in the tree.
    expect(project.projectTree!.files.map((f) => f.pathname)).toContain('/proj/new-note.md')
  })

  it('still honors a data payload when present', () => {
    const { handler, updateSpy } = setup()

    handler(
      null,
      metadataAdd({
        data: { pathname: '/proj/new-note.md', filename: 'new-note.md', markdown: '# from disk\n' }
      })
    )

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const state = updateSpy.mock.calls[0][0] as { markdown: string }
    expect(state.markdown).toBe('# from disk\n')
  })
})
