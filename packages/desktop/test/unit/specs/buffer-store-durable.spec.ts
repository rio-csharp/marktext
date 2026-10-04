import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { default: EditorBufferStore } = await import('main_renderer/editorBufferStore')

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'mt-buf-'))
  dirs.push(d)
  return d
}

type Store = InstanceType<typeof EditorBufferStore>
const stores: Store[] = []
function createStore(): Store {
  const store = new EditorBufferStore({ editorBufferStorePath: tempDir() })
  stores.push(store)
  return store
}

afterEach(async() => {
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('durable editor recovery buffers', () => {
  it('writes JSON and leaves no temporary file behind', async() => {
    const store = createStore()
    const target = path.join(store.editorBufferStorePath, 'buffer.json')
    const state = { tabs: [{ id: '1', markdown: 'hello' }] }
    await store.writeBufferStoreFile(target, state)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(state)
    expect(readdirSync(store.editorBufferStorePath)).toEqual(['buffer.json'])
  })

  it('serializes rapid writes and flushes the last accepted snapshot', async() => {
    const store = createStore()
    const target = path.join(store.editorBufferStorePath, 'buffer.json')
    const writes = Array.from({ length: 20 }, (_, index) =>
      store.writeBufferStoreFile(target, { tabs: [{ markdown: String(index) }] })
    )
    await store.flush()
    await Promise.all(writes)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ tabs: [{ markdown: '19' }] })
    expect(readdirSync(store.editorBufferStorePath)).toEqual(['buffer.json'])
  })

  it('captures the snapshot before the caller can mutate it', async() => {
    const store = createStore()
    const target = path.join(store.editorBufferStorePath, 'buffer.json')
    const state = { tabs: [{ markdown: 'unsaved' }] }
    const write = store.writeBufferStoreFile(target, state)
    state.tabs[0].markdown = 'changed'
    await write
    expect(JSON.parse(readFileSync(target, 'utf8')).tabs[0].markdown).toBe('unsaved')
  })

  it('waits for the pending unsaved snapshot before deciding whether to delete', async() => {
    const store = createStore()
    const entry = store.getBufferStoreInfo('one')
    await store.writeBufferStoreFile(entry.filePath, { tabs: [{ isSaved: true }] })
    const update = store.writeBufferStoreFile(entry.filePath, {
      tabs: [{ isSaved: false, markdown: 'only copy' }]
    })
    await store.handleClose('one', [
      { id: 1, win: {} as never },
      { id: 2, win: {} as never }
    ])
    await update
    expect((await store.readBufferStoreFile(entry.filePath)).tabs[0].markdown).toBe('only copy')
    expect(store.getAll().one).toEqual(entry)
  })

  it('does not delete a newer unsaved update arriving during cleanup', async() => {
    const store = createStore()
    const entry = store.getBufferStoreInfo('one')
    await store.writeBufferStoreFile(entry.filePath, { tabs: [{ isSaved: true }] })
    const originalRead = store.readBufferStoreFile.bind(store)
    let started!: () => void
    let release!: () => void
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(store, 'readBufferStoreFile').mockImplementationOnce(async(filePath: string) => {
      const buffer = await originalRead(filePath)
      started()
      await barrier
      return buffer
    })
    const cleanup = store.clearBufferStoresWithAllSaved()
    await readStarted
    const update = store.writeBufferStoreFile(entry.filePath, { tabs: [{ isSaved: false }] })
    release()
    await Promise.all([cleanup, update])
    expect((await originalRead(entry.filePath)).tabs[0].isSaved).toBe(false)
    expect(store.getAll().one).toEqual(entry)
  })
})
