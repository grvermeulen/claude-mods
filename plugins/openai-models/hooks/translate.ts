// Claude Code's side in, OpenAI's Responses API out, and back: the conversation as
// Responses input, Claude Code's tools as function schemas, and gpt.py's stream events as
// the step chunks the engine draws and runs.

import type { TurnStepChunk, TurnStepResult, TurnStopReason, TurnUsage } from 'claude-code'

export type ApiBlock = { type: string } & Record<string, unknown>
export type ApiMessage = { role: 'user' | 'assistant'; content: ApiBlock[] }
export type InputItem = Record<string, unknown>
export type FunctionTool = { type: 'function'; name: string; description: string; parameters: object; strict: false }
export type ToolInfo = { name: string; description: string; mcp?: boolean }

/** The function GPT calls a tool through when that tool is not offered as a function of its own. */
export const INVOKE_TOOL = 'invoke_tool'
const DESCRIPTION_CHARS = 1000
const MAX_NATIVE_TOOLS = 120
const CATALOGUE_CHARS = 8000
const GUIDANCE_CHARS = 60_000
const THINKING_CHARS = 4000

/** FNV-1a, 32 bits, as 8 hex digits: a short, stable name for a long one. */
export function fnv(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** A name OpenAI takes for a function (letters, digits, _ and -, at most 64), the same every time. */
export function safeName(name: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && name !== INVOKE_TOOL) return name
  return `t${fnv(name)}_${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(-50)}`
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = cut.lastIndexOf('. ')
  return end > max / 2 ? cut.slice(0, end + 1) : cut
}

function firstSentence(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? ''
  const end = line.search(/\.(\s|$)/)
  return (end > 0 ? line.slice(0, end + 1) : line).slice(0, 160).trim()
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).filter(Boolean).join('\n')
}

export type Harvested = Map<string, { description: string; parameters: object }>

/**
 * The schemas ToolSearch has loaded into the conversation: its results carry each tool as
 * `<function>{"name", "description", "parameters"}</function>`, which is how a deferred MCP
 * tool's schema reaches the model at all.
 */
export function harvestSchemas(messages: readonly ApiMessage[]): Harvested {
  const found: Harvested = new Map()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      for (const match of textOf(block.content).matchAll(/<function>([\s\S]*?)<\/function>/g)) {
        try {
          const spec = JSON.parse(match[1]) as { name?: string; description?: string; parameters?: object }
          if (spec.name && spec.parameters) found.set(spec.name, { description: spec.description ?? '', parameters: spec.parameters })
        } catch {
          // Not a schema.
        }
      }
    }
  }
  return found
}

export type Toolset = {
  tools: FunctionTool[]
  /** The name GPT sees → the tool's own. */
  real: Map<string, string>
  /** The tool's own name → the name GPT sees. */
  safe: Map<string, string>
  /** Tools offered as functions of their own. */
  native: Set<string>
  /** Tools GPT reaches through invoke_tool. */
  catalogue: Set<string>
  /** Tools whose description was cut, for the full text in the instructions. */
  shortened: ToolInfo[]
}

/**
 * Every tool the model can call now, as GPT gets it: with a schema (Claude Code's own for a
 * built-in, ToolSearch's for an MCP tool) as a function of its own; without one, by name
 * through invoke_tool, whose arguments Claude Code checks against the real schema.
 */
