import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { ipcMain, type WebContents } from 'electron'
import log from 'electron-log'
import { rgPath as bundledRgPath } from '@vscode/ripgrep'

const resolveRgPath = (): string => {
  if (process.env.MARKTEXT_RIPGREP_PATH) return process.env.MARKTEXT_RIPGREP_PATH
  return bundledRgPath.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
}

interface ActiveSearch {
  sender: WebContents
  cancel: (notify?: boolean) => void
}

const activeSearches = new Map<string, ActiveSearch>()

const sendIfAlive = (
  sender: WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): void => {
  try {
    if (sender && !sender.isDestroyed()) sender.send(channel, ...args)
  } catch {
    /* sender destroyed mid-send */
  }
}

const MATCH_BATCH_SIZE = 100
const MATCH_BATCH_WINDOW_MS = 16

interface MatchBatcher {
  queue: (payload: unknown) => void
  flush: () => void
  dispose: () => void
}

const createMatchBatcher = (
  sender: WebContents,
  searchId: string,
  getNum: () => number,
  isActive: () => boolean
): MatchBatcher => {
  const queue: unknown[] = []
  let flushTimer: NodeJS.Timeout | null = null
  let disposed = false

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (disposed || queue.length === 0) return
    if (!isActive()) {
      queue.length = 0
      return
    }
    const batch = queue.splice(0, queue.length)
    sendIfAlive(sender, 'mt::rg::progress', { searchId, num: getNum() })
    sendIfAlive(sender, 'mt::rg::match', { searchId, payload: batch })
  }

  return {
    queue: (payload: unknown): void => {
      if (disposed || !isActive()) return
      queue.push(payload)
      if (queue.length >= MATCH_BATCH_SIZE) flush()
      else if (!flushTimer) flushTimer = setTimeout(flush, MATCH_BATCH_WINDOW_MS)
    },
    flush,
    dispose: (): void => {
      disposed = true
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      queue.length = 0
    }
  }
}

const createSearch = (sender: WebContents, searchId: string, directoryCount: number) => {
  const children: ChildProcess[] = []
  let finished = false
  let pendingPaths = 0
  let pendingDirs = directoryCount

  const isActive = (): boolean => !finished && activeSearches.get(searchId) === entry
  const batcher = createMatchBatcher(sender, searchId, () => pendingPaths, isActive)

  const release = (): void => {
    finished = true
    batcher.dispose()
    sender.removeListener('destroyed', onDestroyed)
    // Late callbacks from a replaced search must not remove its successor.
    if (activeSearches.get(searchId) === entry) activeSearches.delete(searchId)
  }

  const killChildren = (): void => {
    for (const child of children) {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
    }
  }

  const cancel = (notify = true): void => {
    if (finished) return
    // Killing can trigger close callbacks, so invalidate the search first.
    release()
    killChildren()
    if (notify) sendIfAlive(sender, 'mt::rg::cancelled', { searchId })
  }
  const onDestroyed = (): void => cancel(false)
  const entry: ActiveSearch = { sender, cancel }
  activeSearches.set(searchId, entry)
  sender.once('destroyed', onDestroyed)
  if (sender.isDestroyed()) cancel(false)

  const finishIfDone = (err?: unknown): void => {
    if (!isActive() || (pendingDirs > 0 && !err)) return
    // The renderer must receive the last batch before the terminal event.
    batcher.flush()
    if (!isActive()) return
    release()
    if (err) {
      killChildren()
      sendIfAlive(sender, 'mt::rg::error', {
        searchId,
        error: err instanceof Error ? err.message : String(err)
      })
    } else {
      sendIfAlive(sender, 'mt::rg::done', { searchId })
    }
  }

  return {
    children,
    isActive,
    finishIfDone,
    queue: (payload: unknown): void => {
      if (!isActive()) return
      pendingPaths++
      batcher.queue(payload)
    },
    close: (): void => {
      if (!isActive()) return
      pendingDirs--
      finishIfDone()
    }
  }
}

interface TextInput {
  text?: string
  bytes?: string
}

const getText = (input: TextInput): string =>
  'text' in input && input.text !== undefined
    ? input.text
    : Buffer.from(input.bytes ?? '', 'base64').toString()

const cleanResultLine = (lineText: TextInput): string => {
  const text = getText(lineText)
  return text[text.length - 1] === '\n' ? text.slice(0, -1) : text
}

const getPositionFromColumn = (lines: string[], column: number): [number, number] => {
  let currentLength = 0
  let currentLine = 0
  let previousLength = 0
  while (column >= currentLength) {
    previousLength = currentLength
    currentLength += lines[currentLine].length + 1
    currentLine++
  }
  return [currentLine - 1, column - previousLength]
}

