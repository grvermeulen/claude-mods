import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import { LineReader, StepTranslator, instructionsFor, parseInfer, toInput, toolsFor } from './translate'
import type { ApiMessage } from './translate'

/** The display name of the model answering, '' while Claude does. */
const answering = atom({ plugin: 'openai-models', key: 'answering' } as const, '')

type Model = { slug: string; name: string }

export type State = {
  isWindows: boolean
  /** The Python that runs scripts/gpt.py; stdlib only, so any Python 3. */
  python: string
  /** The user settings file, where /gpt picker writes its rows. */
  settingsPath: string
  /** The model /gpt use picked for the main loop, over whatever the session runs. */
  active: Model | null
  /** The account's models as last listed; a step whose model is one of them goes to OpenAI. */
  models: Model[] | null
}

export function freshState(): State {
  return { isWindows: false, python: 'python3', settingsPath: '', active: null, models: null }
}

const HELP = '/gpt login · /gpt models · /gpt picker [off] · /gpt use <model> · /gpt off · /gpt status · /gpt logout · /gpt python <path>'

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

/** Which OpenAI model answers this step, if any: the step's own model when it is one of the account's, else /gpt use's on main. */
export function routeFor(s: State, e: TurnStepInput): Model | null {
  const named = s.models?.find(m => m.slug === e.model)
  if (named) return named
  return e.agentId ? null : s.active
}

function script(root: string): string {
  return `${root}/scripts/gpt.py`
}

/** Runs one gpt.py command to its end; its JSON lines, parsed. */
async function gpt($: EngineInterface, s: State, command: string, timeoutMs = 60_000): Promise<Array<Record<string, unknown>>> {
  const r = await $.process.run([s.python, '-I', script($.plugin.root), command], { timeoutMs })
  const lines = r.stdout.split(/\r?\n/).filter(line => line.trim())
  const parsed: Array<Record<string, unknown>> = []
  for (const line of lines) {
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
              ? `openai-models: signed in as ${String(event.email)}. /gpt models, then /gpt use <model>.`
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
  const [line] = await gpt($, s, 'models')
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

async function use($: EngineInterface, s: State, wanted: string): Promise<string> {
  const models = s.models ?? (await listModels($, s))
  if (typeof models === 'string') return `could not list your models: ${models}`
  if (!models.length) return 'your ChatGPT account lists no models for this app'
  let slug = wanted
  if (!slug) {
    if (models.length > 4) return `which one? /gpt use <model>, one of: ${models.map(m => m.slug).join(', ')}`
    const picked = await $.ui.ask('Which OpenAI model should answer this session?', { header: 'Model', options: models.map(m => m.name) })
    slug = models.find(m => m.name === picked)?.slug ?? ''
  }
  const model = models.find(m => m.slug === slug || m.name.toLowerCase() === slug.toLowerCase())
  if (!model) return `not one of your models: ${slug}. Yours: ${models.map(m => m.slug).join(', ')}`
  s.active = model
  await $.store.set('last', model.slug)
  await update($, answering, () => model.name)
  return `${model.name} now answers this session's turns, with Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch and TodoWrite. ` +
    'Subagents and MCP tools stay with Claude. /gpt off goes back to Claude.'
}

async function off($: EngineInterface, s: State): Promise<string> {
  if (!s.active) return 'Claude is already answering'
  const name = s.active.name
  s.active = null
  await update($, answering, () => '')
  return `Claude answers again (was ${name})`
}

async function status($: EngineInterface, s: State): Promise<string> {
  const [line] = await gpt($, s, 'status')
  const who = line?.type === 'status'
    ? line.signed_in ? `signed in as ${String(line.email)}${line.plan ? '' : ' (plan usage not allowed)'}` : 'not signed in (/gpt login)'
    : `status unknown: ${errorText(line)}`
  return `${who} · answering: ${s.active ? s.active.name : 'Claude'}`
}

async function command($: EngineInterface, s: State, args: string): Promise<string> {
  const [word, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  switch (word) {
    case 'login':
      return login($, s)
    case 'logout': {
      await off($, s)
      const [line] = await gpt($, s, 'logout')
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
      return use($, s, arg || '')
    case 'on':
      return use($, s, String((await $.store.get('last')) ?? ''))
    case 'off':
      return off($, s)
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
  const step = new StepTranslator(e.turnId, e.index, model.slug)
  const [messages, composed, tools] = await Promise.all([
    e.agentId ? $.session.messages({ as: 'api', agentId: e.agentId }) : $.session.messages({ as: 'api' }),
    $.prompt.compose(),
    $.tool.list(),
  ])
  if (!Array.isArray(messages)) {
    yield* step.fail('this subagent\'s conversation cannot be read; give it a Claude model')
    const { stop, result } = step.finish()
    yield stop
    return result
  }
  const offered = toolsFor(tools)
  const body = {
    model: model.slug,
    instructions: instructionsFor(composed.sections, tools, model.name),
    input: toInput(messages as unknown as ApiMessage[], new Set(offered.map(tool => tool.name))),
    tools: offered,
    tool_choice: 'auto',
    parallel_tool_calls: true,
  }
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
  yield stop
  return result
}

export const register: Register = on => {
  const s = freshState()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    s.isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const saved = await $.store.get('python')
    s.python = typeof saved === 'string' && saved ? saved : s.isWindows ? 'python' : 'python3'
    const models = await $.store.get('models')
    s.models = Array.isArray(models) ? (models as Model[]) : null
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
    s.settingsPath = `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`}/settings.json`
    await $.command.register({
      name: 'gpt',
      description: 'OpenAI models on your ChatGPT plan: sign in, pick a model to answer this session, or go back to Claude (openai-models)',
      argumentHint: '[login | models | picker [off] | use <model> | on | off | status | logout]',
      immediate: true,
    })
    return started
  })

  on('command.run', { command: 'gpt' }, async ($, e) => ({ text: await command($, s, String(e.args ?? '')) }))

  // A step whose model is one of the account's (picked in /model) goes to OpenAI, a
  // subagent's that inherited it too; with /gpt use, so does every step of the main loop.
  on('turn.step', async function* ($, e, next) {
    const model = routeFor(s, e)
    if (!model) return yield* next(e)
    return yield* answer($, s, model, e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const name = await read($, answering)
    if (!name || e.props.hasSurvey) return rest
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row">
          <Text>
            <Text bold color="success">● {name}</Text>
            <Text dimColor> answers in this session, on your ChatGPT plan </Text>
          </Text>
          <Button key="claude" label="Back to Claude" onPress={() => off($, s)} />
        </Box>
      </Box>
    )
  })
}
