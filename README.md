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

## License

MIT. cache-tax is © 2026 Karan Bansal; see [plugins/cache-tax/LICENSE](plugins/cache-tax/LICENSE).