export function buildToolset(available: readonly ToolInfo[], schemas: Record<string, object>, harvested: Harvested): Toolset {
  const set: Toolset = { tools: [], real: new Map(), safe: new Map(), native: new Set(), catalogue: new Set(), shortened: [] }
  for (const tool of available) {
    const parameters = harvested.get(tool.name)?.parameters ?? schemas[tool.name]
    if (!parameters || set.tools.length >= MAX_NATIVE_TOOLS) {
      set.catalogue.add(tool.name)
      continue
    }
    const name = safeName(tool.name)
    const description = tool.description || harvested.get(tool.name)?.description || ''
    set.real.set(name, tool.name)
    set.safe.set(tool.name, name)
    set.native.add(tool.name)
    set.tools.push({ type: 'function', name, description: shorten(description, DESCRIPTION_CHARS), parameters, strict: false })
    if (description.length > DESCRIPTION_CHARS) set.shortened.push({ name: tool.name, description })
  }
  if (set.catalogue.size) {
    let list = ''
    for (const name of set.catalogue) {
      const line = `\n- ${name}: ${firstSentence(available.find(t => t.name === name)?.description ?? '')}`
      if (list.length + line.length > CATALOGUE_CHARS) {
        list += `\n- … and ${set.catalogue.size - list.split('\n- ').length + 1} more; ToolSearch loads any tool's schema by name`
        break
      }
      list += line
    }
    set.tools.push({
      type: 'function',
      name: INVOKE_TOOL,
      description: 'Calls one of Claude Code\'s tools that is not offered as a function of its own, by its exact name, ' +
        'with its arguments as an object. Claude Code checks them against the tool\'s real schema and answers with an error ' +
        'naming what is wrong; ToolSearch with "select:<name>" shows a tool\'s full schema first. Tools reachable this way:' + list,
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: [...set.catalogue], description: 'The tool\'s exact name' },
          input: { type: 'object', description: 'The tool\'s arguments' },
        },
        required: ['tool', 'input'],
      },
      strict: false,
    })
    set.real.set(INVOKE_TOOL, INVOKE_TOOL)
  }
  return set
}

/** The system prompt for GPT: its role (for a subagent), Claude Code's own prompt, who answers, and full tool guidance. */
export function instructionsFor(sections: readonly { text: string }[], toolset: Toolset, model: string, role?: string): string {
  const guidance: string[] = []
  let size = 0
  for (const tool of toolset.shortened) {
    const text = `### ${tool.name}\n${tool.description}`
    if (size + text.length > GUIDANCE_CHARS) break
    guidance.push(text)
    size += text.length
  }
  return [
    ...(role ? [`# Your role\n${role}`] : []),
    ...sections.map(section => section.text),
    `# Who answers\nThis session runs on ${model}, an OpenAI model, in place of Claude. Where the text above says Claude, ` +
    'it means you. Call the functions to use tools; Claude Code runs them, may ask the user first, and returns their results.',
    ...(guidance.length ? ['# Full tool guidance', ...guidance] : []),
  ].join('\n\n')
}

function imageUrl(block: ApiBlock): string | null {
  const source = block.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined
  if (source?.type === 'base64' && source.data) return `data:${source.media_type ?? 'image/png'};base64,${source.data}`
  if (source?.type === 'url' && source.url) return source.url
  return null
}

/** A document block as Responses input: a PDF as a file, text as text, a URL as a file by URL. */
export function documentPart(block: ApiBlock): InputItem {
  const source = (block.source ?? {}) as { type?: string; media_type?: string; data?: unknown; url?: string; content?: unknown }
  const title = typeof block.title === 'string' ? block.title : ''
  if (source.type === 'base64' && typeof source.data === 'string') {
    return { type: 'input_file', filename: title || 'document.pdf', file_data: `data:${source.media_type ?? 'application/pdf'};base64,${source.data}` }
  }
  if (source.type === 'text' && typeof source.data === 'string') return { type: 'input_text', text: `${title ? `Document: ${title}\n` : ''}${source.data}` }
  if (source.type === 'url' && source.url) return { type: 'input_file', file_url: source.url }
  if (source.type === 'content') return { type: 'input_text', text: `${title ? `Document: ${title}\n` : ''}${textOf(source.content)}` }
  return { type: 'input_text', text: '[a document was attached here]' }
}

/** Content blocks as Responses content parts. */
function parts(blocks: readonly ApiBlock[]): InputItem[] {
  const out: InputItem[] = []
  for (const block of blocks) {
    if (block.type === 'text') out.push({ type: 'input_text', text: String(block.text ?? '') })
    else if (block.type === 'image') {
      const url = imageUrl(block)
      out.push(url ? { type: 'input_image', image_url: url } : { type: 'input_text', text: '[image omitted]' })
    } else if (block.type === 'document') out.push(documentPart(block))
  }
  return out
}

