/** The display name of the OpenAI model answering the main loop, '' while Claude does. */
export type Answering = string
/** The band's second part: GPT's usage this session, and a warning when there is one. */
export type Detail = string

declare module 'claude-code' {
  interface PluginState {
    'openai-models': { answering: Answering; detail: Detail }
  }
}
