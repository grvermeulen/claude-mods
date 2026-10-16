import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { AgentSpawnInput, CommandRunInput, On, SessionStartInput, TurnStepChunk, TurnStepInput } from 'claude-code'

import { INVOKE_TOOL, StepTranslator, buildToolset, harvestSchemas, instructionsFor, safeName, toInput, turnKey, usageFrom } from '../hooks/translate'
import type { ApiMessage } from '../hooks/translate'
import { AUTO_MODE_REASON, completionValue, definitionBody, effortFor, freshState, gptModel, resolveModel, routeFor, usageText, withPickerRows } from '../hooks/register'

tier('user')

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: 'C:/work' }
const run = (args: string): CommandRunInput => ({
  command: 'gpt', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})
const step = (over: Partial<TurnStepInput> = {}): TurnStepInput => ({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...over })

const MODELS = [
  { slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, { slug: 'gpt-6-astra', name: 'GPT-6-Astra' }, { slug: 'gpt-6-sol', name: 'GPT-6-Sol' },
  { slug: 'gpt-6-luna', name: 'GPT-6-Luna' }, { slug: 'gpt-5.6-luna', name: 'GPT-5.6-Luna' },
]

const LONG_MCP = 'mcp__4ea1c87b-c31a-4dd0-ae61-6cbf80dfd87f__get_sandboxes_sessions_by_session_id_snapshot_v2'
const TOOLS = [
  { name: 'Read', description: 'Reads a file.', mcp: false },
  { name: 'Bash', description: 'Runs a command. ' + 'More guidance. '.repeat(100), mcp: false },
  { name: 'mcp__slack__send', description: 'Sends a Slack message.', mcp: true },
  { name: LONG_MCP, description: 'Snapshots a sandbox session.', mcp: true },
  { name: 'mcp__vault__list', description: 'Lists vault items. Metadata only.', mcp: true },
  { name: 'ToolSearch', description: 'Loads deferred tools.', mcp: false },
]
const SCHEMAS = {
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  Bash: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  ToolSearch: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}
const SLACK_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
const SNAPSHOT_SCHEMA = { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] }

const searchResult = (...specs: Array<{ name: string; parameters: object }>) =>
  '<functions>\n' + specs.map(s => `<function>${JSON.stringify({ description: 'x', ...s })}</function>`).join('\n') + '\n</functions>'

const MESSAGES: ApiMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Wat staat er in x.txt?' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'ToolSearch', input: { query: 'select:mcp__slack__send' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: [{ type: 'text', text: searchResult({ name: 'mcp__slack__send', parameters: SLACK_SCHEMA }, { name: LONG_MCP, parameters: SNAPSHOT_SCHEMA }) }] }] },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Ik moet het bestand lezen.', signature: 'sig' },
    { type: 'text', text: 'Ik lees het.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:/x.txt' } },
    { type: 'tool_use', id: 'toolu_2', name: 'mcp__vault__list', input: {} },
    { type: 'tool_use', id: 'toolu_3', name: 'mcp__gone__tool', input: { a: 1 } },
  ] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hallo' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: 'items: 3' },
    { type: 'tool_result', tool_use_id: 'toolu_3', content: 'done' },
    { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
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

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 20))

