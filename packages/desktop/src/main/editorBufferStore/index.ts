import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import writeFileAtomic from 'write-file-atomic'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { TypedEmitter } from '@shared/types/typedEmitter'
import type BaseWindow from '../windows/base'

interface EditorBufferStorePaths {
  editorBufferStorePath: string
}

interface BufferStoreEntry {
  id: string
  filePath: string
}

interface BufferStoreContent {
  tabs: Array<{ isSaved: boolean; [key: string]: unknown }>
  [key: string]: unknown
}

interface EditorWindow {
  id: number
  win: BaseWindow
}

// No instance-level events emitted; kept as TypedEmitter for parity with the
// other main classes.
type EditorBufferStoreEvents = Record<string, unknown[]>

class EditorBufferStore extends TypedEmitter<EditorBufferStoreEvents> {
  editorBufferStorePath: string
  bufferStores: Record<string, BufferStoreEntry> | null
  serviceName: string
  encryptKeys: string[]
  private readonly writeQueues = new Map<string, Promise<void>>()
  private readonly writeErrors = new Map<string, unknown>()
  private readonly revisions = new Map<string, number>()

  constructor(paths: EditorBufferStorePaths) {
    super()

    const { editorBufferStorePath } = paths
    this.editorBufferStorePath = editorBufferStorePath
    // Object of paths to buffer stores. Buffer stores are NOT held in memory
    // for performance reasons — they are read from disk when needed and
    // written to disk when updated.
    this.bufferStores = null
    this.serviceName = 'marktext'
    this.encryptKeys = []

    this.init()
  }

  init(): void {
    if (!fs.existsSync(this.editorBufferStorePath)) {
      fs.mkdirSync(this.editorBufferStorePath, { recursive: true })
    }
    this._listenForIpcMain()
  }

  getAll(): Record<string, BufferStoreEntry> {
    return this.getAllBufferStores()
  }

  getAllBufferStores(): Record<string, BufferStoreEntry> {
    if (!this.bufferStores) {
      this.bufferStores = this.findEditorBufferStores(this.editorBufferStorePath)
    }

    return this.bufferStores
  }

  async clearBufferStoresWithAllSaved(): Promise<void> {
    const entries = Object.values(this.getAllBufferStores())
    await Promise.all(entries.map((entry) => this.removeSavedBuffer(entry)))
  }

  async handleClose(
    restoreBufferId: string | undefined,
    editorWindows: EditorWindow[]
  ): Promise<void> {
    // If > 1 window is present, and the window being closed has all files
    // saved, we can delete its saved buffer.

    if (!restoreBufferId) {
      console.warn('No restoreBufferId found for window, skipping buffer cleanup')
      return
    }

    if (!this.bufferStores) {
      this.bufferStores = this.findEditorBufferStores(this.editorBufferStorePath)
    }

    if (!(restoreBufferId in this.bufferStores)) {
      console.warn('No buffer store found for restoreBufferId, skipping buffer cleanup')
      return
    }

    const entry = this.bufferStores[restoreBufferId]
    await this.flushFile(entry.filePath)
    if (editorWindows.length > 1) {
      await this.removeSavedBuffer(entry)
    }
    await this.flushFile(entry.filePath)
  }

