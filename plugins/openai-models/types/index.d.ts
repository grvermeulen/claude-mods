/** The display name of the OpenAI model answering this session, '' while Claude does. */
export type Answering = string

declare module 'claude-code' {
  interface PluginState {
    'openai-models': { answering: Answering }
  }
}
