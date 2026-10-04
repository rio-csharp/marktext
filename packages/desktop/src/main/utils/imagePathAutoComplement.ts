import fs from 'fs'
import fsPromises from 'fs/promises'
import { filter } from 'fuzzaldrin'
import log from 'electron-log'
import { IMAGE_EXTENSIONS } from 'common/filesystem/paths'
import { BLACK_LIST } from '../config'

// TODO(need::refactor): Refactor this file. Just return an array of directories and files without caching and watching?

interface DirOrImageEntry {
  file: string
  type: string
}

// Bound the caches: each entry pins an fs.watch descriptor, and an unbounded
// map grew forever as the user browsed directories. Map iteration order
// doubles as LRU order — entries are re-inserted on access.
const MAX_WATCHED_DIRECTORIES = 50

// TODO: rebuild cache @jocs
const IMAGE_PATH: Map<string, DirOrImageEntry[]> = new Map()
export const watchers: Map<string, fs.FSWatcher> = new Map()

const IMAGE_REG = new RegExp('(' + IMAGE_EXTENSIONS.join('|') + ')$', 'i')

const touchCacheEntry = (directory: string): void => {
  const entries = IMAGE_PATH.get(directory)
  if (entries) {
    IMAGE_PATH.delete(directory)
    IMAGE_PATH.set(directory, entries)
  }
  const watcher = watchers.get(directory)
  if (watcher) {
    watchers.delete(directory)
    watchers.set(directory, watcher)
  }
}

const evictLeastRecentlyUsed = (): void => {
  while (IMAGE_PATH.size > MAX_WATCHED_DIRECTORIES) {
    const oldest = IMAGE_PATH.keys().next().value
    if (oldest === undefined) break
    IMAGE_PATH.delete(oldest)
    const watcher = watchers.get(oldest)
    if (watcher) {
      watcher.close()
      watchers.delete(oldest)
    }
  }
}

export const closeAllWatchers = (): void => {
  for (const watcher of watchers.values()) {
    watcher.close()
  }
  watchers.clear()
  IMAGE_PATH.clear()
}

const filesHandler = async(
  directory: string,
  key?: string
): Promise<DirOrImageEntry[] | undefined> => {
  // withFileTypes carries the entry kind from the directory listing itself,
  // sparing a stat syscall per file.
  const dirents = await fsPromises.readdir(directory, { withFileTypes: true })
  const onlyDirAndImage: DirOrImageEntry[] = []
  for (const dirent of dirents) {
    let type = ''
    if (dirent.isDirectory()) {
      type = 'directory'
    } else if (dirent.isFile() && IMAGE_REG.test(dirent.name)) {
      type = 'image'
    }
    if (type && !(BLACK_LIST as readonly string[]).includes(dirent.name)) {
      onlyDirAndImage.push({ file: dirent.name, type })
    }
  }

  IMAGE_PATH.set(directory, onlyDirAndImage)
  evictLeastRecentlyUsed()
  if (key !== undefined) {
    return filter(onlyDirAndImage, key, {
      key: 'file'
    })
  }
  return undefined
}

const rebuild = (directory: string): void => {
  filesHandler(directory).catch((err) => {
    log.error('imagePathAutoComplement::rebuild:', err)
  })
}

const watchDirectory = (directory: string): void => {
  if (watchers.has(directory)) return // Do not duplicate watch the same directory
  try {
    const watcher = fs.watch(directory, (eventType, _filename) => {
      if (eventType === 'rename') {
        rebuild(directory)
      }
    })
    // Some directories become unwatchable after construction (network mounts
    // dropping, permission changes); swallow the error and stop watching
    // rather than leaking an uncaught exception into the main process.
    watcher.on('error', (err) => {
      log.error('imagePathAutoComplement::watchDirectory:', err)
      watcher.close()
      watchers.delete(directory)
    })
    watchers.set(directory, watcher)
  } catch (err) {
    // `fs.watch` throws synchronously for directories the OS can't watch —
    // e.g. UNC / \\wsl.localhost network paths on Windows (EISDIR). Image-path
    // auto-complete must degrade to "not watching" instead of crashing the
    // main process with an "Unexpected error" dialog (#3779).
    log.error('imagePathAutoComplement::watchDirectory:', err)
  }
}

export const searchFilesAndDir = async(
  directory: string,
  key: string
): Promise<DirOrImageEntry[]> => {
  const cached = IMAGE_PATH.get(directory)
  if (cached) {
    touchCacheEntry(directory)
    return filter(cached, key, { key: 'file' })
  }
  const result = (await filesHandler(directory, key)) ?? []
  watchDirectory(directory)
  return result
}
