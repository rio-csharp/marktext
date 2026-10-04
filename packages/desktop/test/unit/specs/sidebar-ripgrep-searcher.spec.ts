import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/util', () => ({ deepClone: (value: unknown) => JSON.parse(JSON.stringify(value)) }))

import RipgrepDirectorySearcher, { FileSearcher } from '@/node/ripgrepSearcher'

const channels = ['onMatch', 'onProgress', 'onDone', 'onError', 'onCancelled'] as const
const handlers = new Map<string, Set<(payload: unknown) => void>>()
const emit = (channel: string, payload: unknown): void => {
  for (const handler of [...(handlers.get(channel) ?? [])]) handler(payload)
}
const activeListenerCount = (): number => [...handlers.values()].reduce((n, set) => n + set.size, 0)
const lastId = (): string =>
  (vi.mocked(window.ripgrep.start).mock.lastCall![0] as { searchId: string }).searchId

beforeEach(() => {
  handlers.clear()
  const subscriptions = Object.fromEntries(
    channels.map((channel) => [
      channel,
      (handler: (payload: unknown) => void) => {
        const set = handlers.get(channel) ?? new Set()
        set.add(handler)
        handlers.set(channel, set)
        return () => {
          set.delete(handler)
        }
      }
    ])
  )
  window.ripgrep = {
    ...subscriptions,
    start: vi.fn(async(req: unknown) => ({ searchId: (req as { searchId: string }).searchId })),
    cancel: vi.fn()
  } as unknown as typeof window.ripgrep
})

describe('sidebar ripgrep IPC compatibility and lifetime', () => {
  it('delivers single and batched text matches without accepting other search IDs', async() => {
    const didMatch = vi.fn()
    const request = new RipgrepDirectorySearcher().search(['/docs'], 'text', { didMatch })
    const searchId = lastId()
    emit('onMatch', { searchId: 'other', payload: { filePath: '/wrong' } })
    emit('onMatch', { searchId, payload: { filePath: '/docs/a.md' } })
    emit('onMatch', { searchId, payload: [{ filePath: '/docs/b.md' }, { filePath: '/docs/c.md' }] })
    emit('onDone', { searchId })
    await request
    expect(didMatch.mock.calls.map(([item]) => item.filePath)).toEqual([
      '/docs/a.md',
      '/docs/b.md',
      '/docs/c.md'
    ])
    expect(activeListenerCount()).toBe(0)
    request.cancel()
    expect(window.ripgrep.cancel).not.toHaveBeenCalled()
  })

  it('also flattens file-search batches', async() => {
    const didMatch = vi.fn()
    const request = new FileSearcher().search(['/docs'], '', { didMatch })
    const searchId = lastId()
    emit('onMatch', { searchId, payload: ['/docs/a.md', '/docs/b.md'] })
    emit('onDone', { searchId })
    await request
    expect(didMatch.mock.calls).toEqual([['/docs/a.md'], ['/docs/b.md']])
  })

  it('settles cancellation locally, ignores queued dead-ID callbacks, and stops mid-batch', async() => {
    const didMatch = vi.fn(() => request.cancel())
    const didSearchPaths = vi.fn()
    const request = new RipgrepDirectorySearcher().search(['/docs'], 'text', {
      didMatch,
      didSearchPaths
    })
    const searchId = lastId()
    const queuedMatch = [...handlers.get('onMatch')!][0]
    const queuedProgress = [...handlers.get('onProgress')!][0]
    emit('onMatch', { searchId, payload: [1, 2, 3] })
    await request
    queuedMatch({ searchId, payload: 4 })
    queuedProgress({ searchId, num: 10 })
    request.cancel()
    expect(didMatch).toHaveBeenCalledTimes(1)
    expect(didSearchPaths).not.toHaveBeenCalled()
    expect(window.ripgrep.cancel).toHaveBeenCalledExactlyOnceWith(searchId)
    expect(activeListenerCount()).toBe(0)
  })

  it('keeps concurrent requests isolated when one is cancelled', async() => {
    const firstMatch = vi.fn()
    const first = new RipgrepDirectorySearcher().search(['/docs'], 'one', { didMatch: firstMatch })
    const firstId = lastId()
    const secondMatch = vi.fn()
    const second = new RipgrepDirectorySearcher().search(['/docs'], 'two', {
      didMatch: secondMatch
    })
    const secondId = lastId()
    first.cancel()
    emit('onMatch', { searchId: firstId, payload: 1 })
    emit('onMatch', { searchId: secondId, payload: [2, 3] })
    emit('onDone', { searchId: secondId })
    await Promise.all([first, second])
    expect(firstMatch).not.toHaveBeenCalled()
    expect(secondMatch.mock.calls).toEqual([[2], [3]])
    expect(activeListenerCount()).toBe(0)
  })

  it('cleans up rejected starts and main-process errors', async() => {
    vi.mocked(window.ripgrep.start).mockRejectedValueOnce(new Error('start failed'))
    await expect(new RipgrepDirectorySearcher().search(['/docs'], 'text', {})).rejects.toThrow(
      'start failed'
    )
    expect(activeListenerCount()).toBe(0)
    const request = new RipgrepDirectorySearcher().search(['/docs'], 'text', {})
    emit('onError', { searchId: lastId(), error: 'invalid pattern' })
    await expect(request).rejects.toThrow('invalid pattern')
    expect(activeListenerCount()).toBe(0)
  })
})
