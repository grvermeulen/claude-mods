# claude-mods

Claude Code mods: tweaked copies of community mods, as a plugin marketplace.

## cache-tax, with a Send anyway button

A copy of [cache-tax](https://github.com/karanb192/cache-tax) 2.2.1 by Karan Bansal. The original drops a prompt sent on a cold prompt cache and asks you to send it again to pay. This copy asks first, in Claude Code's own dialog:

- **Send anyway ($x)** lets the same prompt through as your own message. keepwarm then holds the cache for 3 hours.
- **Don't send** drops it, nothing paid.

The question says what each answer saves. Closing the dialog without an answer falls back to the original behaviour: refused once, the resend pays.

`/cache-tax guard test` asks the question on your next prompt without a cold cache, priced at the session's context, so you can see it. Nothing is scored.

Everything else (`/keepwarm`, `/cache-tax`, the band above the prompt) works as in the [original README](https://github.com/karanb192/cache-tax#readme).

## Install

Needs Claude Code 2.1.287 or later.

```bash
claude plugin marketplace add grvermeulen/claude-mods
claude plugin install cache-tax@guido-mods
```

If the original is installed, turn it off, or a cold send is guarded twice:

```bash
claude plugin disable cache-tax@claude-code-mods
```

Restart Claude Code afterwards.

## live-voice: talk to Claude, hands free

Claude Code's own voice mode is hold-to-talk or tap-to-talk. live-voice keeps listening instead: say what you want, and after a pause of 1.5 seconds it is sent as your prompt. When Claude answers, the reply is read aloud (code and tables left out, up to 700 characters), then it listens again.

- By default OpenAI hears and speaks: each utterance goes to `gpt-4o-transcribe`, and the reply is spoken by `gpt-4o-mini-tts` with the voice `marin`, streamed so it starts at once. Claude stays the one answering.
- `/listen engine local` keeps everything on your machine instead: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) hears, a Windows voice speaks (Microsoft Frank for Dutch).
- The microphone is paused while Claude works and while it talks, so it does not hear itself.
- A band above the prompt shows what it is doing, with **Stop talking** and **Off** buttons.

Windows only for now. Needs Python 3.10 or later, and for OpenAI an API key in the environment variable `OPENAI_API_KEY` (or `CHATGPT_API_KEY`), set before Claude starts. OpenAI bills transcription and speech per minute of audio.

```bash
claude plugin install live-voice@guido-mods
```

Then, in Claude Code:

| Command | What it does |
| --- | --- |
| `/listen setup` | One time: a Python environment in `~/.claude-live-voice` (with `engine local`, also faster-whisper and the Whisper model, about 600 MB) |
| `/listen` | Start or stop listening |
| `/listen engine local` | Whisper and a Windows voice instead of OpenAI; `engine openai` switches back |
| `/listen language en` | The language you speak and hear (`nl` by default, `auto` to detect) |
| `/listen voice cedar` | Another voice: an OpenAI voice (marin, cedar, coral, sage, …), or a Windows voice with `engine local` |
| `/listen speak off` | Stop reading replies aloud |
| `/listen device jabra` | Use another microphone, by part of its name or its number |
| `/listen model medium` | With `engine local`: a larger, slower, more accurate Whisper model; run `/listen setup` again to download it |

Anything near the microphone that sounds like speech becomes a prompt, with the permissions your session has. Turn it off when you are not talking to Claude.

## openai-models: GPT in Claude Code, on your ChatGPT plan (experimental)

Signs in with your ChatGPT account through OpenAI's [Sign in with ChatGPT for open-source and local apps](https://developers.openai.com/siwc/token-sharing-open-source), then lets an OpenAI model answer the turns of a Claude Code session in Claude's place. Usage counts against your ChatGPT plan, not an API key; ChatGPT's settings show it per app and can cap it.

```bash
claude plugin install openai-models@guido-mods
```

| Command | What it does |
| --- | --- |
| `/gpt login` | Opens your browser: sign in and allow plan usage. The tokens stay in `~/.config/claude-openai-models/credentials.json` |
| `/gpt models` | The models your account can use |
| `/gpt use <model>` | That model answers this session's turns; a band above the prompt says so, with **Back to Claude** |
| `/gpt off` | Claude answers again (`/gpt on` brings back the last model) |
| `/gpt status` · `/gpt logout` | Who is signed in · forget the tokens |

How it works and where it stops:

- The main loop's steps go to OpenAI's Responses API with Claude Code's own system prompt, the whole conversation, and Claude Code's core tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch and TodoWrite. Claude Code still runs every tool and asks you first where it would for Claude.
- A mod is not given the tools' schemas, so these nine are written out by hand; MCP tools are not offered to GPT, and calls Claude made to them reach it as text.
- Subagents keep running on Claude. Images in tool results reach GPT as "[image omitted]". GPT's reasoning is not carried from one step to the next.
- The `/model` picker cannot list these models: a mod cannot add choices to it.
- Needs Python 3 on the PATH (`/gpt python <path>` for another); `scripts/gpt.py` uses only its standard library.

## License

MIT. cache-tax is © 2026 Karan Bansal; see [plugins/cache-tax/LICENSE](plugins/cache-tax/LICENSE). live-voice is © 2026 Guido Vermeulen.