interface RgSubmatch {
  start: number
  end: number
  match: TextInput
}

interface RgMatchData {
  lines: TextInput
  submatches: RgSubmatch[]
  line_number: number
  path: TextInput
}

interface RgMatch {
  matchText: string
  lineText: string
  range: [[number, number], [number, number]]
  leadingContextLines: unknown[]
  trailingContextLines: unknown[]
}

const processUnicodeMatch = (match: RgMatchData): void => {
  const text = getText(match.lines)
  if (text.length === Buffer.byteLength(text)) return
  let remainingBuffer = Buffer.from(text)
  let currentLength = 0
  let previousPosition = 0
  const convertPosition = (position: number): number => {
    const currentBuffer = remainingBuffer.slice(0, position - previousPosition)
    currentLength = currentBuffer.toString().length + currentLength
    remainingBuffer = remainingBuffer.slice(position - previousPosition)
    previousPosition = position
    return currentLength
  }
  for (const submatch of match.submatches) {
    submatch.start = convertPosition(submatch.start)
    submatch.end = convertPosition(submatch.end)
  }
}

const processSubmatch = (
  submatch: RgSubmatch,
  lineText: string,
  offsetRow: number
): { range: [[number, number], [number, number]]; lineText: string } => {
  const lineParts = lineText.split('\n')
  const start = getPositionFromColumn(lineParts, submatch.start)
  const end = getPositionFromColumn(lineParts, submatch.end)
  for (let i = start[0]; i > 0; i--) lineParts.shift()
  while (end[0] < lineParts.length - 1) lineParts.pop()
  start[0] += offsetRow
  end[0] += offsetRow
  return {
    range: [start, end],
    lineText: cleanResultLine({ text: lineParts.join('\n') })
  }
}

const prepareGlobs = (
  globs: string[] | undefined,
  projectRootPath: string,
  sep?: string
): string[] => {
  const output: string[] = []
  for (let pattern of globs || []) {
    pattern = pattern.replace(new RegExp(`\\${sep || path.sep}`, 'g'), '/')
    if (pattern.length === 0) continue
    const projectName = path.basename(projectRootPath)
    if (pattern === projectName) {
      output.push('**/*')
      continue
    }
    if (pattern.startsWith(projectName + '/')) {
      pattern = pattern.slice(projectName.length + 1)
    }
    if (pattern.endsWith('/')) pattern = pattern.slice(0, -1)
    pattern = pattern.startsWith('**/') ? pattern : `**/${pattern}`
    output.push(pattern)
    output.push(pattern.endsWith('/**') ? pattern : `${pattern}/**`)
  }
  return output
}

