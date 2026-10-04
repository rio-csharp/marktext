// @vitest-environment node
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
}))

import { registerFsHandlers } from 'main_renderer/ipc/fs'

let directory: string
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'marktext-fs-ipc-'))
  registerFsHandlers()
})
afterAll(async () => fs.remove(directory))

describe('filesystem IPC predicates', () => {
  it('inspects the entry itself, so symlinks are not files or directories', async () => {
    const file = path.join(directory, 'file')
    const subdirectory = path.join(directory, 'directory')
    const fileLink = path.join(directory, 'file-link')
    const directoryLink = path.join(directory, 'directory-link')
    await fs.writeFile(file, 'content')
    await fs.mkdir(subdirectory)
    try {
      await fs.symlink(file, fileLink)
      await fs.symlink(subdirectory, directoryLink, 'junction')
    } catch {
      return
    }

    const isFile = handlers.get('mt::fs::is-file')!
    const isDirectory = handlers.get('mt::fs::is-directory')!
    expect(await isFile({}, file)).toBe(true)
    expect(await isFile({}, fileLink)).toBe(false)
    expect(await isDirectory({}, subdirectory)).toBe(true)
    expect(await isDirectory({}, directoryLink)).toBe(false)
  })

  it('returns false for missing paths and filesystem errors', async () => {
    const missing = path.join(directory, 'missing')
    expect(await handlers.get('mt::fs::is-file')!({}, missing)).toBe(false)
    expect(await handlers.get('mt::fs::is-directory')!({}, missing)).toBe(false)
  })

  it('follows symlinks for executable files and requires X_OK access', async () => {
    const file = path.join(directory, 'executable')
    const link = path.join(directory, 'executable-link')
    await fs.writeFile(file, '#!/bin/sh\n', { mode: 0o755 })
    try {
      await fs.symlink(file, link)
    } catch {
      return
    }
    const isExecutable = handlers.get('mt::fs::is-executable')!
    expect(await isExecutable({}, file)).toBe(true)
    expect(await isExecutable({}, link)).toBe(true)
    expect(await isExecutable({}, directory)).toBe(false)
    expect(await isExecutable({}, path.join(directory, 'missing'))).toBe(false)
  })
})