describe('tools', () => {
  test('buildToolset: schemas make functions, ToolSearch\'s too; long names are made safe; the rest go through invoke_tool', async () => {
    const harvested = harvestSchemas(MESSAGES)
    expect([...harvested.keys()]).toEqual(['mcp__slack__send', LONG_MCP])
    const set = buildToolset(TOOLS, SCHEMAS, harvested)
    const safeLong = safeName(LONG_MCP)
    expect(safeLong.length).toBeLessThanOrEqual(64)
    expect(safeLong).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(set.tools.map(t => t.name)).toEqual(['Read', 'Bash', 'mcp__slack__send', safeLong, 'ToolSearch', INVOKE_TOOL])
    expect(set.real.get(safeLong)).toBe(LONG_MCP)
    expect([...set.catalogue]).toEqual(['mcp__vault__list'])
    const invoke = set.tools.at(-1)!
    expect(invoke.description).toMatch(/- mcp__vault__list: Lists vault items\./)
    expect(invoke.parameters).toEqual(expect.objectContaining({ properties: expect.objectContaining({ tool: expect.objectContaining({ enum: ['mcp__vault__list'] }) }) }))
    expect(set.tools[1].description.length).toBeLessThanOrEqual(1000)
    expect(set.shortened.map(t => t.name)).toEqual(['Bash'])
  })

  test('instructionsFor puts a subagent\'s role first, then Claude Code\'s prompt, who answers, and full guidance', async () => {
    const set = buildToolset(TOOLS, SCHEMAS, new Map())
    const text = instructionsFor([{ text: 'You are Claude Code.' }], set, 'GPT-6-Astra', 'You are a subagent.')
    expect(text.startsWith('# Your role\nYou are a subagent.\n\nYou are Claude Code.')).toBe(true)
    expect(text).toMatch(/This session runs on GPT-6-Astra, an OpenAI model/)
    expect(text).toMatch(/### Bash\nRuns a command\./)
  })
})

describe('conversation', () => {
  test('toInput carries thinking, native and invoke_tool calls, images in tool results, documents, and GPT\'s reasoning', async () => {
    const set = buildToolset(TOOLS, SCHEMAS, harvestSchemas(MESSAGES))
    const reasoning = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] }]
    const items = toInput(MESSAGES, { toolset: set, reasoning: key => (key === turnKey(['toolu_1'], 'Ik lees het.') ? reasoning : undefined) })
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Wat staat er in x.txt?' }] },
      { type: 'function_call', call_id: 'toolu_0', name: 'ToolSearch', arguments: '{"query":"select:mcp__slack__send"}' },
      expect.objectContaining({ type: 'function_call_output', call_id: 'toolu_0' }),
      ...reasoning,
      { role: 'assistant', content: '[earlier reasoning]\nIk moet het bestand lezen.\n[/earlier reasoning]\nIk lees het.' },
      { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"file_path":"C:/x.txt"}' },
      { type: 'function_call', call_id: 'toolu_2', name: 'invoke_tool', arguments: '{"tool":"mcp__vault__list","input":{}}' },
      { role: 'assistant', content: '[called the tool mcp__gone__tool with {"a":1}]' },
      { type: 'function_call_output', call_id: 'toolu_1', output: [{ type: 'input_text', text: 'hallo' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'function_call_output', call_id: 'toolu_2', output: 'items: 3' },
      { role: 'user', content: [
        { type: 'input_text', text: '[result of the tool mcp__gone__tool]\ndone' },
        { type: 'input_file', filename: 'spec.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
      ] },
    ])
  })

  test('StepTranslator maps safe names back, turns invoke_tool into the tool it names, and keeps the reasoning', async () => {
    const set = buildToolset(TOOLS, SCHEMAS, harvestSchemas(MESSAGES))
    const t = new StepTranslator('t1', 2, 'gpt-6-astra', set)
    const chunks = [
      ...t.push({ type: 'reasoning', item: { type: 'reasoning', id: 'rs_9', encrypted_content: 'e' } }),
      ...t.push({ type: 'text', item: 'msg_1', delta: 'Ik kijk.' }),
      ...t.push({ type: 'tool', item: 'fc_1', call_id: 'call_A', name: safeName(LONG_MCP) }),
      ...t.push({ type: 'args', item: 'fc_1', delta: '{"session_id":"s1"}' }),
      ...t.push({ type: 'tool', item: 'fc_2', call_id: 'call_B', name: INVOKE_TOOL }),
      ...t.push({ type: 'args', item: 'fc_2', delta: '{"tool":"mcp__vault__list",' }),
      ...t.push({ type: 'args', item: 'fc_2', delta: '"input":{"q":"x"}}' }),
      ...t.push({ type: 'done', status: 'completed', reason: null, usage: { input_tokens: 10, output_tokens: 2 } }),
    ]
    expect(chunks).toEqual([
      { kind: 'text', index: 0, text: 'Ik kijk.' },
      { kind: 'tool', index: 1, id: 'call_A', name: LONG_MCP },
      { kind: 'input', index: 1, json: '{"session_id":"s1"}' },
      { kind: 'tool', index: 2, id: 'call_B', name: 'mcp__vault__list' },
      { kind: 'input', index: 2, json: '{"q":"x"}' },
    ])
    const { result } = t.finish()
    expect(result.toolUses).toEqual([{ name: LONG_MCP, input: { session_id: 's1' } }, { name: 'mcp__vault__list', input: { q: 'x' } }])
    expect(t.reasoning).toEqual([{ type: 'reasoning', id: 'rs_9', encrypted_content: 'e' }])
    expect(t.key()).toBe('call:call_A')
    expect(t.callIds()).toEqual(['call_A', 'call_B'])
  })

  test('usageFrom maps cached input to cache reads', async () => {
    expect(usageFrom({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } }, 'm'))
      .toEqual({ input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, model: 'm' })
  })
})