const prepareRegexp = (regexpStr: string): string => {
  if (regexpStr === '--') return '\\-\\-'
  return regexpStr.replace(/\\\//g, '/')
}

const isMultilineRegexp = (regexpStr: string): boolean => regexpStr.includes('\\n')

interface SearchOptions {
  isRegexp?: boolean
  isCaseSensitive?: boolean
  isWholeWord?: boolean
  followSymlinks?: boolean
  maxFileSize?: number | string
  includeHidden?: boolean
  noIgnore?: boolean
  leadingContextLineCount?: number
  trailingContextLineCount?: number
  inclusions?: string[]
  exclusions?: string[]
}

const startTextSearch = (
  sender: WebContents,
  searchId: string,
  directories: string[],
  pattern: string,
  options: SearchOptions
): void => {
  const rgPath = resolveRgPath()
  const search = createSearch(sender, searchId, directories.length)
  search.finishIfDone()

  for (const directoryPath of directories) {
    if (!search.isActive()) break
    let regexpStr: string | null = null
    let textPattern: string | null = null
    const args = ['--json']
    if (options.isRegexp) {
      regexpStr = prepareRegexp(pattern)
      args.push('--regexp', regexpStr)
    } else {
      args.push('--fixed-strings')
      textPattern = pattern
    }
    if (regexpStr && isMultilineRegexp(regexpStr)) args.push('--multiline')
    if (options.isCaseSensitive) args.push('--case-sensitive')
    else args.push('--ignore-case')
    if (options.isWholeWord) args.push('--word-regexp')
    if (options.followSymlinks) args.push('--follow')
    if (options.maxFileSize) args.push('--max-filesize', options.maxFileSize + '')
    if (options.includeHidden) args.push('--hidden')
    if (options.noIgnore) args.push('--no-ignore')
    if (options.leadingContextLineCount) {
      args.push('--before-context', String(options.leadingContextLineCount))
    }
    if (options.trailingContextLineCount) {
      args.push('--after-context', String(options.trailingContextLineCount))
    }
    for (const inclusion of prepareGlobs(options.inclusions, directoryPath)) {
      args.push('--iglob', inclusion)
    }
    for (const exclusion of prepareGlobs(options.exclusions, directoryPath)) {
      args.push('--iglob', '!' + exclusion)
    }
    args.push('--')
    if (textPattern) args.push(textPattern)
    args.push(directoryPath)

    let child: ChildProcess
    try {
      child = spawn(rgPath, args, { cwd: directoryPath, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      search.finishIfDone(err)
      return
    }
    search.children.push(child)

    let buffer = ''
    let bufferError = ''
    let pendingEvent: { filePath: string; matches: RgMatch[] } | null = null
    let pendingLeadingContext: unknown[] = []
    let pendingTrailingContexts: Set<unknown[]> = new Set()

    child.on('close', (code) => {
      if (!search.isActive()) return
      if (code !== null && code > 1 && bufferError) {
        log.warn('Ripgrep finished with errors (exit code ' + code + '):', bufferError)
      }
      if (buffer) {
        try {
          const message = JSON.parse(buffer)
          if (message.type === 'end' && pendingEvent) search.queue(pendingEvent)
        } catch {
          /* parse error */
        }
      }
      search.close()
    })
    child.on('error', (err) => search.finishIfDone(err))
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (search.isActive()) bufferError += chunk
    })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (!search.isActive()) return
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!search.isActive()) break
        if (!line) continue
        try {
          const message = JSON.parse(line)
          if (message.type === 'begin') {
            pendingEvent = { filePath: getText(message.data.path), matches: [] }
            pendingLeadingContext = []
            pendingTrailingContexts = new Set()
          } else if (message.type === 'match') {
            const trailingContextLines: unknown[] = []
            pendingTrailingContexts.add(trailingContextLines)
            processUnicodeMatch(message.data)
            for (const submatch of message.data.submatches) {
              const { lineText, range } = processSubmatch(
                submatch,
                getText(message.data.lines),
                message.data.line_number - 1
              )
              pendingEvent?.matches.push({
                matchText: getText(submatch.match),
                lineText,
                range,
                leadingContextLines: [...pendingLeadingContext],
                trailingContextLines
              })
            }
          } else if (message.type === 'end') {
            search.queue(pendingEvent)
            pendingEvent = null
          }
        } catch (err) {
          log.warn('Failed to parse ripgrep output line:', line, err)
        }
      }
    })
  }
}

const startFileSearch = (
  sender: WebContents,
  searchId: string,
  directories: string[],
  options: SearchOptions
): void => {
  const rgPath = resolveRgPath()
  const search = createSearch(sender, searchId, directories.length)
  search.finishIfDone()

  for (const directoryPath of directories) {
    if (!search.isActive()) break
    const args = ['--files']
    if (options.followSymlinks) args.push('--follow')
    if (options.includeHidden) args.push('--hidden')
    if (options.noIgnore) args.push('--no-ignore')
    for (const inclusion of prepareGlobs(options.inclusions, directoryPath)) {
      args.push('--iglob', inclusion)
    }
    args.push('--')
    args.push(directoryPath)

    let child: ChildProcess
    try {
      child = spawn(rgPath, args, { cwd: directoryPath, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      search.finishIfDone(err)
      return
    }
    search.children.push(child)

    let buffer = ''
    let bufferError = ''
    child.on('close', (code) => {
      if (!search.isActive()) return
      if (code !== null && code > 1) {
        search.finishIfDone(new Error(bufferError))
        return
      }
      search.close()
    })
    child.on('error', (err) => search.finishIfDone(err))
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (search.isActive()) bufferError += chunk
    })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (!search.isActive()) return
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!search.isActive()) break
        search.queue(line)
      }
    })
  }
}

interface RipgrepRequest {
  searchId: string
  mode: 'files' | 'text'
  directories: string[]
  pattern: string
  options: SearchOptions
}

export const registerRipgrepHandlers = (): void => {
  ipcMain.handle('mt::rg::start', (event, req: RipgrepRequest) => {
    const { searchId, mode, directories, pattern, options } = req
    activeSearches.get(searchId)?.cancel()
    if (mode === 'files') startFileSearch(event.sender, searchId, directories, options || {})
    else startTextSearch(event.sender, searchId, directories, pattern, options || {})
    return true
  })
  ipcMain.on('mt::rg::cancel', (event, searchId: string) => {
    const entry = activeSearches.get(searchId)
    if (entry?.sender === event.sender) entry.cancel()
  })
}
