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

// Serializes writes per buffer file: rapid renderer state updates are each
// persisted in full, and concurrent atomic writes could otherwise complete out
// of order and leave an older snapshot on disk.
const writeQueues = new Map<string, Promise<void>>()

class EditorBufferStore extends TypedEmitter<EditorBufferStoreEvents> {
  editorBufferStorePath: string
  bufferStores: Record<string, BufferStoreEntry> | null
  serviceName: string
  encryptKeys: string[]

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
    this.bufferStores = this.getAllBufferStores()

    // Reads run in parallel: with N stale crash-recovery buffers, N sequential
    // sync reads would each stall the main process event loop.
    await Promise.all(
      Object.values(this.bufferStores).map(async(entry) => {
        try {
          const buffer = await this.readBufferStoreFile(entry.filePath)
          const allSaved = buffer.tabs.every((file) => file.isSaved)
          if (buffer.tabs.length === 0 || allSaved) {
            try {
              await fsPromises.unlink(entry.filePath)
            } catch (e) {
              console.error('Failed to delete buffer store file during clear', e)
            }
          }
        } catch (e) {
          console.error('Failed to read buffer store file during clear', e)
        }
      })
    )
  }

  async handleClose(restoreBufferId: string | undefined, editorWindows: EditorWindow[]): Promise<void> {
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

    if (editorWindows.length > 1) {
      if (!fs.existsSync(this.bufferStores[restoreBufferId].filePath)) {
        return
      }
      try {
        const buffer = await this.readBufferStoreFile(this.bufferStores[restoreBufferId].filePath)
        const allSaved = buffer.tabs.every((file) => file.isSaved)
        if (buffer.tabs.length === 0 || allSaved) {
          await fsPromises.unlink(this.bufferStores[restoreBufferId].filePath)
          delete this.bufferStores[restoreBufferId]
        }
      } catch (e) {
        console.error('Failed to read or parse buffer store file during cleanup', e)
      }
    }
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
    // Durable atomic write: write-file-atomic writes to a temp file, fsyncs it,
    // then renames it over the target. The previous temp-file + rename here was
    // namespace-atomic (crash-safe) but omitted the fsync, so a power loss could
    // still leave this crash-recovery buffer — which holds unsaved tab content —
    // truncated or zero-filled, the same gap the document save path had (#3786).
    const payload = JSON.stringify(newState)
    const previous = writeQueues.get(filePath) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => writeFileAtomic(filePath, payload, 'utf8'))
      .then(() => undefined)
    writeQueues.set(filePath, next)
    return next
  }

  updateBufferState(e: IpcMainInvokeEvent, newState: unknown): boolean {
    const win = BrowserWindow.fromWebContents(e.sender)
    const restoreBufferId = (win as unknown as { restoreBufferId?: string })?.restoreBufferId

    if (!restoreBufferId) {
      console.warn('No restoreBufferId found for window, skipping buffer state update')
      return false
    }

    const bufferStore = this.getBufferStoreInfo(restoreBufferId)
    // Fire-and-forget: the renderer re-sends the full state on every update,
    // so a lost write only costs crash-recovery fidelity — never user data.
    this.writeBufferStoreFile(bufferStore.filePath, newState).catch((err) => {
      console.error('Failed to persist editor buffer state:', err)
    })
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