describe('choosing a model', () => {
  test('resolveModel takes exact IDs and names, and a part that names one model', async () => {
    expect(resolveModel(MODELS, 'astra').map(m => m.slug)).toEqual(['gpt-6-astra'])
    expect(resolveModel(MODELS, 'GPT-6-Astra').map(m => m.slug)).toEqual(['gpt-6-astra'])
    expect(resolveModel(MODELS, '6.1-sol').map(m => m.slug)).toEqual(['gpt-6.1-sol'])
    expect(resolveModel(MODELS, 'luna').map(m => m.slug)).toEqual(['gpt-6-luna', 'gpt-5.6-luna'])
    expect(resolveModel(MODELS, 'mars')).toEqual([])
  })

  test('effortFor maps Claude Code\'s effort onto OpenAI\'s', async () => {
    expect(effortFor(undefined)).toBe(undefined)
    expect(effortFor('high')).toBe('high')
    expect(effortFor('max')).toBe('xhigh')
    expect(effortFor(2000)).toBe('low')
  })

  test('routeFor: the step\'s own model if it is one of the account\'s; /gpt use for the main loop only', async () => {
    const s = freshState()
    s.models = MODELS
    expect(routeFor(s, step({ model: 'gpt-6-astra', agentId: 'a1' }))?.slug).toBe('gpt-6-astra')
    s.active = MODELS[0]
    expect(routeFor(s, step())?.slug).toBe('gpt-6.1-sol')
    expect(routeFor(s, step({ agentId: 'a1' }))).toBe(null)
  })

  test('withPickerRows replaces only its own rows and keeps everything else', async () => {
    const mine = { model: 'gpt-old', label: 'Old (ChatGPT)', description: 'OpenAI on your ChatGPT plan (openai-models)' }
    const theirs = { model: 'us.anthropic.claude-opus-4-8', label: 'Opus (production)' }
    expect(withPickerRows({ theme: 'dark', modelPicker: { options: [theirs, mine] } }, [MODELS[1]])).toEqual({
      theme: 'dark',
      modelPicker: { options: [theirs, { model: 'gpt-6-astra', label: 'GPT-6-Astra (ChatGPT)', description: 'OpenAI on your ChatGPT plan (openai-models)' }] },
    })
  })

  test('definitionBody drops an agent file\'s frontmatter', async () => {
    expect(definitionBody('---\nname: scout\ntools: Read\n---\nFind code fast.\n')).toBe('Find code fast.')
  })

  test('usageText adds cached input to the total', async () => {
    expect(usageText({ requests: 2, input: 500, cached: 1500, output: 40, lastError: '' })).toBe('2 requests · 2.0k in (1.5k cached) · 40 out')
  })
})

