import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput, TurnCompleteInput } from 'claude-code'

import { LineReader, forSpeech, parseEvent } from '../hooks/speech'
import { SEND_AFTER_MS, settingsFrom } from '../hooks/register'

tier('user')

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const run = (args: string): CommandRunInput => ({
  command: 'listen', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
const turn = (answer: string, over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer',
  usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5' },
  ...over,
})

// Lets the listener's loop, which runs beside the test, catch up.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 20))

// listen.py as the test drives it: lines pushed in, closed when the test is done.
function listenerLines() {
  const queue: string[] = []
  let wake: (() => void) | null = null
  let isClosed = false
  return {
    push(...lines: string[]) {
      queue.push(...lines)
      wake?.()
    },
    close() {
      isClosed = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift() as string
        if (isClosed) return
        await new Promise<void>(resolve => {
          wake = resolve
        })
        wake = null
      }
    },
  }
}

// The world beneath the mod: a Windows machine with the setup done or not.
function world(on: On, opts: { hasSetup?: boolean } = {}) {
  mock.store(on, {})
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' })
  const lines = listenerLines()
  const control: string[] = []
  const spawned: Array<{ argv: string[]; input?: string }> = []
  const submitted: Array<{ text: string; origin: unknown }> = []
  const toasts: string[] = []
  const logs: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: opts.hasSetup ?? true }))
  on('fs.write', ($, e) => {
    control.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: 'answer' in e ? e.answer : '' }))
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], input: e.input })
    if (e.argv[0] === 'powershell.exe') return { value: { code: 0, signal: null } }
    for await (const line of lines) yield { stream: 'stdout' as const, text: line + '\n' }
    return { value: { code: 0, signal: null } }
  })
  return { lines, control, spawned, submitted, toasts, logs }
}

