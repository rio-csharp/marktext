import { EventEmitter } from 'events'
import fs, { type Dirent } from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeAllWatchers,
  searchFilesAndDir,
  watchers
} from 'main_renderer/utils/imagePathAutoComplement'

const mocks = vi.hoisted(() => ({
  read: vi.fn<(directory: string, options: { withFileTypes: true }) => Promise<Dirent[]>>(),
  error: vi.fn()
}))

vi.mock('fs/promises', () => ({ default: { readdir: mocks.read } }))
vi.mock('electron-log', () => ({ default: { error: mocks.error } }))

class FakeWatcher extends EventEmitter {
  close = vi.fn()
  constructor(readonly notify: (event: string) => void) {
    super()
  }
}

const createdWatchers: FakeWatcher[] = []
const dirent = (name: string, kind: 'directory' | 'file' | 'symlink' | 'other'): Dirent =>
  ({
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink'
  }) as Dirent

const image = (name: string): Dirent[] => [dirent(name, 'file')]
const result = (file: string): { file: string; type: string }[] => [{ file, type: 'image' }]

const deferred = () => {
  let settleResolve!: (entries: Dirent[]) => void
  let settleReject!: (error: Error) => void
  const promise = new Promise<Dirent[]>((resolve, reject) => {
    settleResolve = resolve
    settleReject = reject
  })
  return { promise, resolve: settleResolve, reject: settleReject }
}

const settle = async(): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  closeAllWatchers()
  mocks.read.mockReset().mockResolvedValue(image('default.png'))
  mocks.error.mockReset()
  createdWatchers.length = 0
  vi.spyOn(fs, 'watch').mockImplementation((_directory, optionsOrListener) => {
    const listener = optionsOrListener as fs.WatchListener<string>
    const watcher = new FakeWatcher((event) => listener(event as fs.WatchEventType, null))
    createdWatchers.push(watcher)
    return watcher as unknown as fs.FSWatcher
  })
})

afterEach(() => {
  closeAllWatchers()
  vi.restoreAllMocks()
})

