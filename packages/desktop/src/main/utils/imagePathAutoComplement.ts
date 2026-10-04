import fs from 'fs'
import fsPromises from 'fs/promises'
import { filter } from 'fuzzaldrin'
import log from 'electron-log'
import { IMAGE_EXTENSIONS } from 'common/filesystem/paths'
import { BLACK_LIST } from '../config'

interface DirOrImageEntry {
  file: string
  type: string
}

interface DirectoryState {
  entries?: DirOrImageEntry[]
  pending?: Promise<DirOrImageEntry[]>
  refreshing: boolean
  refreshRequested: boolean
}

// Pending scans count toward the limit too, so rapid browsing cannot pin unbounded state.
const MAX_WATCHED_DIRECTORIES = 50
const directories = new Map<string, DirectoryState>()
export const watchers: Map<string, fs.FSWatcher> = new Map()

const IMAGE_REG = new RegExp('(' + IMAGE_EXTENSIONS.join('|') + ')$', 'i')

const ownsDirectory = (directory: string, state: DirectoryState): boolean =>
  directories.get(directory) === state

const disposeDirectory = (directory: string): void => {
  directories.delete(directory)
  const watcher = watchers.get(directory)
  watchers.delete(directory)
  watcher?.close()
}

/** Clears cached listings and closes watchers; pending reads may finish only for their callers. */
export const closeAllWatchers = (): void => {
  directories.clear()
  const activeWatchers = [...watchers.values()]
  watchers.clear()
  for (const watcher of activeWatchers) {
    watcher.close()
  }
}

const touchDirectory = (directory: string, state: DirectoryState): void => {
  directories.delete(directory)
  directories.set(directory, state)
  const watcher = watchers.get(directory)
  if (watcher) {
    watchers.delete(directory)
    watchers.set(directory, watcher)
  }
}

const evictLeastRecentlyUsed = (): void => {
  while (directories.size > MAX_WATCHED_DIRECTORIES) {
    const oldest = directories.keys().next().value
    if (oldest === undefined) break
    disposeDirectory(oldest)
  }
}

const readDirectory = async (directory: string): Promise<DirOrImageEntry[]> => {
  const dirents = await fsPromises.readdir(directory, { withFileTypes: true })
  const entries: DirOrImageEntry[] = []
  for (const dirent of dirents) {
    if ((BLACK_LIST as readonly string[]).includes(dirent.name)) continue
    let type = ''
    // Like common/filesystem's lstat-based predicates, dirents exclude symbolic links.
    if (dirent.isDirectory()) {
      type = 'directory'
    } else if (dirent.isFile() && IMAGE_REG.test(dirent.name)) {
      type = 'image'
    }
    if (type) entries.push({ file: dirent.name, type })
  }
  return entries
}

const rebuild = async (directory: string, state: DirectoryState): Promise<void> => {
  state.refreshRequested = true
  if (state.refreshing) return
  state.refreshing = true
  try {
    // Serialize refreshes; an event during a read requires another snapshot, not an overlapping read.
    while (ownsDirectory(directory, state) && state.refreshRequested) {
      state.refreshRequested = false
      try {
        const entries = await readDirectory(directory)
        if (ownsDirectory(directory, state)) state.entries = entries
      } catch (err) {
        log.error('imagePathAutoComplement::rebuild:', err)
      }
    }
  } finally {
    state.refreshing = false
  }
}

const watchDirectory = (directory: string, state: DirectoryState): void => {
  if (!ownsDirectory(directory, state) || watchers.has(directory)) return
  try {
    const watcher = fs.watch(directory, (eventType, _filename) => {
      if (
        eventType === 'rename' &&
        ownsDirectory(directory, state) &&
        watchers.get(directory) === watcher
      ) {
        rebuild(directory, state)
      }
    })
    if (!ownsDirectory(directory, state)) {
      watcher.close()
      return
    }
    watchers.set(directory, watcher)
    watcher.on('error', (err) => {
      log.error('imagePathAutoComplement::watchDirectory:', err)
      if (ownsDirectory(directory, state) && watchers.get(directory) === watcher) {
        disposeDirectory(directory)
      }
    })
  } catch (err) {
    // UNC/WSL and network directories may be readable but unwatchable (#3779).
    log.error('imagePathAutoComplement::watchDirectory:', err)
  }
}

export const searchFilesAndDir = async (
  directory: string,
  key: string
): Promise<DirOrImageEntry[]> => {
  let state = directories.get(directory)
  if (state) {
    touchDirectory(directory, state)
  } else {
    state = { refreshing: false, refreshRequested: false }
    directories.set(directory, state)
    evictLeastRecentlyUsed()
    const initialState = state
    initialState.pending = readDirectory(directory).then(
      (entries) => {
        // Identity, rather than a path check, prevents an old read from replacing a newer cache entry.
        if (ownsDirectory(directory, initialState)) {
          initialState.entries = entries
          initialState.pending = undefined
          watchDirectory(directory, initialState)
        }
        return entries
      },
      (err) => {
        if (ownsDirectory(directory, initialState)) disposeDirectory(directory)
        throw err
      }
    )
  }
  const entries = state.entries ?? (await state.pending) ?? []
  return filter(entries, key, { key: 'file' })
}
