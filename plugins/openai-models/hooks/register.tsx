import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code'

import { SHIPPED_SCHEMAS } from './tool-schemas'
import { LineReader, StepTranslator, buildToolset, explain, harvestSchemas, instructionsFor, parseInfer, toInput, usageFrom } from './translate'
import type { ApiMessage, InputItem, Toolset } from './translate'

/** The display name of the model answering the main loop, '' while Claude does. */
const answering = atom({ plugin: 'openai-models', key: 'answering' } as const, '')
/** The band's second part: usage, and a warning when there is one. */
const detail = atom({ plugin: 'openai-models', key: 'detail' } as const, '')

type Model = { slug: string; name: string }
type Usage = { requests: number; input: number; cached: number; output: number; lastError: string }
/** follow: a subagent answers with whoever answers its parent; claude: subagents always run on Claude. */
type AgentsMode = 'follow' | 'claude'

export type State = {
  isWindows: boolean
  /** The Python that runs scripts/gpt.py; stdlib only, so any Python 3. */
  python: string
  home: string
  /** Claude Code's config folder: the user settings and the installed plugins' record. */
  configDir: string
  settingsPath: string
  cwd: string
  sessionId: string
  /** The model /gpt use picked for the main loop, over whatever the session runs. */
  active: Model | null
  /** The account's models as last listed; a step whose model is one of them goes to OpenAI. */
  models: Model[] | null
  agents: AgentsMode
  /** Claude Code's tool argument schemas: refreshed at session start, else the shipped ones. */
  schemas: Record<string, object>
  /** Which model answers each loop ('main' or an agent's id) while GPT does. */
  loops: Map<string, string>
  /** Tool calls GPT asked for, for the permission check. */
  gptCalls: Set<string>
  permissionMode: string | undefined
  usage: Usage
  /** GPT's reasoning items by turn key, so a later step can send them back. */
  reasoning: Record<string, { model: string; items: InputItem[]; at: number }>
  /** The last Claude model the main loop ran, for subagents kept on Claude. */
  lastClaude: string | null
  /** Agent definitions read so far, by agent type. */
  definitions: Map<string, string | null>
}

export function freshState(): State {
  return {
    isWindows: false, python: 'python3', home: '.', configDir: '.claude', settingsPath: '', cwd: '.', sessionId: '',
    active: null, models: null, agents: 'follow', schemas: SHIPPED_SCHEMAS, loops: new Map(), gptCalls: new Set(),
    permissionMode: undefined, usage: freshUsage(), reasoning: {}, lastClaude: null, definitions: new Map(),
  }
}

function freshUsage(): Usage {
  return { requests: 0, input: 0, cached: 0, output: 0, lastError: '' }
}

const HELP = '/gpt login · /gpt models · /gpt picker [off] · /gpt use <model> · /gpt off · /gpt agents follow|claude · ' +
  '/gpt usage · /gpt schemas · /gpt status · /gpt logout · /gpt python <path>'

/** How many turns' reasoning is kept between steps; older turns go back without theirs. */
const REASONING_KEEP = 60

export const AUTO_MODE_REASON = 'Claude Code is in auto mode, where Anthropic\'s server-side classifier approves actions, ' +
  'and it judges only Claude\'s own requests, so it cannot approve one GPT asked for. Ask the user to switch the permission ' +
  'mode (Shift+Tab) to default or accept edits while GPT answers, then try again.'

const COMPACT_INSTRUCTIONS = 'Write a summary of the conversation so far that lets the work continue without it: the user\'s ' +
  'requests and intent, key decisions and technical details, the files and code touched (with paths), errors and how they ' +
  'were fixed, what is done, what is pending, and the task in progress. Be specific; this summary replaces the conversation.'
const COMPACT_HEADER = 'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.'

/** Marks the /model picker rows this mod wrote, so it can find and replace only its own. */
const PICKER_TAG = '(openai-models)'

type PickerRow = { model: string; label?: string; description?: string; behavesAs?: string }

