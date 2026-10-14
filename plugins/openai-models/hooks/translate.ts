// Claude Code's side in, OpenAI's Responses API out, and back: the conversation as
// Responses input, the core tools as function schemas, and gpt.py's stream events as
// the step chunks the engine draws and runs.

import type { TurnStepChunk, TurnStepResult, TurnStopReason, TurnUsage } from 'claude-code'

export type ApiBlock = { type: string } & Record<string, unknown>
export type ApiMessage = { role: 'user' | 'assistant'; content: ApiBlock[] }
export type InputItem = Record<string, unknown>
export type FunctionTool = { type: 'function'; name: string; description: string; parameters: object; strict: false }

const str = { type: 'string' } as const
const num = { type: 'number' } as const
const bool = { type: 'boolean' } as const
const object = (properties: Record<string, object>, required: string[]) =>
  ({ type: 'object', properties, required, additionalProperties: false })

/**
 * The arguments of the tools GPT can call, as JSON schemas. The engine gives a mod
 * each tool's name and description but not its schema, so these follow Claude Code's
 * own argument types; a tool not listed here is not offered.
 */
export const TOOL_PARAMETERS: Record<string, object> = {
  Bash: object({
    command: { ...str, description: 'The command to execute' },
    timeout: { ...num, description: 'Optional timeout in milliseconds (max 600000)' },
    description: { ...str, description: 'What the command does, in a few plain words' },
    run_in_background: { ...bool, description: 'Run the command in the background' },
  }, ['command']),
  Read: object({
    file_path: { ...str, description: 'The absolute path to the file to read' },
    offset: { ...num, description: 'The line number to start reading from, for large files' },
    limit: { ...num, description: 'The number of lines to read, for large files' },
    pages: { ...str, description: 'Page range for PDF files, such as "1-5"' },
  }, ['file_path']),
  Write: object({
    file_path: { ...str, description: 'The absolute path to the file to write' },
    content: { ...str, description: 'The content to write to the file' },
  }, ['file_path', 'content']),
  Edit: object({
    file_path: { ...str, description: 'The absolute path to the file to modify' },
    old_string: { ...str, description: 'The exact text to replace' },
    new_string: { ...str, description: 'The text to replace it with (different from old_string)' },
    replace_all: { ...bool, description: 'Replace all occurrences of old_string (default false)' },
  }, ['file_path', 'old_string', 'new_string']),
  Glob: object({
    pattern: { ...str, description: 'The glob pattern to match files against' },
    path: { ...str, description: 'The directory to search in; omit for the working directory' },
  }, ['pattern']),
  Grep: object({
    pattern: { ...str, description: 'The regular expression to search for' },
    path: { ...str, description: 'File or directory to search in; defaults to the working directory' },
    glob: { ...str, description: 'Glob to filter files, such as "*.ts"' },
    output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Defaults to files_with_matches' },
    '-i': { ...bool, description: 'Case insensitive' },
    '-n': { ...bool, description: 'Line numbers (content mode)' },
    '-C': { ...num, description: 'Lines of context around each match (content mode)' },
    type: { ...str, description: 'File type, such as js or py' },
    head_limit: { ...num, description: 'Return only the first N results' },
    multiline: { ...bool, description: 'Let patterns span lines' },
  }, ['pattern']),
  WebFetch: object({
    url: { ...str, description: 'The URL to fetch' },
    prompt: { ...str, description: 'What to find or answer from the page' },
  }, ['url', 'prompt']),
  WebSearch: object({
    query: { ...str, description: 'The search query' },
    mode: { type: 'string', enum: ['standard', 'extended'], description: 'standard for quick lookups, extended for thorough research' },
  }, ['query', 'mode']),
  TodoWrite: object({
    todos: {
      type: 'array',
      items: object({
        content: str,
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        activeForm: str,
      }, ['content', 'status', 'activeForm']),
    },
  }, ['todos']),
}

const DESCRIPTION_CHARS = 1000

