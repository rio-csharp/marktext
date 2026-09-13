import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Directory `add` events list sidebar nodes: they must carry metadata only
// (A), and build/VCS output directories must be pruned from the scan (C).
// A full content load per file blocked the main thread at startup on large
// folders (859+ markdown files: stat + read + encoding detection each).

type Handler = (...args: never[]) => unknown

const handlerStores: Array<Record<string, Handler>> = []
const watchMock = vi.fn()

function fakeWatcher(): Record<string, ReturnType<typeof vi.fn>> {
  const handlers: Record<string, Handler> = {}
  handlerStores.push(handlers)
  const api: Record<string, ReturnType<typeof vi.fn>> = {}
  api.on = vi.fn((event: string, fn: Handler) => {
    handlers[event] = fn
    return api
  })
  api.close = vi.fn()
  api.add = vi.fn()
  api.unwatch = vi.fn()
  return api
}

vi.mock('chokidar', () => ({
  default: {
    watch: (...args: unknown[]) => {
      watchMock(...args)
      return fakeWatcher()
    }
  }
}))

// Importing the watcher pulls in the markdown loader, whose encoding detection
// uses the native `ced` addon. Its bindings are built for Electron's ABI, not
// the plain-Node test runner, so stub it to keep this spec import-only.
vi.mock('ced', () => ({ default: () => 'UTF-8' }))

vi.mock('main_renderer/filesystem/markdown', () => ({
  loadMarkdownFile: vi.fn(async() => ({
    markdown: '# loaded\n',
    filename: 'note.md',
    encoding: { encoding: 'utf8', isBom: false }
  }))
}))

import Watcher, { WATCHER_IGNORED_SEGMENTS } from 'main_renderer/filesystem/watcher'
import { loadMarkdownFile } from 'main_renderer/filesystem/markdown'

describe('watcher directory add sends metadata only (A)', () => {
  // Real temp files so `stat` in `add()` succeeds without mocking `fs`.
  let dir = ''
  let mdFile = ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let win: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let preferences: any
  let watcher: Watcher

  beforeEach(() => {
    handlerStores.length = 0
    watchMock.mockClear()
    vi.clearAllMocks()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-watcher-'))
    mdFile = path.join(dir, 'note.md')
    fs.writeFileSync(mdFile, '# hello\n')
    win = { id: 1, webContents: { send: vi.fn() } }
    preferences = {
      getItem: vi.fn((key: string) => (key === 'treePathExcludePatterns' ? [] : false)),
      getPreferredEol: vi.fn(() => 'lf'),
      getAll: vi.fn(() => ({}))
    }
    watcher = new Watcher(preferences as never)
  })

  it('dir `add` does not read file content', async() => {
    watcher.watch(win as never, dir, 'dir')
    // NOTE: the watcher invokes `add()` as a floating promise, so wait for
    // the IPC send to land instead of only awaiting the event handler.
    await handlerStores[0]['add']!(mdFile as never)
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalledTimes(1))

    expect(loadMarkdownFile).not.toHaveBeenCalled()
    const [channel, payload] = win.webContents.send.mock.calls[0] as unknown as [
      string,
      { type: string; change: Record<string, unknown> }
    ]
    expect(channel).toBe('mt::update-object-tree')
    expect(payload.type).toBe('add')
    expect(payload.change['pathname']).toBe(mdFile)
    expect(payload.change['name']).toBe('note.md')
    expect(payload.change).not.toHaveProperty('data')
  })

  it('file `add` still loads content for external-change reload', async() => {
    watcher.watch(win as never, mdFile, 'file')
    await handlerStores[0]['add']!(mdFile as never)
    await vi.waitFor(() => expect(loadMarkdownFile).toHaveBeenCalledTimes(1))

    expect(loadMarkdownFile).toHaveBeenCalledWith(mdFile, 'lf', true, 2, false)
    const [channel, payload] = win.webContents.send.mock.calls[0] as unknown as [
      string,
      { type: string; change: Record<string, unknown> }
    ]
    expect(channel).toBe('mt::update-file')
    expect(payload.type).toBe('add')
    expect(payload.change['data']).toBeDefined()
  })
})

describe('watcher ignored segments (C)', () => {
  it('prunes dependency, build-output, and VCS directories', () => {
    const file = { isDirectory: () => false }
    const directory = { isDirectory: () => true }
    for (const p of [
      '/proj/target/debug/deps/a.rlib',
      '/proj/target',
      'C:\\proj\\target\\debug\\x',
      '/proj/dist/bundle.js',
      '/proj/node_modules/pkg/index.js',
      '/proj/.git/objects/ab',
      '/proj/__pycache__/mod.pyc'
    ]) {
      expect(WATCHER_IGNORED_SEGMENTS.test(p)).toBe(true)
    }
    // Both chokidar arities consult the pattern.
    const preferences = {
      getItem: vi.fn(() => []),
      getPreferredEol: vi.fn(() => 'lf'),
      getAll: vi.fn(() => ({}))
    }
    const w = new Watcher(preferences as never)
    const win = { id: 1, webContents: { send: vi.fn() } }
    w.watch(win as never, '/proj', 'dir')
    const ignored = watchMock.mock.calls[0][1].ignored as (
      p: string,
      fi?: { isDirectory: () => boolean }
    ) => boolean
    expect(ignored('/proj/target/debug/a.rlib')).toBe(true)
    expect(ignored('/proj/target', directory)).toBe(true)
    expect(ignored('/proj/.git/objects/ab', directory)).toBe(true)
    expect(ignored('/proj/notes/a.md', file)).toBe(false)
    expect(ignored('/proj/notes', directory)).toBe(false)
    expect(ignored('/proj/img.png', file)).toBe(true)
  })

  it('keeps similarly-named notes and folders', () => {
    const file = { isDirectory: () => false }
    const directory = { isDirectory: () => true }
    const preferences = {
      getItem: vi.fn(() => []),
      getPreferredEol: vi.fn(() => 'lf'),
      getAll: vi.fn(() => ({}))
    }
    const w = new Watcher(preferences as never)
    const win = { id: 1, webContents: { send: vi.fn() } }
    w.watch(win as never, '/proj', 'dir')
    const ignored = watchMock.mock.calls[0][1].ignored as (
      p: string,
      fi?: { isDirectory: () => boolean }
    ) => boolean
    // `target-practice.md` must not match the `target` segment rule.
    expect(ignored('/proj/notes/target-practice.md', file)).toBe(false)
    expect(ignored('/proj/targets/a.md', file)).toBe(false)
    expect(ignored('/proj/targets', directory)).toBe(false)
  })
})
