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
| `/gpt picker` | Adds them to the `/model` picker, after Claude's, through the `modelPicker` setting in your user settings; pick one and it answers the session, subagents included. `/gpt picker off` takes them out again |
| `/gpt use <model>` | Without the picker: that model answers this session's main loop. A part of the ID will do (`astra`, `6.1-sol`) when it names one model. It stays picked for the session across a plugin reload |
| `/gpt off` | Claude answers again (`/gpt on` brings back the last model) |
| `/gpt agents follow` · `/gpt agents claude` | Subagents answer with whoever answers the loop that starts them (the default), or always run on Claude |
| `/gpt usage` | GPT's requests and tokens in this session, and the last error from OpenAI |
| `/gpt schemas` | Reads Claude Code's tool schemas again (it also does at every session start) |
| `/gpt status` · `/gpt logout` | Who is signed in and who answers · forget the tokens |

How it works:

- **Tools.** GPT gets every tool the session can call. Claude Code does not hand a mod the tools' schemas, so the mod reads them from the types file Claude Code's plugin tooling writes (all 79 built-in tools on 2.1.295), refreshes them at session start, and ships a copy for when it finds none. A deferred MCP tool gets its schema the way Claude gets it: once ToolSearch has loaded it into the conversation, the mod takes the schema from there. A tool with no schema at all is reachable through one `invoke_tool` function by its name; Claude Code checks its arguments against the real schema. Names OpenAI does not accept (over 64 characters) are shortened and mapped back.
- **Permissions.** Claude Code still runs every tool, with the same permission checks it gives Claude.
- **Subagents** started while GPT answers run on GPT too (`/gpt agents claude` keeps them on Claude; a model the Agent call names stands). A subagent on GPT gets its own conversation and a role naming its type and task; for a plugin's, project's or your own agent, its definition file's instructions too.
- **Compaction** of a conversation GPT answers is written by GPT. Another plugin's `$.model.complete` naming a ChatGPT model, and its `$.model.fork` while GPT answers, go to OpenAI too.
- **Context.** Claude's thinking goes to GPT as text; PDFs as files, text documents as text; images in tool results as images. GPT's own reasoning is carried from step to step (encrypted, as OpenAI returns it), and Claude Code's effort setting becomes GPT's reasoning effort. A model that refuses one of these gets the request again without it, and the band says so.
- **Usage.** The band and `/gpt usage` count GPT's requests and tokens; Claude Code's own cost line does not price GPT. Cache Tax leaves GPT's turns out of Claude's cache clock, size and cost.
- **Sign-in.** The ID token's signature is checked against OpenAI's published keys, with its issuer, audience, nonce and expiry. No token is put in a URL or a log line, and on Windows the token folder is cut to your account alone.

Where it stops:

- **Auto mode.** Claude Code's auto mode approves actions with Anthropic's server-side classifier, which judges only Claude's own requests. An action GPT asks for that would need that approval is refused, with the reason; the band warns about it. While GPT answers, use the default or accept-edits mode (Shift+Tab).
- **Built-in subagent types** (Explore, Plan, general-purpose) on GPT get their role but not Claude Code's internal prompt for that type, which a mod cannot read.
- **Calls with no hook.** A call Claude Code makes for itself without a hook a mod can answer still goes to Anthropic with the picked model's name, if Claude Code makes one.
- Needs Python 3 on the PATH (`/gpt python <path>` for another); `scripts/gpt.py` uses only its standard library.

## License

MIT. cache-tax is © 2026 Karan Bansal; see [plugins/cache-tax/LICENSE](plugins/cache-tax/LICENSE). live-voice is © 2026 Guido Vermeulen.