/** The settings with this mod's picker rows replaced by `models`' (none for `off`), other rows kept. */
export function withPickerRows(settings: Record<string, unknown>, models: readonly Model[]): Record<string, unknown> {
  const picker = (settings.modelPicker ?? {}) as { options?: PickerRow[]; replaceBuiltInOptions?: boolean }
  const others = (picker.options ?? []).filter(row => !row.description?.endsWith(PICKER_TAG))
  const ours = models.map(m => ({ model: m.slug, label: `${m.name} (ChatGPT)`, description: `OpenAI on your ChatGPT plan ${PICKER_TAG}` }))
  const options = [...others, ...ours]
  const next = { ...settings }
  if (options.length) next.modelPicker = { ...picker, options }
  else delete next.modelPicker
  return next
}

/** Exact IDs and names win; otherwise a part of the ID (astra, 6.1-sol) that names one model. */
export function resolveModel(models: readonly Model[], wanted: string): Model[] {
  const query = wanted.trim().toLowerCase()
  if (!query) return []
  const exact = models.find(m => m.slug.toLowerCase() === query || m.name.toLowerCase() === query)
  if (exact) return [exact]
  const suffix = models.filter(m => m.slug.toLowerCase().endsWith(`-${query}`))
  return suffix.length ? suffix : models.filter(m => m.slug.toLowerCase().includes(query))
}

export function gptModel(s: State, model: string | undefined): Model | null {
  return model ? s.models?.find(m => m.slug === model) ?? null : null
}

/** Which OpenAI model answers this step, if any: the step's own model when it is one of the account's, else /gpt use's on main. */
export function routeFor(s: State, e: TurnStepInput): Model | null {
  return gptModel(s, e.model) ?? (e.agentId ? null : s.active)
}

/** Claude Code's effort as OpenAI's reasoning effort; a thinking budget in tokens by its size. */
export function effortFor(effort: TurnStepInput['effort']): string | undefined {
  if (effort === undefined) return undefined
  if (typeof effort === 'number') return effort <= 4000 ? 'low' : effort <= 16000 ? 'medium' : 'high'
  return effort === 'max' ? 'xhigh' : effort
}

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function usageText(u: Usage): string {
  return `${u.requests} request${u.requests === 1 ? '' : 's'} · ${kilo(u.input + u.cached)} in (${kilo(u.cached)} cached) · ${kilo(u.output)} out`
}

function script(root: string): string {
  return `${root}/scripts/gpt.py`
}

/** Runs one gpt.py command to its end; its JSON lines, parsed. */
async function gpt($: EngineInterface, s: State, command: string[], timeoutMs = 60_000): Promise<Array<Record<string, unknown>>> {
  const r = await $.process.run([s.python, '-I', script($.plugin.root), ...command], { timeoutMs })
  const parsed: Array<Record<string, unknown>> = []
  for (const line of r.stdout.split(/\r?\n/).filter(l => l.trim())) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      // Not one of gpt.py's lines.
    }
  }
  if (!parsed.length) parsed.push({ type: 'error', code: 'local', message: (r.stderr.trim().split(/\r?\n/).at(-1) || `exit ${r.exitCode}`) })
  return parsed
}

function errorText(line: Record<string, unknown> | undefined): string {
  return String(line?.message ?? 'no answer from gpt.py')
}

/** One request to OpenAI without tool calls, its text gathered: for summaries and other plugins' completions. */
async function complete($: EngineInterface, s: State, slug: string, instructions: string, input: InputItem[], tools: readonly object[] = []):
  Promise<{ ok: true; text: string; usage: TurnUsage | null } | { ok: false; error: string }> {
  const body = { model: slug, instructions, input, ...(tools.length ? { tools, tool_choice: 'none' } : {}) }
  const r = await $.process.run([s.python, '-I', script($.plugin.root), 'infer'], { stdin: JSON.stringify(body), timeoutMs: 300_000 })
  let text = ''
  let usage: TurnUsage | null = null
  let error = ''
  for (const line of r.stdout.split(/\r?\n/)) {
    const event = parseInfer(line)
    if (event?.type === 'text') text += event.delta
    else if (event?.type === 'done') usage = usageFrom(event.usage, slug)
    else if (event?.type === 'error') error = explain(event.code, event.message)
  }
  if (error || !text) return { ok: false, error: error || r.stderr.trim().split(/\r?\n/).at(-1) || 'no text came back' }
  await count($, s, usage, '')
  return { ok: true, text, usage }
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function modelUsage(usage: TurnUsage | null) {
  return usage
    ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: 0 }
    : ZERO_USAGE
}

