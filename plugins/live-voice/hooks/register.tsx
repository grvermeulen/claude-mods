import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase } from '../types'
import { LineReader, forSpeech, parseEvent } from './speech'
import type { ListenerEvent } from './speech'

const phase = atom({ plugin: 'live-voice', key: 'phase' } as const, 'off')
const heard = atom({ plugin: 'live-voice', key: 'heard' } as const, '')

// A pause this long after the last words sends them; talking again inside it adds to them.
export const SEND_AFTER_MS = 1500
const SPOKEN_CHARS = 700
const MODELS = ['tiny', 'base', 'small', 'medium']
const HINT = 'on | off | status | setup | engine openai|local | language nl | speak on|off | voice <name> | device <name> | model small'

const LABELS: Record<Phase, string> = {
  off: 'off',
  loading: 'starting…',
  listening: 'listening',
  hearing: 'hearing you…',
  transcribing: 'writing down what you said…',
  thinking: 'Claude is working',
  speaking: 'speaking',
}

/** openai: OpenAI hears and speaks (gpt-4o-transcribe, gpt-4o-mini-tts); local: Whisper and a Windows voice. */
export type Engine = 'openai' | 'local'
export type Settings = { engine: Engine; language: string; speak: boolean; device: string; model: string; voice: string }
const DEFAULTS: Settings = { engine: 'openai', language: 'nl', speak: true, device: '', model: 'small', voice: '' }
const OPENAI_VOICE = 'marin'

type Stream = ReturnType<EngineInterface['process']['spawn']>

export type State = {
  settings: Settings
  isWindows: boolean
  /** ~/.claude-live-voice: the venv, the models and the control files. */
  dir: string
  /** The file listen.py and speak.ps1 poll: listen, pause, hush or stop. */
  control: string
  listener: Stream | null
  ended: Promise<void>
  speaking: boolean
  isStopping: boolean
  /** What was said since the last send, waiting out SEND_AFTER_MS. */
  words: string[]
  sendTimer: { cancel: () => void } | null
}

export function freshState(): State {
  return {
    settings: { ...DEFAULTS }, isWindows: false, dir: '', control: '', listener: null, ended: Promise.resolve(),
    speaking: false, isStopping: false, words: [], sendTimer: null,
  }
}