/** The listed tools GPT may call, their descriptions cut to a sentence end within 1000 characters. */
export function toolsFor(available: readonly { name: string; description: string }[]): FunctionTool[] {
  return available
    .filter(tool => TOOL_PARAMETERS[tool.name])
    .map(tool => ({ type: 'function', name: tool.name, description: shorten(tool.description, DESCRIPTION_CHARS), parameters: TOOL_PARAMETERS[tool.name], strict: false }))
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = cut.lastIndexOf('. ')
  return end > max / 2 ? cut.slice(0, end + 1) : cut
}

/** The system prompt for GPT: Claude Code's own, then who answers, then each tool's full guidance. */
export function instructionsFor(sections: readonly { text: string }[], tools: readonly { name: string; description: string }[], model: string): string {
  const guidance = tools
    .filter(tool => TOOL_PARAMETERS[tool.name] && tool.description.length > DESCRIPTION_CHARS)
    .map(tool => `### ${tool.name}\n${tool.description}`)
  return [
    ...sections.map(section => section.text),
    `# Who answers\nThis session runs on ${model}, an OpenAI model, in place of Claude. Where the text above says Claude, ` +
    'it means you. Call the functions to use tools; Claude Code runs them, may ask the user first, and returns their results.',
    ...(guidance.length ? ['# Full tool guidance', ...guidance] : []),
  ].join('\n\n')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block?.type === 'text' ? String(block.text ?? '') : block?.type === 'image' ? '[image omitted]' : ''))
    .filter(Boolean)
    .join('\n')
}

function imageUrl(block: ApiBlock): string | null {
  const source = block.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined
  if (source?.type === 'base64' && source.data) return `data:${source.media_type ?? 'image/png'};base64,${source.data}`
  if (source?.type === 'url' && source.url) return source.url
  return null
}

/**
 * The conversation as Responses input items. Calls to the tools GPT has keep their
 * native form; calls to any other tool (an MCP tool Claude used, say) become text,
 * since GPT has no schema for them.
 */
export function toInput(messages: readonly ApiMessage[], known: ReadonlySet<string>): InputItem[] {
  const items: InputItem[] = []
  const nameOf = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      let text = ''
      const flush = () => {
        if (text.trim()) items.push({ role: 'assistant', content: text.trim() })
        text = ''
      }
      for (const block of message.content) {
        if (block.type === 'text') text += String(block.text ?? '')
        if (block.type !== 'tool_use') continue
        const id = String(block.id), name = String(block.name)
        nameOf.set(id, name)
        if (known.has(name)) {
          flush()
          items.push({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(block.input ?? {}) })
        } else {
          text += `\n[called the tool ${name} with ${JSON.stringify(block.input ?? {})}]\n`
        }
      }
      flush()
      continue
    }
    const parts: InputItem[] = []
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const id = String(block.tool_use_id)
        const output = (block.is_error ? 'Error: ' : '') + textOf(block.content)
        if (known.has(nameOf.get(id) ?? '')) items.push({ type: 'function_call_output', call_id: id, output })
        else parts.push({ type: 'input_text', text: `[result of the tool ${nameOf.get(id) ?? 'call'}]\n${output}` })
      } else if (block.type === 'text') {
        parts.push({ type: 'input_text', text: String(block.text ?? '') })
      } else if (block.type === 'image') {
        const url = imageUrl(block)
        parts.push(url ? { type: 'input_image', image_url: url } : { type: 'input_text', text: '[image omitted]' })
      } else if (block.type === 'document') {
        parts.push({ type: 'input_text', text: '[a document was attached here]' })
      }
    }
    if (parts.length) items.push({ role: 'user', content: parts })
  }
  return items
}

/** One line of `gpt.py infer`, or null for anything else. */
export type InferEvent =
  | { type: 'text'; item: string; delta: string }
  | { type: 'tool'; item: string; call_id: string; name: string }
  | { type: 'args'; item: string; delta: string }
  | { type: 'done'; status: string; reason: string | null; usage: OpenAiUsage | null }
  | { type: 'error'; code: string; message: string; relogin?: boolean }

export type OpenAiUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }

