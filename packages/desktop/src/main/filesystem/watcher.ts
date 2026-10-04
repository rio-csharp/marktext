import path from 'path'
import fsPromises from 'fs/promises'
import log from 'electron-log'
import chokidar, { type FSWatcher } from 'chokidar'
import { exists } from 'common/filesystem'
import { hasMarkdownExtension, checkPathExcludePattern } from 'common/filesystem/paths'
import { getUniqueId } from '../utils'
import { loadMarkdownFile } from '../filesystem/markdown'
import { isLinux, isOsx } from '../config'
import type { Stats } from 'fs'
import type { BrowserWindow } from 'electron'
import type { LineEnding } from '@shared/types/files'
import type Preference from '../preferences'

// TODO(refactor): Please see GH#1035.

export const WATCHER_STABILITY_THRESHOLD = 1000
export const WATCHER_STABILITY_POLL_INTERVAL = 150

// Full segments avoid hiding notes such as target-practice.md or app.asar.md.
export const WATCHER_IGNORED_SEGMENTS =
  /(?:^|[/\\])(?:node_modules|\.git|\.svn|\.hg|target|dist|__pycache__|[^/\\]+\.asar)(?=$|[/\\])/

const INITIAL_REPLAY_CHUNK_SIZE = 500

const EVENT_NAME = {
  dir: 'mt::update-object-tree' as const,
  file: 'mt::update-file' as const
}

type WatchType = 'dir' | 'file'
type SendEvent = (channel: string, payload: unknown) => void
type TreeEvent = {
  event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  pathname: string
  stats?: Stats
}

export const isUncPath = (pathname: string): boolean =>
  /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(pathname)

interface IgnoreEntry {
  windowId: number
  pathname: string
  duration: number
  start: Date
}

interface WatcherEntry {
  win: BrowserWindow
  watcher: FSWatcher
  pathname: string
  type: WatchType
  close: () => void
}

const add = async(
  send: SendEvent,
  pathname: string,
  type: WatchType,
  endOfLine: LineEnding,
  autoGuessEncoding: boolean,
  trimTrailingNewline: number,
  autoNormalizeLineEndings: boolean,
  eventStats?: Stats
): Promise<void> => {
  if (!hasMarkdownExtension(pathname)) return

  let stats: Stats
  try {
    stats = eventStats ?? (await fsPromises.stat(pathname))
  } catch (err) {
    if (type === 'file') {
      sendIoError(send, err)
    }
    return
  }
  const birthTime = stats.birthtime
  const mtimeMs = stats.mtimeMs
  const isMarkdown = hasMarkdownExtension(pathname)
  const file: {
    pathname: string
    name: string
    isFile: boolean
    isDirectory: boolean
    birthTime: Date
    mtimeMs: number
    isMarkdown: boolean
    data?: Awaited<ReturnType<typeof loadMarkdownFile>>
  } = {
    pathname,
    name: path.basename(pathname),
    isFile: true,
    isDirectory: false,
    birthTime,
    mtimeMs,
    isMarkdown
  }
  // Sidebar discovery must not read every document in the watched tree.
  if (type === 'file') {
    try {
      file.data = await loadMarkdownFile(
        pathname,
        endOfLine,
        autoGuessEncoding,
        trimTrailingNewline,
        autoNormalizeLineEndings
      )
    } catch (err) {
      sendIoError(send, err)
      return
    }
  }
  send(EVENT_NAME[type], {
    type: 'add',
    change: file
  })
}

const sendIoError = (send: SendEvent, err: unknown): void => {
  send('mt::show-notification', {
    title: 'Watcher I/O error',
    type: 'error',
    message: err instanceof Error ? err.message : String(err)
  })
}

const unlink = (send: SendEvent, pathname: string, type: WatchType): void => {
  const file = { pathname }
  send(EVENT_NAME[type], {
    type: 'unlink',
    change: file
  })
}