export function settingsFrom(raw: unknown): Settings {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const text = (key: 'language' | 'device' | 'model' | 'voice') => (typeof v[key] === 'string' ? (v[key] as string) : DEFAULTS[key])
  return {
    engine: v.engine === 'local' || v.engine === 'openai' ? v.engine : DEFAULTS.engine,
    language: text('language'),
    speak: typeof v.speak === 'boolean' ? v.speak : DEFAULTS.speak,
    device: text('device'),
    model: text('model'),
    voice: text('voice'),
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : '…' + text.slice(text.length - max + 1)
}

function python(s: State): string {
  return s.isWindows ? `${s.dir}/venv/Scripts/python.exe` : `${s.dir}/venv/bin/python`
}

function describe(s: State): string {
  const { engine, language, model, speak, device, voice } = s.settings
  const ears = engine === 'openai' ? 'OpenAI' : `Whisper ${model}`
  const mouth = engine === 'openai' ? voice || OPENAI_VOICE : voice || 'Windows'
  return `language ${language} · ${ears} · read aloud ${speak ? `on (${mouth})` : 'off'} · microphone ${device || 'default'}`
}

/** The API key the scripts will read, by either name; never stored or shown. */
async function hasKey($: EngineInterface): Promise<boolean> {
  return Boolean((await $.env.get('OPENAI_API_KEY')) || (await $.env.get('CHATGPT_API_KEY')))
}

function cancelSend(s: State) {
  s.sendTimer?.cancel()
  s.sendTimer = null
}

async function setPhase($: EngineInterface, p: Phase) {
  await update($, phase, () => p)
}

async function setControl($: EngineInterface, s: State, word: 'listen' | 'pause' | 'hush' | 'stop') {
  await $.fs.write(s.control, word)
}

async function start($: EngineInterface, s: State): Promise<string> {
  if (s.listener) return 'live voice is already on'
  const isOpenai = s.settings.engine === 'openai'
  if (!(await $.fs.exists(python(s)))) {
    return isOpenai
      ? 'live voice needs its setup first: /listen setup (a minute; a Python environment with sounddevice)'
      : 'live voice needs its speech setup first: /listen setup (a few minutes; Python packages and the Whisper model, about 600 MB)'
  }
  if (isOpenai && !(await hasKey($))) {
    return 'live voice with OpenAI needs an API key in the environment variable OPENAI_API_KEY (or CHATGPT_API_KEY). ' +
      'Set it, restart Claude, and /listen again; or /listen engine local for Whisper and a Windows voice.'
  }
  s.isStopping = false
  await setControl($, s, 'listen')
  await setPhase($, 'loading')
  const argv = [python(s), '-I', `${$.plugin.root}/scripts/listen.py`, '--engine', s.settings.engine,
    '--language', s.settings.language, '--control', s.control]
  if (!isOpenai) argv.push('--models', `${s.dir}/models`, '--model', s.settings.model)
  if (s.settings.device) argv.push('--device', s.settings.device)
  const stream = $.process.spawn({ argv, env: { HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' } })
  s.listener = stream
  s.ended = follow($, s, stream)
  return `live voice starting: ${describe(s)}. Talk once the band says listening; /listen off stops it.`
}

/** Reads listen.py for as long as it runs; its end, for whatever reason, turns voice off. */
async function follow($: EngineInterface, s: State, stream: Stream) {
  const lines = new LineReader()
  const errors: string[] = []
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        errors.push(text)
        continue
      }
      for (const line of lines.push(text)) {
        const event = parseEvent(line)
        if (event) await onEvent($, s, event)
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  } finally {
    if (s.listener === stream) s.listener = null
    cancelSend(s)
    s.words = []
    try {
      await update($, heard, () => '')
      await setPhase($, 'off')
      if (!s.isStopping) {
        const why = errors.join('').trim().split(/\r?\n/).slice(-2).join(' ')
        $.ui.log(`live voice stopped${why ? `: ${why}` : ''}`)
      }
    } catch {
      // The module is unloading; nothing is left to draw on.
    }
  }
}

async function stop($: EngineInterface, s: State): Promise<string> {
  const stream = s.listener
  if (!stream) return 'live voice is off'
  s.isStopping = true
  cancelSend(s)
  await setControl($, s, 'stop')
  await Promise.race([s.ended, $.clock.sleep(3000)])
  if (s.listener === stream) void stream.return(undefined)
  return 'live voice off'
}

async function onEvent($: EngineInterface, s: State, event: ListenerEvent) {
  switch (event.type) {
    case 'ready':
      await setPhase($, 'listening')
      $.ui.toast('live voice: listening')
      return
    case 'speech':
      cancelSend(s)
      await setPhase($, 'hearing')
      return
    case 'heard':
      await setPhase($, 'transcribing')
      return
    case 'ignored':
      await setPhase($, 'listening')
      if (s.words.length) schedule($, s)
      return
    case 'error':
      $.ui.log(`live voice: ${event.message}`)
      return
    case 'text':
      s.words.push(event.text)
      await update($, heard, () => s.words.join(' '))
      await setPhase($, 'listening')
      schedule($, s)
  }
}

function schedule($: EngineInterface, s: State) {
  cancelSend(s)
  s.sendTimer = $.clock.after(SEND_AFTER_MS, () => {
    void send($, s)
  })
}

async function send($: EngineInterface, s: State) {
  s.sendTimer = null
  const text = s.words.join(' ').trim()
  s.words = []
  if (!text || !s.listener) return
  await setControl($, s, 'pause')
  await setPhase($, 'thinking')
  // The person's own words, so Claude reads them bare, not framed as a plugin's message.
  const entered = await $.prompt.submit({ text, asUser: true })
  if (entered.drop !== undefined) {
    $.ui.log(`live voice: not sent, ${entered.drop}`)
    await resume($, s)
  }
}

async function resume($: EngineInterface, s: State) {
  if (!s.listener) return
  await update($, heard, () => '')
  await setControl($, s, 'listen')
  await setPhase($, 'listening')
}

/** The command that speaks on this machine with this engine; null where the engine's own speech is used. */
function speaker(root: string, s: State): string[] | null {
  const language = s.settings.language === 'auto' ? 'nl' : s.settings.language
  if (s.settings.engine === 'openai') {
    return [python(s), '-I', `${root}/scripts/speak.py`, '--voice', s.settings.voice || OPENAI_VOICE,
      '--language', language, '--control', s.control]
  }
  if (!s.isWindows) return null
  const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', `${root}/scripts/speak.ps1`, '-Language', language, '-StopFile', s.control]
  if (s.settings.voice) argv.push('-Voice', s.settings.voice)
  return argv
}

async function say($: EngineInterface, s: State, text: string) {
  s.speaking = true
  try {
    const argv = speaker($.plugin.root, s)
    if (argv) {
      let errors = ''
      for await (const { stream, text: out } of $.process.spawn({ argv, input: text })) {
        if (stream === 'stderr') errors += out
      }
      if (errors.trim()) $.ui.log(`live voice could not speak: ${errors.trim().split(/\r?\n/).at(-1)}`)
    } else {
      await $.audio.speak(text, s.settings.voice ? { voice: s.settings.voice } : undefined)
    }
  } catch (err) {
    $.ui.log(`live voice could not speak: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    s.speaking = false
  }
}

/** After a turn: read the reply aloud, then listen again. */
async function answer($: EngineInterface, s: State, text: string) {
  if (text) {
    await setPhase($, 'speaking')
    await say($, s, text)
  }
  await resume($, s)
}

async function setup($: EngineInterface, s: State): Promise<string> {
  if (!s.isWindows) return 'setup runs on Windows only for now; elsewhere create the venv by hand (see the README)'
  $.ui.toast(`live voice: setting up for ${s.settings.engine === 'openai' ? 'OpenAI, a minute' : 'Whisper, a few minutes'}…`)
  const r = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', `${$.plugin.root}/scripts/setup.ps1`, '-Dir', s.dir, '-Engine', s.settings.engine, '-Model', s.settings.model],
  { timeoutMs: 600_000 })
  if (r.exitCode === 0) return 'live voice is set up. /listen to start.'
  const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-4).join('\n')
  return `live voice setup failed (exit ${r.exitCode}):\n${tail}`
}

async function save($: EngineInterface, s: State, change: Partial<Settings>, restart: boolean): Promise<string> {
  s.settings = { ...s.settings, ...change }
  await $.store.set('settings', s.settings)
  if (!restart || !s.listener) return describe(s)
  await stop($, s)
  return start($, s)
}

async function command($: EngineInterface, s: State, args: string): Promise<string> {
  const [word, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  switch (word) {
    case undefined:
      return s.listener ? stop($, s) : start($, s)
    case 'on':
      return start($, s)
    case 'off':
      return stop($, s)
    case 'status':
      return `live voice ${LABELS[await read($, phase)]} · ${describe(s)}`
    case 'setup':
      return setup($, s)
    case 'engine':
      if (arg !== 'openai' && arg !== 'local') return '/listen engine takes openai (OpenAI hears and speaks) or local (Whisper and a Windows voice)'
      return save($, s, { engine: arg, voice: '' }, true)
    case 'language':
      if (!/^([a-z]{2}|auto)$/.test(arg)) return '/listen language takes a code such as nl or en, or auto'
      return save($, s, { language: arg }, true)
    case 'speak':
      if (arg !== 'on' && arg !== 'off') return '/listen speak takes on or off'
      return save($, s, { speak: arg === 'on' }, false)
    case 'device':
      if (!arg) return '/listen device takes part of the microphone\'s name, its number, or default'
      return save($, s, { device: arg === 'default' ? '' : arg }, true)
    case 'model':
      if (!MODELS.includes(arg)) return `/listen model takes ${MODELS.join(', ')}; a new one needs /listen setup to download it`
      return save($, s, { model: arg }, true)
    case 'voice':
      if (!arg) {
        return s.settings.engine === 'openai'
          ? '/listen voice takes an OpenAI voice (marin, cedar, coral, sage, alloy, ash, ballad, echo, fable, nova, onyx, shimmer, verse) or default'
          : '/listen voice takes a Windows voice\'s name (Microsoft Frank) or default'
      }
      return save($, s, { voice: arg === 'default' ? '' : arg }, false)
    default:
      return `/listen [${HINT}]`
  }
}

export const register: Register = on => {
  const s = freshState()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    s.isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
    s.dir = `${home}/.claude-live-voice`
    s.control = `${s.dir}/control-${await $.session.id()}.txt`
    s.settings = settingsFrom(await $.store.get('settings'))
    await $.command.register({
      name: 'listen',
      description: 'Hands-free voice: talk to Claude and hear the reply (live-voice)',
      argumentHint: `[${HINT}]`,
      immediate: true,
    })
    return started
  })

  on('command.run', { command: 'listen' }, async ($, e) => ({ text: await command($, s, String(e.args ?? '')) }))

  // A prompt the person types while voice is on stops the microphone for the turn too.
  on('turn.start', async ($, e, next) => {
    if (s.listener) {
      cancelSend(s)
      s.words = []
      await setControl($, s, 'pause')
      await setPhase($, 'thinking')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId || !s.listener) return done
    const reply = 'answer' in e && typeof e.answer === 'string' ? e.answer : ''
    void answer($, s, e.isAborted || !s.settings.speak ? '' : forSpeech(reply, SPOKEN_CHARS))
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const now = await read($, phase)
    if (now === 'off' || e.props.hasSurvey) return rest
    const said = await read($, heard)
    const { Box, Button, Text } = $.ui.resolve(e)
    const live = now === 'listening' || now === 'hearing'
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row">
          <Text>
            <Text bold color={live ? 'success' : undefined}>● live voice</Text>
            <Text dimColor>{` · ${LABELS[now]}${said ? ` · “${clip(said, 80)}”` : ''} `}</Text>
          </Text>
          {now === 'speaking' && s.speaking ? (
            <Button key="hush" label="Stop talking" onPress={() => setControl($, s, 'hush')} />
          ) : null}
          <Button key="off" label="Off" onPress={() => stop($, s)} />
        </Box>
      </Box>
    )
  })
}