/** A completion's outcome as $.model.complete and $.model.fork answer it. */
export function completionValue(r: { ok: true; text: string; usage: TurnUsage | null } | { ok: false; error: string }) {
  return r.ok
    ? { isAnswered: true as const, text: r.text, usage: modelUsage(r.usage) }
    : { isAnswered: false as const, reason: 'api-error' as const, status: null, error: 'unknown' as const, usage: ZERO_USAGE }
}

async function count($: EngineInterface, s: State, usage: TurnUsage | null, error: string) {
  s.usage.requests += 1
  if (usage) {
    s.usage.input += usage.input_tokens
    s.usage.cached += usage.cache_read_input_tokens
    s.usage.output += usage.output_tokens
  }
  s.usage.lastError = error
  await $.store.set(`usage:${s.sessionId}`, s.usage)
  await refreshBand($, s)
}

async function refreshBand($: EngineInterface, s: State) {
  const slug = s.loops.get('main') ?? s.active?.slug
  const name = slug ? gptModel(s, slug)?.name ?? s.active?.name ?? slug : ''
  await update($, answering, () => name)
  const notes = [usageText(s.usage)]
  if (s.permissionMode === 'auto') notes.push('auto mode cannot approve GPT\'s edits or commands: switch the mode with Shift+Tab')
  if (s.usage.lastError) notes.push(`last error: ${s.usage.lastError}`)
  await update($, detail, () => notes.join(' · '))
}

/** The model answering a loop with GPT: an agent's from its last step, main's also from /gpt use or the session's model. */
async function loopModel($: EngineInterface, s: State, agentId: string | undefined): Promise<string | null> {
  if (agentId) return s.loops.get(agentId) ?? null
  return s.loops.get('main') ?? s.active?.slug ?? gptModel(s, await $.session.model())?.slug ?? null
}

/** The body of an agent definition file, its frontmatter left out. */
export function definitionBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

/** An agent type's own instructions: a plugin's agents/<name>.md, or a project's or the user's. Null for a built-in. */
async function agentDefinition($: EngineInterface, s: State, type: string): Promise<string | null> {
  if (s.definitions.has(type)) return s.definitions.get(type) ?? null
  const [plugin, name] = type.includes(':') ? type.split(':', 2) : [null, type]
  const candidates: string[] = []
  if (plugin) {
    try {
      const installed = JSON.parse(await $.fs.read(`${s.configDir}/plugins/installed_plugins.json`)) as
        { plugins?: Record<string, Array<{ installPath?: string }>> }
      for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
        if (id.split('@')[0] === plugin) for (const entry of entries) if (entry.installPath) candidates.push(`${entry.installPath}/agents/${name}.md`)
      }
    } catch {
      // No record of installed plugins.
    }
  } else {
    candidates.push(`${s.cwd}/.claude/agents/${name}.md`, `${s.configDir}/agents/${name}.md`)
  }
  let found: string | null = null
  for (const path of candidates) {
    if (await $.fs.exists(path)) {
      found = definitionBody(await $.fs.read(path))
      break
    }
  }
  s.definitions.set(type, found)
  return found
}

/** What a subagent running on GPT is told about itself: its type, its task, and its definition's own instructions. */
async function agentRole($: EngineInterface, s: State, agent: { type: string; description: string } | undefined): Promise<string> {
  const type = agent?.type ?? 'general-purpose'
  const base = `You are a subagent of type "${type}"${agent?.description ? `, started for: ${agent.description}` : ''}. ` +
    'Your task is the first user message. The agent that started you sees only your final message, ' +
    'so end with a complete, self-contained report of what you found or did.'
  const definition = await agentDefinition($, s, type)
  return definition ? `${base}\n\n## Your instructions\n${definition}` : base
}

/** GPT's reasoning for a turn, when the same model wrote it. */
function reasoningFor(s: State, key: string, slug: string): InputItem[] | undefined {
  const entry = s.reasoning[key]
  return entry && entry.model === slug ? entry.items : undefined
}