const change = async(
  send: SendEvent,
  pathname: string,
  type: WatchType,
  endOfLine: LineEnding,
  autoGuessEncoding: boolean,
  trimTrailingNewline: number,
  autoNormalizeLineEndings: boolean,
  eventStats?: Stats
): Promise<void> => {
  if (type === 'dir') {
    try {
      const stats = eventStats ?? (await fsPromises.stat(pathname))
      send('mt::update-object-tree', {
        type: 'change',
        change: { pathname, mtimeMs: stats.mtimeMs }
      })
    } catch {
      // File may have been deleted between the event and the stat; ignore.
    }
    return
  }

  const isMarkdown = hasMarkdownExtension(pathname)
  if (isMarkdown) {
    try {
      const [data, stats] = await Promise.all([
        loadMarkdownFile(
          pathname,
          endOfLine,
          autoGuessEncoding,
          trimTrailingNewline,
          autoNormalizeLineEndings
        ),
        eventStats ?? fsPromises.stat(pathname)
      ])
      const file = { pathname, data, mtimeMs: stats.mtimeMs }
      send('mt::update-file', {
        type: 'change',
        change: file
      })
    } catch (err) {
      sendIoError(send, err)
    }
  }
}

const addDir = (send: SendEvent, pathname: string, type: WatchType): void => {
  if (type === 'file') return

  const directory = {
    pathname,
    name: path.basename(pathname),
    isCollapsed: true,
    isDirectory: true,
    isFile: false,
    isMarkdown: false,
    folders: [],
    files: []
  }

  send('mt::update-object-tree', {
    type: 'addDir',
    change: directory
  })
}

const unlinkDir = (send: SendEvent, pathname: string, type: WatchType): void => {
  if (type === 'file') return

  const directory = { pathname }
  send('mt::update-object-tree', {
    type: 'unlinkDir',
    change: directory
  })
}

class Watcher {
  private _preferences: Preference
  private _ignoreChangeEvents: IgnoreEntry[]
  watchers: Record<string, WatcherEntry>

  constructor(preferences: Preference) {
    this._preferences = preferences
    this._ignoreChangeEvents = []
    this.watchers = {}
  }