describe('image-path autocomplete async listing', () => {
  it('uses dirents without synchronous per-entry stats and preserves lstat symlink exclusions', async() => {
    const lstat = vi.spyOn(fs, 'lstatSync')
    const stat = vi.spyOn(fs, 'statSync')
    const readdir = vi.spyOn(fs, 'readdirSync')
    mocks.read.mockResolvedValue([
      dirent('images', 'directory'),
      dirent('photo.PNG', 'file'),
      dirent('notes.txt', 'file'),
      dirent('$RECYCLE.BIN', 'directory'),
      dirent('linked-directory', 'symlink'),
      dirent('linked-image.png', 'symlink'),
      dirent('broken.png', 'symlink'),
      dirent('socket.png', 'other')
    ])

    expect(await searchFilesAndDir('/pictures', '')).toEqual([
      { file: 'images', type: 'directory' },
      { file: 'photo.PNG', type: 'image' }
    ])
    expect(mocks.read).toHaveBeenCalledWith('/pictures', { withFileTypes: true })
    expect(lstat).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
  })

  it('shares the initial scan while filtering each caller independently', async() => {
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const first = searchFilesAndDir('/pictures', 'a.p')
    const second = searchFilesAndDir('/pictures', 'b.j')
    expect(mocks.read).toHaveBeenCalledTimes(1)
    scan.resolve([dirent('a.png', 'file'), dirent('b.jpg', 'file')])

    expect(await first).toEqual(result('a.png'))
    expect(await second).toEqual(result('b.jpg'))
    expect(fs.watch).toHaveBeenCalledTimes(1)
    await searchFilesAndDir('/pictures', '')
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('shares initial failures, installs no watcher, and permits retry', async() => {
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const first = searchFilesAndDir('/pictures', '')
    const second = searchFilesAndDir('/pictures', '')
    const failure = new Error('unreadable')
    const checks = [expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)]
    scan.reject(failure)
    await Promise.all(checks)
    expect(fs.watch).not.toHaveBeenCalled()
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('default.png'))
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('keeps readable results when watcher construction throws', async() => {
    vi.mocked(fs.watch).mockImplementation(() => {
      throw new Error('unwatchable')
    })
    expect(await searchFilesAndDir('/network', '')).toEqual(result('default.png'))
    expect(watchers.size).toBe(0)
    await searchFilesAndDir('/network', '')
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(mocks.error).toHaveBeenCalledTimes(1)
  })
})

describe('image-path autocomplete LRU ownership', () => {
  it('caps watchers at 50 and evicts the least recently requested directory', async() => {
    for (let i = 0; i < 50; i++) await searchFilesAndDir(`/dir-${i}`, '')
    await searchFilesAndDir('/dir-0', '')
    await searchFilesAndDir('/dir-50', '')

    expect(watchers.size).toBe(50)
    expect(watchers.has('/dir-0')).toBe(true)
    expect(watchers.has('/dir-1')).toBe(false)
    expect(createdWatchers[1].close).toHaveBeenCalledTimes(1)
    expect(createdWatchers[0].close).not.toHaveBeenCalled()
    await searchFilesAndDir('/dir-1', '')
    expect(mocks.read).toHaveBeenCalledTimes(52)
    expect(watchers.size).toBe(50)
  })

  it('bounds cache entries even when no directory can be watched', async() => {
    vi.mocked(fs.watch).mockImplementation(() => {
      throw new Error('unwatchable')
    })
    for (let i = 0; i < 51; i++) await searchFilesAndDir(`/dir-${i}`, '')
    await searchFilesAndDir('/dir-1', '')
    expect(mocks.read).toHaveBeenCalledTimes(51)
    await searchFilesAndDir('/dir-0', '')
    expect(mocks.read).toHaveBeenCalledTimes(52)
    expect(watchers.size).toBe(0)
  })

  it('counts pending scans toward the bound and never watches an evicted initial result', async() => {
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const oldRequest = searchFilesAndDir('/old', '')
    for (let i = 0; i < 50; i++) await searchFilesAndDir(`/dir-${i}`, '')
    scan.resolve(image('old.png'))
    expect(await oldRequest).toEqual(result('old.png'))
    expect(watchers.size).toBe(50)
    expect(watchers.has('/old')).toBe(false)
    expect(fs.watch).toHaveBeenCalledTimes(50)
    expect(await searchFilesAndDir('/old', '')).toEqual(result('default.png'))
    expect(mocks.read).toHaveBeenCalledTimes(52)
  })

  it('does not let an evicted initial scan overwrite a newer scan of the same directory', async() => {
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const oldRequest = searchFilesAndDir('/old', '')
    for (let i = 0; i < 50; i++) await searchFilesAndDir(`/dir-${i}`, '')
    mocks.read.mockResolvedValueOnce(image('new.png'))
    await searchFilesAndDir('/old', '')
    const watcher = watchers.get('/old')
    scan.resolve(image('old.png'))
    expect(await oldRequest).toEqual(result('old.png'))
    expect(await searchFilesAndDir('/old', '')).toEqual(result('new.png'))
    expect(watchers.get('/old')).toBe(watcher)
    expect(watchers.size).toBe(50)
  })

  it('does not let a late initial rejection remove a newer directory state', async() => {
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const oldRequest = searchFilesAndDir('/pictures', '')
    closeAllWatchers()
    await searchFilesAndDir('/pictures', '')
    const check = expect(oldRequest).rejects.toThrow('old failure')
    scan.reject(new Error('old failure'))
    await check
    expect(watchers.has('/pictures')).toBe(true)
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('default.png'))
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })
})

describe('image-path autocomplete watcher refreshes', () => {
  it('ignores change events, serializes rename bursts, and retains a follow-up refresh', async() => {
    await searchFilesAndDir('/pictures', '')
    const watcher = createdWatchers[0]
    watcher.notify('change')
    expect(mocks.read).toHaveBeenCalledTimes(1)
    const first = deferred()
    const second = deferred()
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    watcher.notify('rename')
    watcher.notify('rename')
    watcher.notify('rename')
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('default.png'))
    first.resolve(image('first.png'))
    await settle()
    expect(mocks.read).toHaveBeenCalledTimes(3)
    second.resolve(image('latest.png'))
    await settle()
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('latest.png'))
    expect(mocks.read).toHaveBeenCalledTimes(3)
  })

  it('retains the cache after refresh failures and can refresh again', async() => {
    await searchFilesAndDir('/pictures', '')
    mocks.read.mockRejectedValueOnce(new Error('refresh failed'))
    createdWatchers[0].notify('rename')
    await settle()
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('default.png'))
    expect(mocks.error).toHaveBeenCalledTimes(1)
    mocks.read.mockResolvedValueOnce(image('new.png'))
    createdWatchers[0].notify('rename')
    await settle()
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('new.png'))
  })

  it('does not resurrect a refresh evicted while its read was pending', async() => {
    await searchFilesAndDir('/old', '')
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const watcher = createdWatchers[0]
    watcher.notify('rename')
    watcher.notify('rename')
    for (let i = 0; i < 50; i++) await searchFilesAndDir(`/dir-${i}`, '')
    scan.resolve(image('stale.png'))
    await settle()
    watcher.notify('rename')
    expect(mocks.read).toHaveBeenCalledTimes(52)
    expect(watchers.has('/old')).toBe(false)
    expect(watcher.close).toHaveBeenCalledTimes(1)
    expect(await searchFilesAndDir('/old', '')).toEqual(result('default.png'))
    expect(mocks.read).toHaveBeenCalledTimes(53)
  })

  it('does not promote background refreshes in request-based LRU order', async() => {
    for (let i = 0; i < 50; i++) await searchFilesAndDir(`/dir-${i}`, '')
    createdWatchers[0].notify('rename')
    await settle()
    await searchFilesAndDir('/dir-50', '')
    expect(watchers.has('/dir-0')).toBe(false)
    expect(watchers.size).toBe(50)
  })

  it('invalidates failed watchers and ignores their late callbacks after replacement', async() => {
    await searchFilesAndDir('/pictures', '')
    const oldWatcher = createdWatchers[0]
    oldWatcher.emit('error', new Error('disconnected'))
    expect(oldWatcher.close).toHaveBeenCalledTimes(1)
    expect(watchers.size).toBe(0)
    mocks.read.mockResolvedValueOnce(image('replacement.png'))
    await searchFilesAndDir('/pictures', '')
    const replacement = watchers.get('/pictures')
    oldWatcher.emit('error', new Error('late error'))
    oldWatcher.notify('rename')
    expect(watchers.get('/pictures')).toBe(replacement)
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('replacement.png'))
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })
})