async function keepReasoning($: EngineInterface, s: State, key: string, slug: string, items: InputItem[]) {
  if (!items.length) return
  s.reasoning[key] = { model: slug, items, at: await $.clock.now() }
  const keys = Object.keys(s.reasoning).sort((a, b) => s.reasoning[b].at - s.reasoning[a].at)
  for (const old of keys.slice(REASONING_KEEP)) delete s.reasoning[old]
  await $.store.set('reasoning', s.reasoning)
}

async function login($: EngineInterface, s: State): Promise<string> {
  const stream = $.process.spawn({ argv: [s.python, '-I', script($.plugin.root), 'login'] })
  void (async () => {
    const lines = new LineReader()
    try {
      for await (const { stream: pipe, text } of stream) {
        if (pipe === 'stderr') continue
        for (const line of lines.push(text)) {
          const event = JSON.parse(line) as Record<string, unknown>
          if (event.type === 'open') {
            $.ui.toast('Sign in with ChatGPT in the browser window that opened')
            $.ui.log(`openai-models: if no browser opened, open this to sign in: ${String(event.url)}`)
          } else if (event.type === 'signed_in') {
            s.models = null
            $.ui.log(event.plan
              ? `openai-models: signed in as ${String(event.email)}. /gpt picker or /gpt use <model>.`
              : `openai-models: signed in as ${String(event.email)}, but using your ChatGPT plan was not allowed.`)
          } else if (event.type === 'error') {
            $.ui.log(`openai-models: sign-in failed: ${errorText(event)}`)
          }
        }
      }
    } catch (err) {
      $.ui.log(`openai-models: sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
  return 'Opening your browser to sign in with ChatGPT. You sign in and allow plan usage there; this waits up to five minutes.'
}

async function listModels($: EngineInterface, s: State): Promise<Model[] | string> {
  const [line] = await gpt($, s, ['models'])
  if (line?.type !== 'models') return errorText(line)
  s.models = (line.models as Model[]) ?? []
  await $.store.set('models', s.models)
  return s.models
}

async function picker($: EngineInterface, s: State, isOff: boolean): Promise<string> {
  const models = isOff ? [] : await listModels($, s)
  if (typeof models === 'string') return `could not list your models: ${models}`
  let settings: Record<string, unknown> = {}
  if (await $.fs.exists(s.settingsPath)) {
    try {
      settings = JSON.parse(await $.fs.read(s.settingsPath)) as Record<string, unknown>
    } catch {
      return `${s.settingsPath} is not valid JSON; fix it first, nothing was changed`
    }
  }
  await $.fs.write(s.settingsPath, JSON.stringify(withPickerRows(settings, models), null, 2) + '\n')
  return isOff
    ? 'The ChatGPT models are off the /model picker.'
    : `${models.length} ChatGPT models added to the /model picker, after Claude's. Picking one makes it answer this session, ` +
      'subagents included; pick a Claude model to go back. Restart Claude if the picker does not show them yet.'
}

function autoModeNote(s: State): string {
  return s.permissionMode === 'auto' ? `\nNote: ${AUTO_MODE_REASON}` : ''
}

async function use($: EngineInterface, s: State, wanted: string): Promise<string> {
  const models = s.models ?? (await listModels($, s))
  if (typeof models === 'string') return `could not list your models: ${models}`
  if (!models.length) return 'your ChatGPT account lists no models for this app'
  let query = wanted
  if (!query) {
    if (models.length > 4) return `which one? /gpt use <model>, one of: ${models.map(m => m.slug).join(', ')}`
    query = await $.ui.ask('Which OpenAI model should answer this session?', { header: 'Model', options: models.map(m => m.name) })
  }
  const matches = resolveModel(models, query)
  if (matches.length > 1) return `"${query}" fits ${matches.map(m => m.slug).join(', ')}; name one of them`
  const model = matches[0]
  if (!model) return `not one of your models: ${query}. Yours: ${models.map(m => m.slug).join(', ')}`
  s.active = model
  await $.store.set('last', model.slug)
  await $.store.set(`active:${s.sessionId}`, model.slug)
  await refreshBand($, s)
  return `${model.name} now answers this session's main loop, with Claude Code's tools` +
    `${s.agents === 'follow' ? ' and the subagents it starts' : '; subagents stay on Claude'}. /gpt off goes back to Claude.${autoModeNote(s)}`
}

async function off($: EngineInterface, s: State): Promise<string> {
  if (!s.active) return 'Claude is already answering (a ChatGPT model picked in /model is changed there)'
  const name = s.active.name
  s.active = null
  s.loops.delete('main')
  await $.store.delete(`active:${s.sessionId}`)
  await refreshBand($, s)
  return `Claude answers again (was ${name})`
}

async function status($: EngineInterface, s: State): Promise<string> {
  const [line] = await gpt($, s, ['status'])
  const who = line?.type === 'status'
    ? line.signed_in ? `signed in as ${String(line.email)}${line.plan ? '' : ' (plan usage not allowed)'}` : 'not signed in (/gpt login)'
    : `status unknown: ${errorText(line)}`
  const main = await loopModel($, s, undefined)
  return `${who} · answering: ${main ? gptModel(s, main)?.name ?? main : 'Claude'} · subagents: ${s.agents} · ` +
    `this session: ${usageText(s.usage)}${autoModeNote(s)}`
}

async function refreshSchemas($: EngineInterface, s: State): Promise<string> {
  const [line] = await gpt($, s, ['schemas', '--plugin', $.plugin.root], 30_000)
  if (line?.type !== 'schemas') return `kept the ${Object.keys(s.schemas).length} tool schemas in use: ${errorText(line)}`
  const record = JSON.parse(await $.fs.read(String(line.out))) as { schemas?: Record<string, object> }
  if (record.schemas && Object.keys(record.schemas).length) s.schemas = record.schemas
  return `${Object.keys(s.schemas).length} tool schemas read from ${String(line.source)}`
}

async function command($: EngineInterface, s: State, args: string): Promise<string> {
  const [word, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  switch (word) {
    case 'login':
      return login($, s)
    case 'logout': {
      await off($, s)
      const [line] = await gpt($, s, ['logout'])
      return line?.type === 'signed_out' ? 'signed out of ChatGPT' : `sign-out failed: ${errorText(line)}`
    }
    case 'models': {
      const models = await listModels($, s)
      if (typeof models === 'string') return `could not list your models: ${models}`
      return models.length ? models.map(m => `${m.slug}  ${m.name}`).join('\n') : 'no models listed for this account'
    }
    case 'picker':
      return picker($, s, arg === 'off')
    case 'use':
      return use($, s, arg)
    case 'on':
      return use($, s, String((await $.store.get('last')) ?? ''))
    case 'off':
      return off($, s)
    case 'agents':
      if (arg !== 'follow' && arg !== 'claude') return `subagents: ${s.agents}. /gpt agents follow (they answer with whoever answers their parent) or claude (always Claude)`
      s.agents = arg
      await $.store.set('agents', arg)
      return arg === 'follow' ? 'Subagents now answer with whoever answers the loop that starts them.' : 'Subagents now always run on Claude.'
    case 'usage':
      return `GPT in this session: ${usageText(s.usage)}${s.usage.lastError ? ` · last error: ${s.usage.lastError}` : ''}. ` +
        'It counts against your ChatGPT plan; ChatGPT settings → Usage shows the limit. Claude Code\'s own cost line does not price GPT.'
    case 'schemas':
      return refreshSchemas($, s)
    case 'python':
      if (!arg) return `gpt.py runs with ${s.python}; /gpt python <path> picks another`
      s.python = arg
      await $.store.set('python', arg)
      return `gpt.py now runs with ${arg}`
    case 'status':
    case undefined:
      return `${await status($, s)}\n${HELP}`
    default:
      return HELP
  }
}

/** One step, of the main loop or a subagent's, answered by an OpenAI model instead of Claude. */
async function* answer($: EngineInterface, s: State, model: Model, e: TurnStepInput): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const [messages, composed, tools, agents] = await Promise.all([
    e.agentId ? $.session.messages({ as: 'api', agentId: e.agentId }) : $.session.messages({ as: 'api' }),
    $.prompt.compose(),
    $.tool.list(),
    e.agentId ? $.agent.list() : Promise.resolve([]),
  ])
  if (!Array.isArray(messages)) {
    const failing = new StepTranslator(e.turnId, e.index, model.slug)
    yield* failing.fail('this subagent\'s conversation cannot be read; give it a Claude model')
    const { stop, result } = failing.finish()
    yield stop
    return result
  }
  const api = messages as unknown as ApiMessage[]
  const toolset: Toolset = buildToolset(tools, s.schemas, harvestSchemas(api))
  const role = e.agentId ? await agentRole($, s, agents.find(a => a.id === e.agentId)) : undefined
  const effort = effortFor(e.effort)
  const body = {
    model: model.slug,
    instructions: instructionsFor(composed.sections, toolset, model.name, role),
    input: toInput(api, { toolset, reasoning: key => reasoningFor(s, key, model.slug) }),
    tools: toolset.tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    ...(effort ? { reasoning: { effort } } : {}),
  }
  const step = new StepTranslator(e.turnId, e.index, model.slug, toolset)
  const lines = new LineReader()
  let errors = ''
  try {
    const child = $.process.spawn({ argv: [s.python, '-I', script($.plugin.root), 'infer'], input: JSON.stringify(body) })
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        errors += text
        continue
      }
      for (const line of lines.push(text)) {
        const event = parseInfer(line)
        if (event) yield* step.push(event)
      }
    }
  } catch (err) {
    errors += err instanceof Error ? err.message : String(err)
  }
  if (!step.isDone) yield* step.fail(errors.trim().split(/\r?\n/).at(-1) || 'gpt.py ended without an answer')
  const { stop, result } = step.finish()
  for (const id of step.callIds()) s.gptCalls.add(id)
  for (const notice of step.notices) $.ui.log(`openai-models: ${notice}`)
  await keepReasoning($, s, step.key(), model.slug, step.reasoning)
  await count($, s, result.usage, /\[OpenAI: (.*)\]$/.exec(result.answer)?.[1] ?? '')
  yield stop
  return result
}

export const register: Register = on => {
  const s = freshState()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    s.isWindows = (await $.env.get('OS')) === 'Windows_NT'
    s.cwd = e.cwd
    s.sessionId = await $.session.id()
    const python = await $.store.get('python')
    s.python = typeof python === 'string' && python ? python : s.isWindows ? 'python' : 'python3'
    const models = await $.store.get('models')
    s.models = Array.isArray(models) ? (models as Model[]) : null
    const agents = await $.store.get('agents')
    s.agents = agents === 'claude' ? 'claude' : 'follow'
    const reasoning = await $.store.get('reasoning')
    s.reasoning = reasoning && typeof reasoning === 'object' ? (reasoning as State['reasoning']) : {}
    const usage = await $.store.get(`usage:${s.sessionId}`)
    s.usage = usage && typeof usage === 'object' ? { ...freshUsage(), ...(usage as Usage) } : freshUsage()
    // A reload starts the module afresh; the model /gpt use picked for this session comes back.
    const active = await $.store.get(`active:${s.sessionId}`)
    s.active = (typeof active === 'string' && gptModel(s, active)) || null
    s.home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
    s.configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${s.home}/.claude`
    s.settingsPath = `${s.configDir}/settings.json`
    await $.command.register({
      name: 'gpt',
      description: 'OpenAI models on your ChatGPT plan: sign in, pick a model to answer this session, or go back to Claude (openai-models)',
      argumentHint: '[login | models | picker [off] | use <model> | on | off | agents follow|claude | usage | schemas | status | logout]',
      immediate: true,
    })
    await refreshBand($, s)
    void refreshSchemas($, s).catch(() => undefined)
    return started
  })

  on('command.run', { command: 'gpt' }, async ($, e) => ({ text: await command($, s, String(e.args ?? '')) }))

  // A step whose model is one of the account's (picked in /model, or given to a subagent) goes to
  // OpenAI; with /gpt use, so does every step of the main loop.
  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? 'main'
    const model = routeFor(s, e)
    if (!model) {
      if (s.loops.delete(loop) && !e.agentId) await refreshBand($, s)
      if (!e.agentId) s.lastClaude = e.model
      return yield* next(e)
    }
    if (s.loops.get(loop) !== model.slug) {
      s.loops.set(loop, model.slug)
      if (!e.agentId) await refreshBand($, s)
    }
    return yield* answer($, s, model, e)
  })

  // A subagent follows whoever answers the loop that starts it, or stays on Claude, as /gpt agents says.
  // An explicit model in the Agent call, and a fork (which always inherits), are left alone.
  on('agent.spawn', async ($, e, next) => {
    if (e.model || e.fork) return next(e)
    const parent = await loopModel($, s, e.parentAgentId)
    const parentIsGpt = Boolean(gptModel(s, e.parentModel))
    if (s.agents === 'follow' && parent && !parentIsGpt) return next({ ...e, model: parent })
    if (s.agents === 'claude' && parentIsGpt) return next({ ...e, model: s.lastClaude ?? 'sonnet' })
    return next(e)
  })

  // A conversation GPT answers is summarized by GPT when it compacts.
  on('session.compact', async ($, e, next) => {
    const slug = await loopModel($, s, e.agentId)
    if (!slug) return next(e)
    if (e.trigger === 'precompute') return { skip: 'GPT answers this conversation; it is summarized when it compacts, not ahead of time' }
    const messages = e.agentId ? await $.session.messages({ as: 'api', agentId: e.agentId }) : await $.session.messages({ as: 'api' })
    if (!Array.isArray(messages)) return next(e)
    const api = messages as unknown as ApiMessage[]
    const toolset = buildToolset(await $.tool.list(), s.schemas, harvestSchemas(api))
    const ask = `${COMPACT_INSTRUCTIONS}${e.instructions ? `\n\nAlso: ${e.instructions}` : ''}`
    const r = await complete($, s, slug, 'You summarize conversations between a user and a coding agent.',
      [...toInput(api, { toolset }), { role: 'user', content: ask }], toolset.tools)
    if (!r.ok) return { skip: `GPT could not summarize the conversation: ${r.error}` }
    return { messages: [{ role: 'user', text: `${COMPACT_HEADER}\n\n${r.text}`, toolUses: [] }] }
  })

  // Another plugin's $.model.complete naming one of the account's models goes to OpenAI.
  on('model.complete', async ($, e, next) => {
    const model = gptModel(s, e.model)
    if (!model) return next(e)
    return { value: completionValue(await complete($, s, model.slug, e.system ?? '', [{ role: 'user', content: e.prompt }])) }
  })

  // A fork of the main thread (another plugin's $.model.fork) goes to the model answering it.
  on('model.fork', async ($, e, next) => {
    const slug = await loopModel($, s, undefined)
    if (!slug) return next(e)
    const api = (await $.session.messages({ as: 'api' })) as unknown as ApiMessage[]
    if (!api.length) return { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
    const toolset = buildToolset(await $.tool.list(), s.schemas, harvestSchemas(api))
    const composed = await $.prompt.compose()
    return {
      value: completionValue(await complete($, s, slug, instructionsFor(composed.sections, toolset, slug),
        [...toInput(api, { toolset }), { role: 'user', content: e.prompt }], toolset.tools)),
    }
  })

  // The permission mode, as the classic hook events carry it, for the auto-mode check and the band.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode && e.permission_mode !== s.permissionMode) {
      s.permissionMode = e.permission_mode
      await refreshBand($, s)
    }
    return next(e)
  })

  on('classic.PreToolUse', async ($, e, next) => {
    if (e.permission_mode) s.permissionMode = e.permission_mode
    return next(e)
  })

  // In auto mode the server-side classifier decides an ask, and it cannot judge a call GPT made:
  // such a call is refused with the reason and the way out, instead of failing without one.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (!e.tool_use_id || !s.gptCalls.has(e.tool_use_id) || s.permissionMode !== 'auto' || verdict.decision !== 'ask') return verdict
    return { decision: 'deny' as const, reason: AUTO_MODE_REASON }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const name = await read($, answering)
    if (!name || e.props.hasSurvey) return rest
    const note = await read($, detail)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row">
          <Text>
            <Text bold color="success">● {name}</Text>
            <Text dimColor>{` answers on your ChatGPT plan · ${note} `}</Text>
          </Text>
          {s.active ? <Button key="claude" label="Back to Claude" onPress={() => off($, s)} /> : null}
        </Box>
      </Box>
    )
  })
}
