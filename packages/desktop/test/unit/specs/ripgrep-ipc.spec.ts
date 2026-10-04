// @vitest-environment node
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listeners, spawn } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  spawn: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) => listeners.set(channel, handler)
  }
}))
vi.mock('child_process', () => ({ spawn }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('@vscode/ripgrep', () => ({ rgPath: '/rg' }))
import { registerRipgrepHandlers } from 'main_renderer/ipc/ripgrep'

class Sender extends EventEmitter {
  destroyed = false
  send = vi.fn()
  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
    this.emit('destroyed')
  }
}
class Child extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}
const children: Child[] = []
const senders: Sender[] = []
const makeSender = () => {
  const sender = new Sender()
  senders.push(sender)
  return sender
}
const start = (
  sender: Sender,
  mode: 'files' | 'text',
  searchId = 'search',
  directories = ['/project']
) => {
  expect(
    handlers.get('mt::rg::start')!(
      { sender },
      { searchId, mode, directories, pattern: 'hit', options: {} }
    )
  ).toBe(true)
}
const cancel = (sender: Sender, searchId = 'search') =>
  listeners.get('mt::rg::cancel')!({ sender }, searchId)
const textResult = (filePath: string, trailingNewline = true) =>
  [
    { type: 'begin', data: { path: { text: filePath } } },
    {
      type: 'match',
      data: {
        lines: { text: 'hit\n' },
        line_number: 1,
        submatches: [{ start: 0, end: 3, match: { text: 'hit' } }]
      }
    },
    { type: 'end' }
  ]
    .map((message) => JSON.stringify(message))
    .join('\n') + (trailingNewline ? '\n' : '')