// The engine may hand paths over with either slash; the test's files are keyed one way.
const key = (path: string) => path.replace(/\\/g, '/').toLowerCase()

const INFER = [
  '{"type": "reasoning", "item": {"type": "reasoning", "id": "rs_1", "encrypted_content": "enc"}}',
  '{"type": "text", "item": "msg_1", "delta": "Ik lees x.txt."}',
  '{"type": "tool", "item": "fc_1", "call_id": "call_A", "name": "Read"}',
  '{"type": "args", "item": "fc_1", "delta": "{\\"file_path\\": \\"C:/x.txt\\"}"}',
  '{"type": "done", "status": "completed", "reason": null, "usage": {"input_tokens": 1200, "output_tokens": 30, "input_tokens_details": {"cached_tokens": 1000}}}',
]

// The world beneath the mod: gpt.py, the session's conversation, its agents and files, and Claude.
function world(on: On, opts: { infer?: string[]; store?: Record<string, unknown>; files?: Record<string, string>; schemas?: Record<string, object> } = {}) {
  mock.clock(on, { now: 1000 })
  mock.store(on, { models: MODELS, ...opts.store })
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' })
  const spawned: Array<{ argv: string[]; input?: string }> = []
  const completions: string[] = []
  const files = new Map(Object.entries(opts.files ?? {}).map(([p, t]) => [key(p), t]))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', ($, e) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const command = e.argv[3]
    if (command === 'schemas') {
      if (!opts.schemas) return { value: { exitCode: 1, stdout: '{"type": "error", "code": "no_types", "message": "none"}\n', stderr: '' } }
      files.set(key('C:/cache/tool-schemas.json'), JSON.stringify({ schemas: opts.schemas }))
      return { value: { exitCode: 0, stdout: '{"type": "schemas", "source": "types.d.ts", "tools": 1, "out": "C:/cache/tool-schemas.json"}\n', stderr: '' } }
    }
    if (command === 'infer') {
      completions.push(e.init?.stdin ?? '')
      return { value: { exitCode: 0, stdout: '{"type": "text", "item": "m", "delta": "Samenvatting."}\n{"type": "done", "status": "completed", "reason": null, "usage": {"input_tokens": 5, "output_tokens": 2}}\n', stderr: '' } }
    }
    const stdout = command === 'models' ? JSON.stringify({ type: 'models', models: MODELS }) : JSON.stringify({ type: 'status', signed_in: true, email: 'me@example.com', plan: true })
    return { value: { exitCode: 0, stdout: stdout + '\n', stderr: '' } }
  })
  on('session.messages', ($, e) => ({ value: (e as { agentId?: string }).agentId === 'unreadable' ? { deny: 'not this session\'s agent' } : MESSAGES }))
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('tool.list', () => ({ value: TOOLS }))
  on('agent.list', () => ({ value: [{ id: 'agent-1', type: 'router:scout', description: 'find the parser', status: 'running' }] }))
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: [...e.argv], input: e.input })
    for (const line of opts.infer ?? []) yield { stream: 'stdout' as const, text: line + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* ($, e) {
    yield { kind: 'text' as const, index: 0, text: 'from Claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from Claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('classic.UserPromptSubmit', () => ({}))
  on('agent.spawn', ($, e) => ({ model: e.model ?? e.parentModel }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'Claude summary', toolUses: [] }] }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'from Claude', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('model.fork', () => ({ value: { isAnswered: true as const, text: 'Claude fork', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  return { spawned, completions, files }
}

const spawnInput = (over: Partial<AgentSpawnInput> = {}): AgentSpawnInput => ({
  tool_use_id: 'toolu_9', prompt: 'find it', description: 'find', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
} as AgentSpawnInput)

describe('the main loop', () => {
  test('/gpt use takes a short name; the step carries effort, reasoning, every tool and the conversation', async ($, on) => {
    const w = world(on, { infer: INFER })
    await $.session.start(session)
    expect((await $.command.run(run('use astra'))).text).toMatch(/^GPT-6-Astra now answers this session's main loop/)
    expect((await $.command.run(run('use luna'))).text).toBe('"luna" fits gpt-6-luna, gpt-5.6-luna; name one of them')
    const { chunks, result } = await drain($.turn.step(step({ effort: 'high' })))
    expect(chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
    expect(result).toEqual(expect.objectContaining({ answer: 'Ik lees x.txt.', stopReason: 'tool_use', toolUses: [{ name: 'Read', input: { file_path: 'C:/x.txt' } }] }))
    const body = JSON.parse(w.spawned[0].input ?? '{}')
    expect(body.model).toBe('gpt-6-astra')
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Read', 'Bash', 'mcp__slack__send', safeName(LONG_MCP), 'ToolSearch', INVOKE_TOOL])
    expect((await $.command.run(run('usage'))).text).toMatch(/^GPT in this session: 1 request · 1.2k in \(1.0k cached\) · 30 out/)
  })

  test('the next step sends the reasoning back in front of the turn it led to', async ($, on) => {
    const w = world(on, {
      infer: INFER,
      store: { reasoning: { [turnKey(['toolu_1'], 'Ik lees het.')]: { model: 'gpt-6-astra', items: [{ type: 'reasoning', id: 'rs_0', encrypted_content: 'old' }], at: 1 } } },
    })
    await $.session.start(session)
    await $.command.run(run('use gpt-6-astra'))
    await drain($.turn.step(step()))
    const body = JSON.parse(w.spawned[0].input ?? '{}')
    expect(body.input.some((item: { id?: string }) => item.id === 'rs_0')).toBe(true)
  })

  test('a reload brings back the model /gpt use picked for this session', async ($, on) => {
    const w = world(on, { infer: INFER, store: { 'active:S1': 'gpt-6-astra' } })
    await $.session.start(session)
    await drain($.turn.step(step()))
    expect(JSON.parse(w.spawned[0].input ?? '{}').model).toBe('gpt-6-astra')
  })

  test('schemas are refreshed from the newest types file at session start', async ($, on) => {
    const w = world(on, { infer: INFER, schemas: { Read: SCHEMAS.Read } })
    await $.session.start(session)
    await flush()
    await $.command.run(run('use astra'))
    await drain($.turn.step(step()))
    const tools = JSON.parse(w.spawned[0].input ?? '{}').tools as Array<{ name: string; parameters: { properties?: { tool?: { enum?: string[] } } } }>
    expect(tools.map(t => t.name)).toEqual(['Read', 'mcp__slack__send', safeName(LONG_MCP), INVOKE_TOOL])
    expect(tools.at(-1)?.parameters.properties?.tool?.enum).toEqual(['Bash', 'mcp__vault__list', 'ToolSearch'])
  })

  test('in auto mode, a call GPT made that would go to the classifier is refused with the reason', async ($, on) => {
    world(on, { infer: INFER })
    await $.session.start(session)
    await $.command.run(run('use astra'))
    await drain($.turn.step(step()))
    await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'auto' } as never)
    expect(await $.tool.check({ tool: 'Read', input: {}, tool_use_id: 'call_A' } as never)).toEqual({ decision: 'deny', reason: AUTO_MODE_REASON })
    expect(await $.tool.check({ tool: 'Read', input: {}, tool_use_id: 'toolu_claude' } as never)).toEqual({ decision: 'ask' })
    await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'default' } as never)
    expect(await $.tool.check({ tool: 'Read', input: {}, tool_use_id: 'call_A' } as never)).toEqual({ decision: 'ask' })
  })
})

describe('subagents', () => {
  test('with /gpt use they follow GPT; with agents claude they go back to Claude; an explicit model stands', async ($, on) => {
    world(on, { infer: INFER })
    await $.session.start(session)
    await $.command.run(run('use astra'))
    expect(await $.agent.spawn(spawnInput())).toEqual(expect.objectContaining({ model: 'gpt-6-astra' }))
    expect(await $.agent.spawn(spawnInput({ model: 'haiku' }))).toEqual(expect.objectContaining({ model: 'haiku' }))
    await $.command.run(run('agents claude'))
    expect(await $.agent.spawn(spawnInput({ parentModel: 'gpt-6-sol' }))).toEqual(expect.objectContaining({ model: 'sonnet' }))
  })

  test('a subagent on GPT gets its own conversation, role and definition', async ($, on) => {
    const w = world(on, {
      infer: INFER,
      files: {
        'C:\\Users\\me/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'router@platform-tools': [{ installPath: 'C:/plugins/router' }] } }),
        'C:/plugins/router/agents/scout.md': '---\nname: scout\n---\nSearch fast and report where things are.\n',
      },
    })
    await $.session.start(session)
    const { chunks } = await drain($.turn.step(step({ model: 'gpt-6-astra', agentId: 'agent-1' })))
    expect(chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
    const instructions = JSON.parse(w.spawned[0].input ?? '{}').instructions as string
    expect(instructions).toMatch(/^# Your role\nYou are a subagent of type "router:scout", started for: find the parser\./)
    expect(instructions).toMatch(/## Your instructions\nSearch fast and report where things are\./)
  })

  test('a subagent whose conversation cannot be read is told why', async ($, on) => {
    world(on, { infer: INFER })
    await $.session.start(session)
    const { chunks } = await drain($.turn.step(step({ model: 'gpt-6-astra', agentId: 'unreadable' })))
    expect(chunks[0]).toEqual(expect.objectContaining({ kind: 'text', text: expect.stringMatching(/cannot be read; give it a Claude model/) }))
  })
})

describe('calls outside a step', () => {
  test('a conversation GPT answers is compacted by GPT; ahead-of-time compaction is skipped', async ($, on) => {
    const w = world(on, { infer: INFER })
    await $.session.start(session)
    await $.command.run(run('use astra'))
    const compacted = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
    expect(compacted).toEqual({ messages: [{ role: 'user', text: expect.stringMatching(/ran out of context[\s\S]*\n\nSamenvatting\.$/), toolUses: [] }] })
    expect(JSON.parse(w.completions[0]).input.at(-1).content).toMatch(/^Write a summary of the conversation so far/)
    expect(await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never))
      .toEqual({ skip: expect.stringMatching(/not ahead of time/) })
  })

  test('Claude\'s conversation is compacted by Claude', async ($, on) => {
    const w = world(on, { infer: INFER })
    await $.session.start(session)
    expect(await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never))
      .toEqual(expect.objectContaining({ messages: [expect.objectContaining({ text: 'Claude summary' })] }))
    expect(w.completions).toEqual([])
  })

  // The test harness cannot raise another plugin's $.model calls, so the hooks' two parts are
  // checked apart: which calls they take, and the answer they build. The request itself is
  // complete(), which the compaction test above runs.
  test('model.complete is taken for the account\'s models only, and answers in $.model\'s shape', async () => {
    const s = freshState()
    s.models = MODELS
    expect(gptModel(s, 'gpt-6-sol')?.slug).toBe('gpt-6-sol')
    expect(gptModel(s, 'claude-haiku-5-5')).toBe(null)
    expect(completionValue({ ok: true, text: 'hoi', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, model: 'gpt-6-sol' } }))
      .toEqual({ isAnswered: true, text: 'hoi', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } })
    expect(completionValue({ ok: false, error: 'limit' })).toEqual(expect.objectContaining({ isAnswered: false, reason: 'api-error' }))
  })
})