  watch(win: BrowserWindow, watchPath: string, type: WatchType = 'dir'): () => void {
    const usePolling =
      isOsx || isUncPath(watchPath) ? true : this._preferences.getItem<boolean>('watcherUsePolling')

    const id = getUniqueId()

    const watcher = chokidar.watch(watchPath, {
      ignored: (pathname: string, fileInfo?: { isDirectory: () => boolean }) => {
        if (!fileInfo) {
          return WATCHER_IGNORED_SEGMENTS.test(pathname)
        }

        if (WATCHER_IGNORED_SEGMENTS.test(pathname)) {
          return true
        }

        if (
          checkPathExcludePattern(
            pathname,
            this._preferences.getItem<readonly string[]>('treePathExcludePatterns')
          )
        ) {
          return true
        }
        if (fileInfo.isDirectory()) {
          return false
        }
        return !hasMarkdownExtension(pathname)
      },
      ignoreInitial: type === 'file',
      persistent: true,
      ignorePermissionErrors: true,

      depth: type === 'file' ? (isOsx ? 1 : 0) : undefined,

      // Defer events until writes settle only for the file watcher, which
      // reloads file CONTENT on change and would otherwise read a partial file
      // (GH#1043). The directory watcher just lists nodes and re-sorts by mtime,
      // so deferring its `add` events only made new files appear in the sidebar
      // ~1s late (GH#3955).
      ...(type === 'file'
        ? {
          awaitWriteFinish: {
            stabilityThreshold: WATCHER_STABILITY_THRESHOLD,
            pollInterval: WATCHER_STABILITY_POLL_INTERVAL
          }
        }
        : {}),

      usePolling
      // chokidar's `ignored` callback signature varies between versions; this options
      // bag works at runtime but defies the bundled type.
    } as unknown as Parameters<typeof chokidar.watch>[1])

    let disposed = false
    let enospcReached = false
    let renameTimer: NodeJS.Timeout | null = null

    const send: SendEvent = (channel, payload) => {
      // Closing a watcher cannot cancel stat/content reads already in flight.
      if (!disposed) {
        win.webContents.send(channel, payload)
      }
    }

    const processEvent = async({ event, pathname, stats }: TreeEvent): Promise<void> => {
      if (disposed) return
      if (event === 'unlink') {
        unlink(send, pathname, type)
      } else if (event === 'addDir') {
        addDir(send, pathname, type)
      } else if (event === 'unlinkDir') {
        unlinkDir(send, pathname, type)
      } else {
        if (
          type === 'file' &&
          (await this._shouldIgnoreEvent(win.id, pathname, type, usePolling, stats))
        ) {
          return
        }
        if (disposed) return

        const eol = type === 'file' ? (this._preferences.getPreferredEol() as LineEnding) : 'lf'
        const {
          autoGuessEncoding = true,
          trimTrailingNewline = 2,
          autoNormalizeLineEndings = false
        } = type === 'file' ? this._preferences.getAll() : {}
        await (event === 'add' ? add : change)(
          send,
          pathname,
          type,
          eol,
          autoGuessEncoding,
          trimTrailingNewline,
          autoNormalizeLineEndings,
          stats
        )
      }
    }

    // Queue events before doing I/O: an unlink must not overtake an awaited add.
    const treeEvents: TreeEvent[] = []
    let treeEventIndex = 0
    let scanReady = type === 'file'
    let drainingTreeEvents = false
    let replayTimer: NodeJS.Immediate | null = null

    const drainTreeEvents = async(): Promise<void> => {
      replayTimer = null
      for (
        let count = 0;
        count < INITIAL_REPLAY_CHUNK_SIZE && treeEventIndex < treeEvents.length;
        count++
      ) {
        if (disposed) return
        const treeEvent = treeEvents[treeEventIndex++]
        try {
          await processEvent(treeEvent)
        } catch (error) {
          if (!disposed) log.error('Error while processing directory watcher event:', error)
        }
      }
      if (disposed) return
      if (treeEventIndex < treeEvents.length) {
        // A microtask alone would keep a large replay ahead of main-process I/O.
        replayTimer = setImmediate(() => {
          drainTreeEvents().catch((error: unknown) =>
            log.error('Error while draining watcher events:', error)
          )
        })
      } else {
        treeEvents.length = 0
        treeEventIndex = 0
        drainingTreeEvents = false
      }
    }

    const scheduleTreeEvents = (): void => {
      if (disposed || !scanReady || drainingTreeEvents) return
      drainingTreeEvents = true
      replayTimer = setImmediate(() => {
        drainTreeEvents().catch((error: unknown) =>
          log.error('Error while draining watcher events:', error)
        )
      })
    }

    const handleEvent = (
      event: TreeEvent['event'],
      pathname: string,
      stats?: Stats
    ): Promise<void> | void => {
      if (disposed) return
      if (type === 'file') {
        return processEvent({ event, pathname, stats })
      }
      treeEvents.push({ event, pathname, stats })
      scheduleTreeEvents()
    }

    watcher
      .on('ready', () => {
        scanReady = true
        if (type === 'dir') scheduleTreeEvents()
      })
      .on('add', (pathname: string, stats?: Stats) => handleEvent('add', pathname, stats))
      .on('change', (pathname: string, stats?: Stats) => handleEvent('change', pathname, stats))
      .on('unlink', (pathname: string) => handleEvent('unlink', pathname))
      .on('addDir', (pathname: string) => handleEvent('addDir', pathname))
      .on('unlinkDir', (pathname: string) => handleEvent('unlinkDir', pathname))
      .on('raw', (event: string, subpath: string, details: unknown) => {
        if (disposed) return
        if (globalThis.MARKTEXT_DEBUG_VERBOSE >= 3) {
          console.log('watcher: ', event, subpath, details)
        }

        // Fix atomic rename on Linux (chokidar#591).
        if (isLinux && type === 'file' && event === 'rename') {
          if (renameTimer) {
            clearTimeout(renameTimer)
          }
          renameTimer = setTimeout(async() => {
            renameTimer = null
            if (disposed) {
              return
            }

            const fileExists = await exists(watchPath)
            if (!disposed && fileExists) {
              watcher.unwatch(watchPath)
              watcher.add(watchPath)
            }
          }, 150)
        }
      })
      .on('error', (error: unknown) => {
        if (disposed) return
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOSPC') {
          if (!enospcReached) {
            enospcReached = true
            log.warn('inotify limit reached: Too many file descriptors are opened.')

            send('mt::show-notification', {
              title: 'inotify limit reached',
              type: 'warning',
              message:
                'Cannot watch all files and file changes because too many file descriptors are opened.'
            })
          }
        } else {
          log.error('Error while watching files:', error)
        }
      })

