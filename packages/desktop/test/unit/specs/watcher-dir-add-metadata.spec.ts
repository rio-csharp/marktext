// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { Stats } from 'fs'
import type { BrowserWindow } from 'electron'
import type Preference from 'main_renderer/preferences'

type Handler = (...args: unknown[]) => unknown

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  stat: vi.fn(),
  load: vi.fn(),
  exists: vi.fn(),
  nextId: 0
}))

vi.mock('chokidar', () => ({ default: { watch: mocks.watch } }))
vi.mock('fs/promises', () => ({ default: { stat: mocks.stat } }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('common/filesystem', () => ({ exists: mocks.exists }))
vi.mock('main_renderer/utils', () => ({ getUniqueId: () => String(++mocks.nextId) }))
vi.mock('main_renderer/config', () => ({ isLinux: true, isOsx: false }))
vi.mock('main_renderer/filesystem/markdown', () => ({ loadMarkdownFile: mocks.load }))

import Watcher, { WATCHER_IGNORED_SEGMENTS } from 'main_renderer/filesystem/watcher'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  return { promise, resolve, reject }
}

const stats = {
  birthtime: new Date('2026-01-01'),
  mtime: new Date('2026-02-01'),
  mtimeMs: 1234
} as Stats
const data = {
  markdown: '# loaded\n',
  filename: 'note.md',
  encoding: { encoding: 'utf8', isBom: false }
}

function fakeWatcher() {
  const handlers: Record<string, Handler> = {}
  const api = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers[event] = handler
      return api
    }),
    close: vi.fn(),
    add: vi.fn(),
    unwatch: vi.fn(),
    emit: (event: string, ...args: unknown[]) => handlers[event]?.(...args)
  }
  return api
}