export function parseInfer(line: string): InferEvent | null {
  try {
    const value = JSON.parse(line) as { type?: unknown }
    return ['text', 'tool', 'args', 'done', 'error'].includes(String(value.type)) ? (value as InferEvent) : null
  } catch {
    return null
  }
}

export function usageFrom(usage: OpenAiUsage | null, model: string): TurnUsage | null {
  if (!usage) return null
  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    model,
  }
}

/** What an error code means for the person, by OpenAI's Errors and recovery page. */
export function explain(code: string, message: string): string {
  if (code === 'not_signed_in' || code === 'subscription_sharing_invalid_user' || code === 'http_401') return 'not signed in to ChatGPT: /gpt login'
  if (code === 'subscription_sharing_usage_limit_exceeded') return 'your ChatGPT plan\'s usage limit for this app is reached (ChatGPT settings → Usage); /gpt off to go back to Claude'
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') return 'ChatGPT plan usage is unavailable right now; try again shortly, or /gpt off'
  if (code === 'subscription_sharing_user_not_eligible') return 'this ChatGPT account cannot use its plan in other apps; /gpt off'
  return `${message} (${code})`
}

/** Turns gpt.py's stream for one step into the engine's chunks and, at the end, the step's result. */
export class StepTranslator {
  private nextIndex = 0
  private readonly indexOf = new Map<string, number>()
  private readonly calls: Array<{ item: string; name: string; json: string }> = []
  private answer = ''
  private stopReason: TurnStopReason = 'end_turn'
  private usage: TurnUsage | null = null
  isDone = false

  constructor(private readonly turnId: string, private readonly index: number, private readonly model: string) {}

  private blockFor(item: string): number {
    let index = this.indexOf.get(item)
    if (index === undefined) {
      index = this.nextIndex++
      this.indexOf.set(item, index)
    }
    return index
  }

  push(event: InferEvent): TurnStepChunk[] {
    switch (event.type) {
      case 'text':
        this.answer += event.delta
        return [{ kind: 'text', index: this.blockFor(event.item), text: event.delta }]
      case 'tool':
        this.calls.push({ item: event.item, name: event.name, json: '' })
        return [{ kind: 'tool', index: this.blockFor(event.item), id: event.call_id, name: event.name }]
      case 'args': {
        const call = this.calls.find(c => c.item === event.item)
        if (call) call.json += event.delta
        return [{ kind: 'input', index: this.blockFor(event.item), json: event.delta }]
      }
      case 'done':
        this.isDone = true
        this.usage = usageFrom(event.usage, this.model)
        this.stopReason = this.calls.length ? 'tool_use'
          : event.status === 'incomplete' && event.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn'
        return []
      case 'error':
        return this.fail(explain(event.code, event.message))
    }
  }

  /** Ends the step with the reason as text the person reads, and no tool calls. */
  fail(reason: string): TurnStepChunk[] {
    this.isDone = true
    this.calls.length = 0
    this.stopReason = 'end_turn'
    const text = `${this.answer ? '\n\n' : ''}[OpenAI: ${reason}]`
    this.answer += text
    return [{ kind: 'text', index: this.blockFor('openai-models:error'), text }]
  }

  finish(): { stop: TurnStepChunk; result: TurnStepResult } {
    const toolUses = this.calls.map(call => {
      let input: unknown = {}
      try {
        input = call.json ? JSON.parse(call.json) : {}
      } catch {
        // Broken JSON leaves the call without arguments, as a model's broken JSON would.
      }
      return { name: call.name, input }
    })
    return {
      stop: { kind: 'stop', stopReason: this.stopReason, usage: this.usage },
      result: { turnId: this.turnId, index: this.index, answer: this.answer, toolUses, stopReason: this.stopReason, usage: this.usage },
    }
  }
}

/** Cuts a stream of text pieces into whole lines; a piece may end mid-line. */
export class LineReader {
  private rest = ''

  push(piece: string): string[] {
    const lines = (this.rest + piece).split(/\r?\n/)
    this.rest = lines.pop() ?? ''
    return lines.filter(line => line.trim() !== '')
  }
}
