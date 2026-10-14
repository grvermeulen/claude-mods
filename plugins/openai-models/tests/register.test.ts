import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput, TurnStepChunk, TurnStepInput } from 'claude-code'

import { StepTranslator, instructionsFor, toInput, toolsFor, usageFrom } from '../hooks/translate'
import type { ApiMessage } from '../hooks/translate'

tier('user')

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }
const run = (args: string): CommandRunInput => ({
  command: 'gpt', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})
const step = (over: Partial<TurnStepInput> = {}): TurnStepInput => ({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...over })

const TOOLS = [
  { name: 'Read', description: 'Reads a file.', mcp: false },
  { name: 'Bash', description: 'Runs a command. ' + 'More guidance. '.repeat(100), mcp: false },
  { name: 'mcp__slack__send', description: 'Sends a Slack message.', mcp: true },
]

const MESSAGES: ApiMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Wat staat er in x.txt?' }] },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'Ik lees het.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:/x.txt' } },
    { type: 'tool_use', id: 'toolu_2', name: 'mcp__slack__send', input: { text: 'hoi' } },
  ] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hallo' }] },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: 'sent', is_error: false },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ] },
]

// Reads a step's stream by hand, so the generator's return value (the step's result) is kept.
async function drain(stream: AsyncGenerator<TurnStepChunk, unknown>) {
  const chunks: TurnStepChunk[] = []
  for (let r = await stream.next(); ; r = await stream.next()) {
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

describe('translation', () => {
  test('toolsFor offers only the core tools it has schemas for, descriptions shortened', async () => {
    const tools = toolsFor(TOOLS)
    expect(tools.map(t => t.name)).toEqual(['Read', 'Bash'])
    expect(tools[1].description.length).toBeLessThanOrEqual(1000)
    expect(tools[0].parameters).toEqual(expect.objectContaining({ required: ['file_path'] }))
  })

  test('instructionsFor keeps Claude Code\'s prompt, names the model and adds long guidance', async () => {
    const text = instructionsFor([{ text: 'You are Claude Code.' }], TOOLS, 'GPT-6.1 Sol')
    expect(text.startsWith('You are Claude Code.')).toBe(true)
    expect(text).toMatch(/This session runs on GPT-6\.1 Sol, an OpenAI model/)
    expect(text).toMatch(/### Bash\nRuns a command\./)
    expect(text).not.toMatch(/### Read/)
  })

  test('toInput keeps known tool calls native and turns others into text', async () => {
    expect(toInput(MESSAGES, new Set(['Read', 'Bash']))).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Wat staat er in x.txt?' }] },
      { role: 'assistant', content: 'Ik lees het.' },
      { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"file_path":"C:/x.txt"}' },
      { role: 'assistant', content: '[called the tool mcp__slack__send with {"text":"hoi"}]' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'hallo' },
      { role: 'user', content: [
        { type: 'input_text', text: '[result of the tool mcp__slack__send]\nsent' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ] },
    ])
  })

  test('StepTranslator streams text and a tool call, then ends on tool_use with the usage', async () => {
    const t = new StepTranslator('t1', 2, 'gpt-6.1-sol')
    const chunks = [
      ...t.push({ type: 'text', item: 'msg_1', delta: 'Ik kijk ' }),
      ...t.push({ type: 'text', item: 'msg_1', delta: 'even.' }),
      ...t.push({ type: 'tool', item: 'fc_1', call_id: 'call_A', name: 'Read' }),
      ...t.push({ type: 'args', item: 'fc_1', delta: '{"file_path":' }),
      ...t.push({ type: 'args', item: 'fc_1', delta: '"C:/x.txt"}' }),
      ...t.push({ type: 'done', status: 'completed', reason: null, usage: { input_tokens: 1200, output_tokens: 30, input_tokens_details: { cached_tokens: 1000 } } }),
    ]
    expect(chunks).toEqual([
      { kind: 'text', index: 0, text: 'Ik kijk ' },
      { kind: 'text', index: 0, text: 'even.' },
      { kind: 'tool', index: 1, id: 'call_A', name: 'Read' },
      { kind: 'input', index: 1, json: '{"file_path":' },
      { kind: 'input', index: 1, json: '"C:/x.txt"}' },
    ])
    const { stop, result } = t.finish()
    expect(stop).toEqual({ kind: 'stop', stopReason: 'tool_use', usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, model: 'gpt-6.1-sol' } })
    expect(result).toEqual(expect.objectContaining({ turnId: 't1', index: 2, answer: 'Ik kijk even.', stopReason: 'tool_use', toolUses: [{ name: 'Read', input: { file_path: 'C:/x.txt' } }] }))
  })

  test('an error ends the step as text, with no tool calls', async () => {
    const t = new StepTranslator('t1', 0, 'gpt-6.1-sol')
    t.push({ type: 'tool', item: 'fc_1', call_id: 'call_A', name: 'Read' })
    expect(t.push({ type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' })[0]).toEqual(
      expect.objectContaining({ kind: 'text', text: expect.stringMatching(/usage limit for this app is reached/) }))
    expect(t.finish().result).toEqual(expect.objectContaining({ stopReason: 'end_turn', toolUses: [] }))
  })

  test('usageFrom maps cached input to cache reads', async () => {
    expect(usageFrom(null, 'm')).toBe(null)
    expect(usageFrom({ input_tokens: 10, output_tokens: 2 }, 'm')).toEqual({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' })
  })
})

// The world beneath the mod: gpt.py's answers, the session's conversation, and Claude.
function world(on: On, opts: { infer?: string[] } = {}) {
  mock.store(on, {})
  mock.env(on, { OS: 'Windows_NT' })
  const runs: string[][] = []
  const spawned: Array<{ argv: string[]; input?: string }> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const command = e.argv.at(-1)
    const stdout = command === 'models'
      ? JSON.stringify({ type: 'models', models: [{ slug: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] })
      : JSON.stringify({ type: 'status', signed_in: true, email: 'me@example.com', plan: true })
    return { value: { exitCode: 0, stdout: stdout + '\n', stderr: '' } }
  })
  on('session.messages', () => ({ value: MESSAGES }))
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('tool.list', () => ({ value: TOOLS }))
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], input: e.input })
    for (const line of opts.infer ?? []) yield { stream: 'stdout' as const, text: line + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'from Claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from Claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { runs, spawned }
}

const INFER = [
  '{"type": "text", "item": "msg_1", "delta": "Ik lees x.txt."}',
  '{"type": "tool", "item": "fc_1", "call_id": "call_A", "name": "Read"}',
  '{"type": "args", "item": "fc_1", "delta": "{\\"file_path\\": \\"C:/x.txt\\"}"}',
  '{"type": "done", "status": "completed", "reason": null, "usage": {"input_tokens": 50, "output_tokens": 5}}',
]

describe('the main loop', () => {
  test('Claude answers until a model is picked', async ($, on) => {
    const w = world(on, { infer: INFER })
    await $.session.start(session)
    const { chunks, result } = await drain($.turn.step(step()))
    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'from Claude' }])
    expect(w.spawned).toEqual([])
    expect(result).toEqual(expect.objectContaining({ answer: 'from Claude' }))
  })

  test('/gpt use hands the main loop to the model, with the conversation and core tools', async ($, on) => {
    const w = world(on, { infer: INFER })
    await $.session.start(session)
    expect((await $.command.run(run('use gpt-6.1-sol'))).text).toMatch(/^GPT-6\.1 Sol now answers this session's turns/)
    const { chunks, result } = await drain($.turn.step(step()))
    expect(chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
    expect(result).toEqual(expect.objectContaining({ answer: 'Ik lees x.txt.', stopReason: 'tool_use', toolUses: [{ name: 'Read', input: { file_path: 'C:/x.txt' } }] }))
    expect(w.spawned[0].argv).toEqual(['python', '-I', expect.stringMatching(/scripts\/gpt\.py$/), 'infer'])
    const body = JSON.parse(w.spawned[0].input ?? '{}')
    expect(body.model).toBe('gpt-6.1-sol')
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Bash'])
    expect(body.instructions).toMatch(/^You are Claude Code\./)
    expect(body.input).toHaveLength(6)
  })

  test('a subagent\'s steps stay with Claude', async ($, on) => {
    world(on, { infer: INFER })
    await $.session.start(session)
    await $.command.run(run('use gpt-6.1-sol'))
    const { chunks } = await drain($.turn.step(step({ agentId: 'agent-1' })))
    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'from Claude' }])
  })

  test('a failure becomes text the person reads', async ($, on) => {
    world(on, { infer: ['{"type": "error", "code": "not_signed_in", "message": "not signed in", "relogin": true}'] })
    await $.session.start(session)
    await $.command.run(run('use gpt-6.1-sol'))
    const { chunks, result } = await drain($.turn.step(step()))
    expect(chunks[0]).toEqual(expect.objectContaining({ kind: 'text', text: '[OpenAI: not signed in to ChatGPT: /gpt login]' }))
    expect(result).toEqual(expect.objectContaining({ stopReason: 'end_turn', toolUses: [] }))
  })

  test('a helper that ends without an answer is reported', async ($, on) => {
    world(on, { infer: [] })
    await $.session.start(session)
    await $.command.run(run('use gpt-6.1-sol'))
    const { chunks } = await drain($.turn.step(step()))
    expect(chunks[0]).toEqual(expect.objectContaining({ kind: 'text', text: '[OpenAI: gpt.py ended without an answer]' }))
  })

  test('/gpt off gives the loop back to Claude; an unknown model is refused', async ($, on) => {
    world(on, { infer: INFER })
    await $.session.start(session)
    expect((await $.command.run(run('use gpt-0'))).text).toMatch(/^not one of your models: gpt-0\. Yours: gpt-6\.1-sol/)
    await $.command.run(run('use gpt-6.1-sol'))
    expect((await $.command.run(run('off'))).text).toBe('Claude answers again (was GPT-6.1 Sol)')
    const { chunks } = await drain($.turn.step(step()))
    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'from Claude' }])
    expect((await $.command.run(run('status'))).text).toMatch(/^signed in as me@example\.com · answering: Claude/)
  })
})