/** A tool result as a function output: a string, or parts when it holds images or files. */
function output(block: ApiBlock): string | InputItem[] {
  const error = block.is_error ? 'Error: ' : ''
  if (typeof block.content === 'string') return error + block.content
  const content = parts((block.content ?? []) as ApiBlock[])
  if (content.every(p => p.type === 'input_text')) return error + content.map(p => String(p.text)).join('\n')
  return error ? [{ type: 'input_text', text: 'Error:' }, ...content] : content
}

export type InputContext = {
  toolset: Toolset
  /** GPT's own reasoning items for an assistant turn, kept between steps, by turn key. */
  reasoning?: (key: string) => InputItem[] | undefined
}

/** How an assistant turn's reasoning is filed: by its first tool call, else by its text. */
export function turnKey(callIds: readonly string[], text: string): string {
  return callIds.length ? `call:${callIds[0]}` : `text:${fnv(text.trim())}`
}

/**
 * The conversation as Responses input items. Calls to tools GPT has as functions keep their
 * native form, as do calls through invoke_tool; anything else becomes text. GPT's own
 * reasoning items go back in front of the turn they led to; Claude's thinking goes in as text.
 */
export function toInput(messages: readonly ApiMessage[], ctx: InputContext): InputItem[] {
  const { toolset } = ctx
  const items: InputItem[] = []
  const asText = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      const out: InputItem[] = []
      const callIds: string[] = []
      let text = ''
      let said = ''
      const flush = () => {
        if (text.trim()) out.push({ role: 'assistant', content: text.trim() })
        text = ''
      }
      for (const block of message.content) {
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          text += `[earlier reasoning]\n${block.thinking.trim().slice(0, THINKING_CHARS)}\n[/earlier reasoning]\n`
        } else if (block.type === 'text') {
          text += String(block.text ?? '')
          said += String(block.text ?? '')
        } else if (block.type === 'tool_use') {
          const id = String(block.id)
          const name = String(block.name)
          const args = block.input ?? {}
          callIds.push(id)
          if (toolset.native.has(name)) {
            flush()
            out.push({ type: 'function_call', call_id: id, name: toolset.safe.get(name) ?? name, arguments: JSON.stringify(args) })
          } else if (toolset.catalogue.has(name)) {
            flush()
            out.push({ type: 'function_call', call_id: id, name: INVOKE_TOOL, arguments: JSON.stringify({ tool: name, input: args }) })
          } else {
            asText.set(id, name)
            text += `\n[called the tool ${name} with ${JSON.stringify(args)}]\n`
          }
        }
      }
      flush()
      items.push(...(ctx.reasoning?.(turnKey(callIds, said)) ?? []), ...out)
      continue
    }
    const content: InputItem[] = []
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const id = String(block.tool_use_id)
        if (asText.has(id)) {
          const result = output(block)
          content.push({ type: 'input_text', text: `[result of the tool ${asText.get(id)}]\n${typeof result === 'string' ? result : textOf(block.content)}` })
        } else {
          items.push({ type: 'function_call_output', call_id: id, output: output(block) })
        }
      } else {
        content.push(...parts([block]))
      }
    }
    if (content.length) items.push({ role: 'user', content })
  }
  return items
}

/** One line of `gpt.py infer`, or null for anything else. */
export type InferEvent =
  | { type: 'text'; item: string; delta: string }
  | { type: 'tool'; item: string; call_id: string; name: string }
  | { type: 'args'; item: string; delta: string }
  | { type: 'reasoning'; item: InputItem }
  | { type: 'notice'; message: string }
  | { type: 'done'; status: string; reason: string | null; usage: OpenAiUsage | null }
  | { type: 'error'; code: string; message: string; relogin?: boolean }

export type OpenAiUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }

export function parseInfer(line: string): InferEvent | null {
  try {
    const value = JSON.parse(line) as { type?: unknown }
    return ['text', 'tool', 'args', 'reasoning', 'notice', 'done', 'error'].includes(String(value.type)) ? (value as InferEvent) : null
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
  private readonly calls: Array<{ id: string; name: string; json: string }> = []
  private readonly callByItem = new Map<string, { id: string; name: string; json: string }>()
  /** invoke_tool calls, held until their arguments name the tool. */
  private readonly invokes: Array<{ item: string; id: string; json: string }> = []
  private answer = ''
  private stopReason: TurnStopReason = 'end_turn'
  private usage: TurnUsage | null = null
  readonly reasoning: InputItem[] = []
  readonly notices: string[] = []
  isDone = false

  constructor(private readonly turnId: string, private readonly index: number, private readonly model: string,
    private readonly toolset?: Toolset) {}

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
      case 'reasoning':
        this.reasoning.push(event.item)
        return []
      case 'notice':
        this.notices.push(event.message)
        return []
      case 'tool': {
        if (event.name === INVOKE_TOOL) {
          this.invokes.push({ item: event.item, id: event.call_id, json: '' })
          return []
        }
        const call = { id: event.call_id, name: this.toolset?.real.get(event.name) ?? event.name, json: '' }
        this.calls.push(call)
        this.callByItem.set(event.item, call)
        return [{ kind: 'tool', index: this.blockFor(event.item), id: call.id, name: call.name }]
      }
      case 'args': {
        const held = this.invokes.find(c => c.item === event.item)
        if (held) {
          held.json += event.delta
          return []
        }
        const call = this.callByItem.get(event.item)
        if (call) call.json += event.delta
        return [{ kind: 'input', index: this.blockFor(event.item), json: event.delta }]
      }
      case 'done': {
        this.isDone = true
        this.usage = usageFrom(event.usage, this.model)
        const chunks = this.flushInvokes()
        this.stopReason = this.calls.length ? 'tool_use'
          : event.status === 'incomplete' && event.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn'
        return chunks
      }
      case 'error':
        return this.fail(explain(event.code, event.message))
    }
  }

  /** The invoke_tool calls, now that their arguments are whole, as calls to the tools they name. */
  private flushInvokes(): TurnStepChunk[] {
    const chunks: TurnStepChunk[] = []
    for (const held of this.invokes.splice(0)) {
      let spec: { tool?: unknown; input?: unknown } = {}
      try {
        spec = JSON.parse(held.json || '{}')
      } catch {
        // Handled below as a call that names no tool.
      }
      if (typeof spec.tool !== 'string' || !spec.tool) {
        const text = '\n[GPT called invoke_tool without naming a tool]'
        this.answer += text
        chunks.push({ kind: 'text', index: this.blockFor(held.item), text })
        continue
      }
      const input = JSON.stringify(spec.input && typeof spec.input === 'object' ? spec.input : {})
      const index = this.blockFor(held.item)
      this.calls.push({ id: held.id, name: spec.tool, json: input })
      chunks.push({ kind: 'tool', index, id: held.id, name: spec.tool }, { kind: 'input', index, json: input })
    }
    return chunks
  }

  /** Ends the step with the reason as text the person reads, and no tool calls. */
  fail(reason: string): TurnStepChunk[] {
    this.isDone = true
    this.calls.length = 0
    this.callByItem.clear()
    this.invokes.length = 0
    this.stopReason = 'end_turn'
    const text = `${this.answer ? '\n\n' : ''}[OpenAI: ${reason}]`
    this.answer += text
    return [{ kind: 'text', index: this.blockFor('openai-models:error'), text }]
  }

  /** The tool calls GPT made, by id, for the permission check. */
  callIds(): string[] {
    return this.calls.map(c => c.id)
  }

  /** Where this step's reasoning is filed, matching turnKey on the transcript later. */
  key(): string {
    return turnKey(this.callIds(), this.answer)
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