describe('closeAllWatchers', () => {
  it('closes each watcher once, clears caches, and supports later fresh requests', async() => {
    await searchFilesAndDir('/one', '')
    await searchFilesAndDir('/two', '')
    closeAllWatchers()
    closeAllWatchers()
    expect(watchers.size).toBe(0)
    for (const watcher of createdWatchers) expect(watcher.close).toHaveBeenCalledTimes(1)
    await searchFilesAndDir('/one', '')
    expect(mocks.read).toHaveBeenCalledTimes(3)
    expect(watchers.size).toBe(1)
  })

  it('does not install caches or watchers when pending initial requests finish after disposal', async() => {
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const request = searchFilesAndDir('/pictures', '')
    closeAllWatchers()
    scan.resolve(image('old.png'))
    expect(await request).toEqual(result('old.png'))
    expect(watchers.size).toBe(0)
    expect(fs.watch).not.toHaveBeenCalled()
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('default.png'))
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('does not let a disposed refresh overwrite a replacement cache or schedule more reads', async() => {
    await searchFilesAndDir('/pictures', '')
    const scan = deferred()
    mocks.read.mockReturnValueOnce(scan.promise)
    const oldWatcher = createdWatchers[0]
    oldWatcher.notify('rename')
    oldWatcher.notify('rename')
    closeAllWatchers()
    mocks.read.mockResolvedValueOnce(image('fresh.png'))
    await searchFilesAndDir('/pictures', '')
    const replacement = watchers.get('/pictures')
    scan.resolve(image('stale.png'))
    await settle()
    expect(await searchFilesAndDir('/pictures', '')).toEqual(result('fresh.png'))
    expect(watchers.get('/pictures')).toBe(replacement)
    expect(mocks.read).toHaveBeenCalledTimes(3)
    expect(oldWatcher.close).toHaveBeenCalledTimes(1)
  })
})