const output = (child: Child, mode: 'files' | 'text', names = ['a.md']) => {
  child.stdout.emit(
    'data',
    mode === 'files' ? names.join('\n') + '\n' : names.map((name) => textResult(name)).join('')
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  children.length = 0
  senders.length = 0
  spawn.mockImplementation(() => {
    const child = new Child()
    children.push(child)
    return child
  })
  registerRipgrepHandlers()
})
afterEach(() => {
  for (const sender of senders) sender.destroy()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

for (const mode of ['files', 'text'] as const) {
  describe(`${mode} search batching and lifecycle`, () => {
    it('batches at 100 results and flushes the remainder before done', () => {
      const sender = makeSender()
      start(sender, mode)
      output(
        children[0],
        mode,
        Array.from({ length: 101 }, (_, i) => `${i}.md`)
      )
      expect(sender.send).toHaveBeenCalledTimes(2)
      expect(sender.send.mock.calls[0]).toEqual([
        'mt::rg::progress',
        { searchId: 'search', num: 100 }
      ])
      expect(sender.send.mock.calls[1][1].payload).toHaveLength(100)
      children[0].emit('close', 0)
      expect(sender.send.mock.calls.map((call) => call[0])).toEqual([
        'mt::rg::progress',
        'mt::rg::match',
        'mt::rg::progress',
        'mt::rg::match',
        'mt::rg::done'
      ])
      expect(sender.send.mock.calls[2][1].num).toBe(101)
      expect(sender.send.mock.calls[3][1].payload).toHaveLength(1)
      expect(sender.listenerCount('destroyed')).toBe(0)
    })
    it('flushes sparse results after 16 ms and waits for all directories', () => {
      const sender = makeSender()
      start(sender, mode, 'search', ['/one', '/two'])
      output(children[0], mode)
      vi.advanceTimersByTime(15)
      expect(sender.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(sender.send).toHaveBeenCalledTimes(2)
      children[0].emit('close', 0)
      expect(sender.send).toHaveBeenCalledTimes(2)
      children[1].emit('close', 0)
      expect(sender.send).toHaveBeenLastCalledWith('mt::rg::done', { searchId: 'search' })
    })
    it('discards buffered results and ignores late data, close and errors after cancellation', () => {
      const sender = makeSender()
      start(sender, mode)
      output(children[0], mode)
      children[0].kill.mockImplementation(() => {
        children[0].emit('close', 0)
      })
      cancel(sender)
      output(children[0], mode)
      children[0].emit('error', new Error('late'))
      children[0].emit('close', 0)
      cancel(sender)
      vi.runAllTimers()
      expect(sender.send.mock.calls).toEqual([['mt::rg::cancelled', { searchId: 'search' }]])
      expect(children[0].kill).toHaveBeenCalledTimes(1)
      expect(sender.listenerCount('destroyed')).toBe(0)
    })
    it('cancels on sender destruction without sending buffered matches', () => {
      const sender = makeSender()
      start(sender, mode)
      output(children[0], mode)
      sender.destroy()
      children[0].emit('close', 0)
      vi.runAllTimers()
      expect(children[0].kill).toHaveBeenCalledTimes(1)
      expect(sender.send).not.toHaveBeenCalled()
    })
    it('keeps a replacement cancellable despite callbacks from the previous search', () => {
      const sender = makeSender()
      start(sender, mode)
      const oldChild = children[0]
      output(oldChild, mode)
      start(sender, mode)
      expect(oldChild.kill).toHaveBeenCalledTimes(1)
      sender.send.mockClear()
      output(oldChild, mode)
      oldChild.emit('close', 0)
      oldChild.emit('error', new Error('late'))
      output(children[1], mode)
      cancel(sender)
      vi.runAllTimers()
      expect(children[1].kill).toHaveBeenCalledTimes(1)
      expect(sender.send.mock.calls).toEqual([['mt::rg::cancelled', { searchId: 'search' }]])
    })
    it('flushes before an error, kills other children and suppresses subsequent results', () => {
      const sender = makeSender()
      start(sender, mode, 'search', ['/one', '/two'])
      output(children[0], mode)
      children[1].emit('error', new Error('failed'))
      output(children[0], mode)
      children[0].emit('close', 0)
      vi.runAllTimers()
      expect(sender.send.mock.calls.map((call) => call[0])).toEqual([
        'mt::rg::progress',
        'mt::rg::match',
        'mt::rg::error'
      ])
      expect(sender.send).toHaveBeenLastCalledWith('mt::rg::error', {
        searchId: 'search',
        error: 'failed'
      })
      expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true)
    })
    it('completes an empty directory list without spawning', () => {
      const sender = makeSender()
      start(sender, mode, 'search', [])
      expect(spawn).not.toHaveBeenCalled()
      expect(sender.send).toHaveBeenCalledExactlyOnceWith('mt::rg::done', { searchId: 'search' })
    })
    it('handles synchronous spawn failure and rejects cancellation by another sender', () => {
      const sender = makeSender()
      start(sender, mode)
      cancel(makeSender())
      expect(children[0].kill).not.toHaveBeenCalled()
      cancel(sender)
      spawn.mockImplementationOnce(() => {
        throw new Error('spawn failed')
      })
      start(sender, mode)
      expect(sender.send).toHaveBeenLastCalledWith('mt::rg::error', {
        searchId: 'search',
        error: 'spawn failed'
      })
    })
  })
}

it('flushes a text end record without a trailing newline before done', () => {
  const sender = makeSender()
  start(sender, 'text')
  const data = textResult('a.md', false)
  children[0].stdout.emit('data', data.slice(0, 13))
  children[0].stdout.emit('data', data.slice(13))
  children[0].emit('close', 0)
  expect(sender.send.mock.calls.map((call) => call[0])).toEqual([
    'mt::rg::progress',
    'mt::rg::match',
    'mt::rg::done'
  ])
  expect(sender.send.mock.calls[1][1].payload).toEqual([
    {
      filePath: 'a.md',
      matches: [
        {
          matchText: 'hit',
          lineText: 'hit',
          range: [
            [0, 0],
            [0, 3]
          ],
          leadingContextLines: [],
          trailingContextLines: []
        }
      ]
    }
  ])
})