describe('watcher metadata, ordered replay and disposal', () => {
  let watcher: Watcher
  let api: ReturnType<typeof fakeWatcher>
  let send: ReturnType<typeof vi.fn>
  let win: BrowserWindow
  let preferences: Preference
  let immediateCallbacks: Map<NodeJS.Immediate, () => void>

  async function drainOneChunk() {
    const entry = immediateCallbacks.entries().next().value
    if (!entry) throw new Error('No replay chunk scheduled')
    const [handle, callback] = entry
    immediateCallbacks.delete(handle)
    callback()
    await nextTurn()
  }

  async function drainAll() {
    while (immediateCallbacks.size) await drainOneChunk()
  }

  function events() {
    return send.mock.calls.map(([channel, payload]) => ({ channel, ...payload }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    api = fakeWatcher()
    mocks.watch.mockReturnValue(api)
    mocks.stat.mockResolvedValue(stats)
    mocks.load.mockResolvedValue(data)
    mocks.exists.mockResolvedValue(true)
    send = vi.fn()
    win = { id: 1, webContents: { send } } as unknown as BrowserWindow
    preferences = {
      getItem: vi.fn((key: string) =>
        key === 'treePathExcludePatterns' ? ['**/private/**'] : false
      ),
      getPreferredEol: vi.fn(() => 'lf'),
      getAll: vi.fn(() => ({}))
    } as unknown as Preference
    watcher = new Watcher(preferences)
    immediateCallbacks = new Map()
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: () => void) => {
      const handle = {} as NodeJS.Immediate
      immediateCallbacks.set(handle, callback)
      return handle
    }) as typeof setImmediate)
    vi.spyOn(globalThis, 'clearImmediate').mockImplementation((handle) => {
      if (handle) immediateCallbacks.delete(handle)
    })
  })

  afterEach(() => {
    watcher.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('buffers metadata-only adds until ready and reuses chokidar stats', async() => {
    watcher.watch(win, '/project')
    api.emit('add', '/project/note.md', stats)
    expect(send).not.toHaveBeenCalled()
    expect(immediateCallbacks.size).toBe(0)
    api.emit('ready')
    expect(send).not.toHaveBeenCalled()
    await drainAll()
    expect(events()).toEqual([
      {
        channel: 'mt::update-object-tree',
        type: 'add',
        change: {
          pathname: '/project/note.md',
          name: 'note.md',
          isFile: true,
          isDirectory: false,
          birthTime: stats.birthtime,
          mtimeMs: 1234,
          isMarkdown: true
        }
      }
    ])
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(preferences.getAll).not.toHaveBeenCalled()
  })

  it('falls back to stat for directory adds and changes without loading content', async() => {
    watcher.watch(win, '/project')
    api.emit('add', '/project/note.md')
    api.emit('change', '/project/note.md')
    api.emit('ready')
    await drainAll()
    expect(mocks.stat.mock.calls).toEqual([['/project/note.md'], ['/project/note.md']])
    expect(events().map((event) => event.type)).toEqual(['add', 'change'])
    expect(events()[1].change).toEqual({ pathname: '/project/note.md', mtimeMs: 1234 })
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('reuses change stats and handles events after startup', async() => {
    watcher.watch(win, '/project')
    api.emit('ready')
    await drainAll()
    api.emit('change', '/project/note.md', stats)
    await drainAll()
    expect(events()).toEqual([
      {
        channel: 'mt::update-object-tree',
        type: 'change',
        change: { pathname: '/project/note.md', mtimeMs: 1234 }
      }
    ])
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('yields between startup chunks and retains live events behind the replay', async() => {
    watcher.watch(win, '/project')
    for (let index = 0; index < 1001; index++) {
      api.emit('add', `/project/${index}.md`, stats)
    }
    api.emit('ready')
    await drainOneChunk()
    expect(send).toHaveBeenCalledTimes(500)
    expect(immediateCallbacks.size).toBe(1)
    api.emit('unlink', '/project/0.md')
    api.emit('addDir', '/project/new')
    api.emit('unlinkDir', '/project/new')
    await drainOneChunk()
    expect(send).toHaveBeenCalledTimes(1000)
    await drainOneChunk()
    expect(
      events()
        .slice(-4)
        .map((event) => [event.type, event.change.pathname])
    ).toEqual([
      ['add', '/project/1000.md'],
      ['unlink', '/project/0.md'],
      ['addDir', '/project/new'],
      ['unlinkDir', '/project/new']
    ])
    expect(immediateCallbacks.size).toBe(0)
  })

  it('does not allow unlink or change to overtake an add awaiting stat', async() => {
    const pending = deferred<Stats>()
    mocks.stat.mockReturnValueOnce(pending.promise)
    watcher.watch(win, '/project')
    api.emit('addDir', '/project/folder')
    api.emit('add', '/project/folder/note.md')
    api.emit('unlink', '/project/folder/note.md')
    api.emit('ready')
    await drainOneChunk()
    expect(events().map((event) => event.type)).toEqual(['addDir'])
    api.emit('change', '/project/other.md', stats)
    api.emit('unlinkDir', '/project/folder')
    pending.resolve(stats)
    await nextTurn()
    await drainAll()
    expect(events().map((event) => event.type)).toEqual([
      'addDir',
      'add',
      'unlink',
      'change',
      'unlinkDir'
    ])
  })

  it('ignores vanished files without blocking later replay events or notifying', async() => {
    mocks.stat.mockRejectedValueOnce(new Error('ENOENT'))
    watcher.watch(win, '/project')
    api.emit('add', '/project/gone.md')
    api.emit('unlink', '/project/gone.md')
    api.emit('ready')
    await drainAll()
    expect(events()).toEqual([
      {
        channel: 'mt::update-object-tree',
        type: 'unlink',
        change: { pathname: '/project/gone.md' }
      }
    ])
  })

  it.each(['add', 'change'])(
    'file %s still reloads content with preferences and stats',
    async(event) => {
      vi.mocked(preferences.getPreferredEol).mockReturnValue('crlf')
      vi.mocked(preferences.getAll).mockReturnValue({
        autoGuessEncoding: false,
        trimTrailingNewline: 0,
        autoNormalizeLineEndings: true
      } as ReturnType<Preference['getAll']>)
      watcher.watch(win, '/project/note.md', 'file')
      await api.emit(event, '/project/note.md', stats)
      expect(mocks.load).toHaveBeenCalledWith('/project/note.md', 'crlf', false, 0, true)
      expect(send).toHaveBeenCalledWith(
        'mt::update-file',
        expect.objectContaining({
          type: event,
          change: expect.objectContaining({ data, mtimeMs: 1234 })
        })
      )
      expect(mocks.stat).not.toHaveBeenCalled()
    }
  )

  it.each(['add', 'change'])('file %s reports content read errors', async(event) => {
    mocks.load.mockRejectedValueOnce(new Error('read failed'))
    watcher.watch(win, '/project/note.md', 'file')
    await api.emit(event, '/project/note.md', stats)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('mt::show-notification', {
      title: 'Watcher I/O error',
      type: 'error',
      message: 'read failed'
    })
  })

  it('still suppresses editor-originated single-file updates', async() => {
    watcher.watch(win, '/project/note.md', 'file')
    watcher.ignoreChangedEvent(win.id, '/project/note.md')
    await api.emit('change', '/project/note.md', stats)
    expect(send).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('reuses stats when checking delayed editor-originated events', async() => {
    watcher.watch(win, '/project/note.md', 'file')
    const now = new Date()
    watcher.ignoreChangedEvent(win.id, '/project/note.md', -1)
    await api.emit('change', '/project/note.md', {
      ...stats,
      mtime: new Date(now.getTime() - 5000)
    })
    expect(send).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
  })

  it.each(['returned close', 'unwatch', 'unwatchByWindowId', 'close all'])(
    '%s cancels queued replay and late events',
    async(method) => {
      const close = watcher.watch(win, '/project')
      api.emit('add', '/project/note.md', stats)
      api.emit('ready')
      if (method === 'returned close') close()
      else if (method === 'unwatch') watcher.unwatch(win, '/project')
      else if (method === 'unwatchByWindowId') watcher.unwatchByWindowId(win.id)
      else watcher.close()
      close()
      api.emit('ready')
      api.emit('add', '/project/late.md', stats)
      api.emit('change', '/project/note.md', stats)
      api.emit('unlink', '/project/note.md')
      api.emit('addDir', '/project/new')
      api.emit('unlinkDir', '/project/new')
      api.emit('error', { code: 'ENOSPC' })
      await drainAll()
      expect(send).not.toHaveBeenCalled()
      expect(api.close).toHaveBeenCalledOnce()
      expect(Object.keys(watcher.watchers)).toHaveLength(0)
      expect(immediateCallbacks.size).toBe(0)
    }
  )

  it('stops replay if disposal occurs during delivery of a chunk', async() => {
    const close = watcher.watch(win, '/project')
    send.mockImplementationOnce(() => close())
    api.emit('add', '/project/first.md', stats)
    api.emit('add', '/project/second.md', stats)
    api.emit('ready')
    await drainAll()
    expect(send).toHaveBeenCalledOnce()
  })

  it.each(['add', 'change'])(
    'does not deliver directory %s after an in-flight stat',
    async(event) => {
      const pending = deferred<Stats>()
      mocks.stat.mockReturnValueOnce(pending.promise)
      const close = watcher.watch(win, '/project')
      api.emit(event, '/project/note.md')
      api.emit('ready')
      await drainOneChunk()
      expect(mocks.stat).toHaveBeenCalledOnce()
      close()
      pending.resolve(stats)
      await nextTurn()
      expect(send).not.toHaveBeenCalled()
      expect(immediateCallbacks.size).toBe(0)
    }
  )

  it.each(['add', 'change'])(
    'does not deliver file %s or an error after an in-flight load',
    async(event) => {
      const pending = deferred<typeof data>()
      mocks.load.mockReturnValueOnce(pending.promise)
      const close = watcher.watch(win, '/project/note.md', 'file')
      const handled = api.emit(event, '/project/note.md', stats)
      await nextTurn()
      expect(mocks.load).toHaveBeenCalledOnce()
      close()
      if (event === 'add') pending.resolve(data)
      else pending.reject(new Error('read failed'))
      await handled
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('does not start a reload after an in-flight ignore check finishes following disposal', async() => {
    const pending = deferred<boolean>()
    vi.spyOn(watcher, '_shouldIgnoreEvent').mockReturnValueOnce(pending.promise)
    const close = watcher.watch(win, '/project/note.md', 'file')
    const handled = api.emit('change', '/project/note.md', stats)
    close()
    pending.resolve(false)
    await handled
    expect(send).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('does not restart a Linux file watcher after disposal during the rename existence check', async() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = deferred<boolean>()
    mocks.exists.mockReturnValueOnce(pending.promise)
    watcher.watch(win, '/project/note.md', 'file')
    api.emit('raw', 'rename', 'note.md', {})
    vi.advanceTimersByTime(150)
    expect(mocks.exists).toHaveBeenCalledOnce()
    watcher.unwatchByWindowId(win.id)
    pending.resolve(true)
    await nextTurn()
    expect(api.unwatch).not.toHaveBeenCalled()
    expect(api.add).not.toHaveBeenCalled()
  })

  it('unwatchByWindowId disposes all matching watchers without closing other windows', () => {
    watcher.watch(win, '/project')
    const second = fakeWatcher()
    mocks.watch.mockReturnValueOnce(second)
    watcher.watch(win, '/project/note.md', 'file')
    const other = fakeWatcher()
    mocks.watch.mockReturnValueOnce(other)
    watcher.watch({ ...win, id: 2 } as BrowserWindow, '/other')
    watcher.unwatchByWindowId(win.id)
    expect(api.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
    expect(other.close).not.toHaveBeenCalled()
    expect(Object.keys(watcher.watchers)).toHaveLength(1)
  })

  it('prunes generated/VCS/archive full segments with or without chokidar stats', () => {
    watcher.watch(win, '/project')
    const ignored = mocks.watch.mock.calls[0][1].ignored as (
      pathname: string,
      info?: { isDirectory: () => boolean }
    ) => boolean
    for (const segment of [
      'node_modules',
      '.git',
      '.svn',
      '.hg',
      'target',
      'dist',
      '__pycache__',
      'app.asar'
    ]) {
      for (const pathname of [
        segment,
        `/project/${segment}`,
        `/project/${segment}/note.md`,
        `C:\\project\\${segment}\\note.md`
      ]) {
        expect(WATCHER_IGNORED_SEGMENTS.test(pathname), pathname).toBe(true)
        expect(ignored(pathname), pathname).toBe(true)
        expect(ignored(pathname, { isDirectory: () => true }), pathname).toBe(true)
      }
    }
    for (const segment of [
      'target-practice.md',
      'targets',
      'dist-notes',
      'node_modules-notes',
      '.github',
      '.git-notes',
      'app.asar.md',
      'app.asar.unpacked',
      'notes.asar-backup'
    ]) {
      const pathname = `/project/${segment}`
      expect(WATCHER_IGNORED_SEGMENTS.test(pathname), pathname).toBe(false)
      expect(ignored(pathname), pathname).toBe(false)
      expect(ignored(pathname, { isDirectory: () => true }), pathname).toBe(false)
    }
    expect(ignored('/project/notes/note.md', { isDirectory: () => false })).toBe(false)
    expect(ignored('/project/private/note.md', { isDirectory: () => false })).toBe(true)
    expect(ignored('/project/private/folder', { isDirectory: () => true })).toBe(true)
    expect(ignored('/project/image.png', { isDirectory: () => false })).toBe(true)
  })
})
