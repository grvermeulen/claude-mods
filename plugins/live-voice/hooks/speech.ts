// What crosses between the mod and its two helpers: listen.py's JSON lines in,
// plain speakable text out.

export type ListenerEvent =
  | { type: 'ready' | 'speech' | 'heard' | 'ignored' }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }

/** One line of listen.py's output; null for anything that is not one of its events. */
export function parseEvent(line: string): ListenerEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.type === 'text') return typeof v.text === 'string' && v.text.trim() ? { type: 'text', text: v.text.trim() } : null
  if (v.type === 'error') return { type: 'error', message: typeof v.message === 'string' ? v.message : 'unknown error' }
  if (v.type === 'ready' || v.type === 'speech' || v.type === 'heard' || v.type === 'ignored') return { type: v.type }
  return null
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

/**
 * Turns a markdown reply into text worth reading aloud: code blocks, tables and
 * links' targets go, the markup goes, and the result stops at a sentence end
 * within `max` characters.
 */
export function forSpeech(markdown: string, max: number): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .filter(line => !/^\s*\|/.test(line))
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~\n]+?)(?<=\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return end > max / 3 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…'
}