  private async removeSavedBuffer(entry: BufferStoreEntry): Promise<void> {
    const revision = this.revisions.get(entry.filePath)
    await this.enqueue(entry.filePath, async () => {
      if (this.writeErrors.has(entry.filePath)) return
      try {
        const buffer = await this.readBufferStoreFile(entry.filePath)
        if (
          buffer.tabs.every((tab) => tab.isSaved) &&
          this.revisions.get(entry.filePath) === revision
        ) {
          await fsPromises.unlink(entry.filePath)
          // An update queued during unlink will recreate the file; retain its index.
          if (this.revisions.get(entry.filePath) === revision) {
            delete this.bufferStores?.[entry.id]
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to clean up editor buffer:', error)
        }
      }
    })
  }

  private enqueue(filePath: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(filePath) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.writeQueues.set(filePath, next)
    const release = (): void => {
      if (this.writeQueues.get(filePath) === next) this.writeQueues.delete(filePath)
    }
    next.then(release, release)
    return next
  }

  private async flushFile(filePath: string): Promise<void> {
    while (this.writeQueues.has(filePath)) {
      await this.writeQueues.get(filePath)
    }
    if (this.writeErrors.has(filePath)) throw this.writeErrors.get(filePath)
  }

  /** Wait for accepted snapshots, including updates received while a write is pending. */
  async flush(): Promise<void> {
    while (this.writeQueues.size) {
      await Promise.all([...this.writeQueues.values()])
    }
    if (this.writeErrors.size) throw this.writeErrors.values().next().value
  }

  findEditorBufferStores(dir: string): Record<string, BufferStoreEntry> {
    const results: Record<string, BufferStoreEntry> = {}
    if (!fs.existsSync(dir)) {
      return results
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isFile() && entry.name.endsWith('_editor_buffer_store.json')) {
        const id = entry.name.replace('_editor_buffer_store.json', '')
        results[id] = { id, filePath: fullPath }
      }
    }

    return results
  }

  getBufferStoreInfo(restoreBufferId: string): BufferStoreEntry {
    if (!this.bufferStores) {
      this.bufferStores = this.findEditorBufferStores(this.editorBufferStorePath)
    }

    if (!this.bufferStores[restoreBufferId]) {
      this.bufferStores[restoreBufferId] = {
        id: restoreBufferId,
        filePath: path.join(
          this.editorBufferStorePath,
          `${restoreBufferId}_editor_buffer_store.json`
        )
      }
    }

    return this.bufferStores[restoreBufferId]
  }

  async readBufferStoreFile(filePath: string): Promise<BufferStoreContent> {
    const content = await fsPromises.readFile(filePath, 'utf8')
    if (!content.trim()) {
      throw new Error('Buffer store file is empty.')
    }

    const buffer = JSON.parse(content) as BufferStoreContent
    if (!buffer || !Array.isArray(buffer.tabs)) {
      throw new Error('Invalid editor buffer state.')
    }

    return buffer
  }

  writeBufferStoreFile(filePath: string, newState: unknown): Promise<void> {
    // Capture before yielding: renderer snapshots can be mutated by their caller.
    const payload = JSON.stringify(newState)
    this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1)
    return this.enqueue(filePath, async () => {
      try {
        // Atomic replacement alone is insufficient for unsaved recovery content (#3786).
        await writeFileAtomic(filePath, payload, { encoding: 'utf8', fsync: true })
        this.writeErrors.delete(filePath)
      } catch (error) {
        this.writeErrors.set(filePath, error)
        throw error
      }
    })
  }

  async updateBufferState(e: IpcMainInvokeEvent, newState: unknown): Promise<boolean> {
    const win = BrowserWindow.fromWebContents(e.sender)
    const restoreBufferId = (win as unknown as { restoreBufferId?: string })?.restoreBufferId

    if (!restoreBufferId) {
      console.warn('No restoreBufferId found for window, skipping buffer state update')
      return false
    }

    const bufferStore = this.getBufferStoreInfo(restoreBufferId)
    await this.writeBufferStoreFile(bufferStore.filePath, newState)
    return true
  }

  getUnUsedBufferUUID(): string {
    if (!this.bufferStores) {
      this.bufferStores = this.findEditorBufferStores(this.editorBufferStorePath)
    }

    let uuid: string
    do {
      uuid = crypto.randomUUID()
    } while (uuid in this.bufferStores)

    return uuid
  }

  _listenForIpcMain(): void {
    ipcMain.handle('update-buffer-state', (e, newState) => {
      return this.updateBufferState(e, newState)
    })
  }
}

export default EditorBufferStore