describe('speech helpers', () => {
  test('forSpeech drops code, tables and markup and keeps the words', async () => {
    const reply = '## Klaar\n\nAlle **tests** slagen, zie `npm test`.\n\n```bash\nnpm test\n```\n\n| a | b |\n| - | - |\n\n- [docs](https://example.com) gelezen'
    expect(forSpeech(reply, 700)).toBe('Klaar Alle tests slagen, zie npm test. docs gelezen')
  })

  test('forSpeech stops at a sentence end inside the limit', async () => {
    const reply = 'Eerste zin is kort. Tweede zin is een stuk langer en loopt door tot voorbij de grens.'
    expect(forSpeech(reply, 40)).toBe('Eerste zin is kort.')
  })

  test('LineReader joins pieces into whole lines', async () => {
    const reader = new LineReader()
    expect(reader.push('{"type":"re')).toEqual([])
    expect(reader.push('ady"}\r\n{"type":"speech"}\n{"ty')).toEqual(['{"type":"ready"}', '{"type":"speech"}'])
    expect(reader.push('pe":"heard"}\n')).toEqual(['{"type":"heard"}'])
  })

  test('parseEvent reads the listener\'s events and nothing else', async () => {
    expect(parseEvent('{"type":"text","text":"  hallo  "}')).toEqual({ type: 'text', text: 'hallo' })
    expect(parseEvent('{"type":"text","text":"   "}')).toBe(null)
    expect(parseEvent('{"type":"error","message":"no mic"}')).toEqual({ type: 'error', message: 'no mic' })
    expect(parseEvent('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseEvent('Traceback (most recent call last):')).toBe(null)
    expect(parseEvent('{"type":"other"}')).toBe(null)
  })

  test('settingsFrom keeps what is valid and fills the rest', async () => {
    expect(settingsFrom({ language: 'en', speak: 'yes', model: 3 })).toEqual({ language: 'en', speak: true, device: '', model: 'small', voice: '' })
    expect(settingsFrom(null).language).toBe('nl')
  })
})

describe('conversation', () => {
  test('without the setup, /listen says how to get it and starts nothing', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on, { hasSetup: false })
    await $.session.start(session)
    const r = await $.command.run(run(''))
    expect(r.text).toMatch(/\/listen setup/)
    expect(w.spawned).toEqual([])
  })

  test('words are sent after a pause as the person\'s own, and the microphone pauses', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start(session)
    const r = await $.command.run(run(''))
    expect(r.text).toMatch(/live voice starting: language nl/)
    expect(w.spawned[0].argv).toEqual(expect.arrayContaining(['--language', 'nl', '--model', 'small']))
    w.lines.push('{"type":"ready"}', '{"type":"speech"}', '{"type":"heard"}', '{"type":"text","text":"Draai de tests"}')
    await flush()
    expect(w.toasts).toEqual(['live voice: listening'])
    expect(w.submitted).toEqual([])
    await clock.advance(SEND_AFTER_MS)
    await flush()
    expect(w.submitted.map(p => p.text)).toEqual(['Draai de tests'])
    expect(w.submitted[0].origin).toEqual({ kind: 'plugin', name: 'live-voice', asUser: true })
    expect(w.control.at(-1)).toBe('pause')
    w.lines.close()
    await flush()
  })

  test('talking again inside the pause adds to the same prompt', async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run('on'))
    w.lines.push('{"type":"ready"}', '{"type":"text","text":"Draai de tests"}')
    await flush()
    await clock.advance(SEND_AFTER_MS - 500)
    w.lines.push('{"type":"speech"}', '{"type":"heard"}', '{"type":"text","text":"en vat de fouten samen"}')
    await flush()
    await clock.advance(SEND_AFTER_MS - 500)
    await flush()
    expect(w.submitted).toEqual([])
    await clock.advance(500)
    await flush()
    expect(w.submitted.map(p => p.text)).toEqual(['Draai de tests en vat de fouten samen'])
    w.lines.close()
    await flush()
  })

  test('after the turn the reply is read aloud without its code, then it listens again', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run(''))
    w.lines.push('{"type":"ready"}')
    await flush()
    await $.turn.start({ text: 'typed', turnId: 't1' })
    expect(w.control.at(-1)).toBe('pause')
    await $.turn.complete(turn('Alle tests slagen.\n\n```\nnpm test\n```'))
    await flush()
    const speak = w.spawned.find(s => s.argv[0] === 'powershell.exe')
    expect(speak?.argv).toEqual(expect.arrayContaining(['-Language', 'nl', '-StopFile']))
    expect(speak?.input).toBe('Alle tests slagen.')
    expect(w.control.at(-1)).toBe('listen')
    w.lines.close()
    await flush()
  })

  test('an interrupted turn is not read aloud', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run(''))
    w.lines.push('{"type":"ready"}')
    await flush()
    await $.turn.complete(turn('Half antwoord', { isAborted: true }))
    await flush()
    expect(w.spawned.filter(s => s.argv[0] === 'powershell.exe')).toEqual([])
    expect(w.control.at(-1)).toBe('listen')
    w.lines.close()
    await flush()
  })

  test('/listen off tells the listener to stop', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run(''))
    w.lines.push('{"type":"ready"}')
    await flush()
    const stopping = $.command.run(run('off'))
    await flush()
    expect(w.control.at(-1)).toBe('stop')
    w.lines.close()
    expect((await stopping).text).toBe('live voice off')
    const status = await $.command.run(run('status'))
    expect(status.text).toMatch(/^live voice off · language nl/)
  })

  test('the listener ending by itself is reported', async ($, on) => {
    mock.clock(on, { now: 0 })
    const w = world(on)
    await $.session.start(session)
    await $.command.run(run(''))
    w.lines.push('{"type":"error","message":"could not open the microphone: no device"}')
    w.lines.close()
    await flush()
    expect(w.logs).toEqual(['live voice: could not open the microphone: no device', 'live voice stopped'])
  })
})