    const closeFn = (): void => {
      if (disposed) return
      disposed = true
      treeEvents.length = 0
      if (replayTimer) {
        clearImmediate(replayTimer)
        replayTimer = null
      }
      if (this.watchers[id]) {
        delete this.watchers[id]
      }
      if (renameTimer) {
        clearTimeout(renameTimer)
        renameTimer = null
      }
      watcher.close()
    }

    this.watchers[id] = {
      win,
      watcher,
      pathname: watchPath,
      type,
      close: closeFn
    }

    return closeFn
  }

  unwatch(win: BrowserWindow, watchPath: string, type: WatchType = 'dir'): void {
    for (const id of Object.keys(this.watchers)) {
      const w = this.watchers[id]
      if (w.win === win && w.pathname === watchPath && w.type === type) {
        w.close()
        break
      }
    }
  }

  unwatchByWindowId(windowId: number): void {
    for (const id of Object.keys(this.watchers)) {
      const w = this.watchers[id]
      if (w.win.id === windowId) {
        w.close()
      }
    }
  }

  close(): void {
    Object.keys(this.watchers).forEach((id) => this.watchers[id].close())
    this.watchers = {}
    this._ignoreChangeEvents = []
  }

  /**
   * Ignore the next changed event within a certain time for the current file
   * and window. Only valid for files and "add"/"change" events.
   */
  ignoreChangedEvent(
    windowId: number,
    pathname: string,
    duration: number = WATCHER_STABILITY_THRESHOLD + WATCHER_STABILITY_POLL_INTERVAL * 2
  ): void {
    this._ignoreChangeEvents.push({ windowId, pathname, duration, start: new Date() })
  }

  /**
   * Check whether we should ignore the current event because the file may be
   * changed from MarkText itself.
   */
  async _shouldIgnoreEvent(
    winId: number,
    pathname: string,
    type: WatchType,
    usePolling: boolean,
    eventStats?: Stats
  ): Promise<boolean> {
    if (type === 'file') {
      const { _ignoreChangeEvents } = this
      const currentTime = new Date()
      for (let i = 0; i < _ignoreChangeEvents.length; ++i) {
        const { windowId, pathname: pathToIgnore, start, duration } = _ignoreChangeEvents[i]
        if (windowId === winId && pathToIgnore === pathname) {
          _ignoreChangeEvents.splice(i, 1)
          --i

          // Modification origin is the editor and we should ignore the event.
          if (currentTime.getTime() - start.getTime() < duration) {
            return true
          }

          // Try to catch cloud drives that emit the change event not
          // immediately or re-sync the change (GH#3044).
          if (!usePolling) {
            try {
              const fileInfo = eventStats ?? (await fsPromises.stat(pathname))
              if (fileInfo.mtime.getTime() - start.getTime() < duration) {
                if (globalThis.MARKTEXT_DEBUG_VERBOSE >= 3) {
                  console.log(
                    `Ignoring file event after "stat": current="${currentTime.toISOString()}", start="${start.toISOString()}", file="${fileInfo.mtime.toISOString()}".`
                  )
                }
                return true
              }
            } catch (error) {
              console.error('Failed to "stat" file to determine modification time:', error)
            }
          }
        }
      }
    }
    return false
  }
}

export default Watcher
