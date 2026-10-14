/** Where the conversation stands: drawn in the band above the prompt. */
export type Phase = 'off' | 'loading' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking'

declare module 'claude-code' {
  interface PluginState {
    'live-voice': { phase: Phase; heard: string }
  }
}
