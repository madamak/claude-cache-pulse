# Cache Pulse

Prompt-cache status for Claude Code. Each prompt re-sends the whole conversation. While the prompt cache is warm, that costs about a tenth of the input price; once it expires, the next prompt writes the whole context again. Cache Pulse shows how long you have left and what expiry would cost, flags requests that lost a warm cache, warms the cache on demand, and tells you before it expires.

Claude Code only (a hooks module): it draws on the desktop app's Code tab and in the terminal.

## Install

In a terminal session of Claude Code, answer `y` to add the marketplace, then pick the user scope:

```
/plugin install cache-pulse --marketplace madamak/claude-cache-pulse
```

From a shell:

```bash
claude plugin install cache-pulse --marketplace madamak/claude-cache-pulse
```

Installed at the user scope, it also loads in the desktop app's Code tab. Restart open sessions to pick it up. In the desktop app, **+** (next to the prompt) → **Plugins** → **Manage plugins** enables, disables or removes it once the marketplace is added. Plugins are not available in cloud or WSL sessions.

Where an organization manages Claude Code, the resume, model-switch and compaction hooks run only for plugins the organization lists in its managed settings; the band still works, with a less exact countdown after a resume or a compaction.

## What it shows

The band answers one question: what happens if you come back later?

```
◔ Cache hot  47m left / 1h · 182k tokens                 [Keep warm]     $3.40 · 12 prompts · 2h
  Session 96% from cache · 1 cold start (180k rewritten) · Last turn 2m · 99% cache hit
  ⚠ Cache break: the request read back 7k of the previous 182k-token prompt while warm and rewrote 175k. The cause is not visible to the mod.
```

**Prompt footer (terminal)**, next to the model and effort: `cache 47m`, `cache live` while a turn runs, `cache cold` once it has expired. The desktop app does not draw this footer slot; the band carries the same countdown there.

**Band above the prompt**, on the desktop app's Code tab and in the terminal:

- **Cache ring**: hot, live or cold, the time left against the TTL, and the tokens at stake: what the next prompt re-sends. **Keep warm** while it is hot.
- **Cold cache**: `next prompt rewrites 182k tokens: ≈20× the API cost of a warm prompt`. At API list prices a cache write costs 2× base input for a 1h entry (1.25× for 5m) and a read 0.1×, so a cold restart costs about 20× a warm prompt (12× for 5m). How a subscription weighs cache tokens against its usage limits is not published, so the band gives the ratio, not a price.
- **Session totals**: the share of input read from cache, cold starts and cache breaks with the tokens they rewrote, compactions.
- **Cache break**: a request that lost a warm cache (see below), until your next prompt. A toast says it as it happens.
- **Last turn**: its duration and the share of its input read from cache, where the session totals give that share since the start; **Warmed** after a Keep warm.
- **Cost, prompt count, session age** on the right.
- **5h usage limit** only at 70% or more. The weekly limit stays out of the band: a toast at 80% and 95% covers every limit.

Colors only appear when something needs attention.

## Cache breaks

Claude Code puts its cache breakpoint at the end of each request, so the next request reads back about the whole previous prompt. When a request reads back much less (more than 20% of it, and at least 4k tokens) and no compaction explains it, the cache was lost. Past the TTL, it **expired**: a cold start. Otherwise it **broke**, and Cache Pulse says what it measured, from the usage the API reported: how much of the previous prompt the request read back, and how much it rewrote.

It then lists what the request itself shows changed since the request before, from `turn.step`:

| Change | How it is seen |
|---|---|
| `model (opus-5-5 → sonnet-5-5)` | the model the request names |
| `effort (high → max)` | the effort the request asks for |
| `fewer messages (40 → 12)` | the number of messages the request carries: a rewind or an edit |

With none of these, it says `The cause is not visible to the mod.` These are changes the request shows, not a diagnosis: a change listed may not be what lost the cache.

Cache Pulse does not guess at the tools or the system prompt. The engine does not give a mod the tools or the system prompt a request sent: `$.tool.list()` lists the tools the model can call, with short descriptions and no schemas, and `$.prompt.compose()` composes the system prompt again for nobody to send. So a difference the mod sees there may not be in the request, and a change in the request may not show there. Claude Code keeps its own diagnosis (`prompt_cache.last_miss_cause` in the status line's input), but it is not given to mods.

## Keep warm

**Keep warm** sends one tool-less fork of the main thread's last request (same model, system prompt, tools and messages) with a short "reply ok" message. It reads the whole cached prefix, and a cache read restarts the TTL. The ping is not added to the conversation. The band then shows `Warmed 2m ago · 98% hit`; a low hit rate means the cache had already expired and the ping wrote it again.

Each warm costs one cache read of the context plus a few output tokens, and counts toward your usage limits. That is far cheaper than writing the cache again, but holding an idle session warm for hours adds up, so auto mode is capped.

## Settings

Set them in `/config` or under `pluginConfigs` in `settings.json`.

| Setting | Default | What it does |
|---|---|---|
| `cacheTtl` | `auto` | `auto` follows the TTL the API reports for the session's cache writes (`1h` on a subscription, `5m` on the API or in usage overage), so a switch to 5m mid-session is picked up. `1h` or `5m` pins it. Until the first write is seen, the band assumes 1h and shows `/ 1h?`. |
| `cacheWarning` | `true` | A toast 5 minutes before a 1h cache expires (1 minute for 5m), plus a notification through your terminal's notification channel where there is one. In `auto` mode, only once the cap is reached. |
| `keepWarm` | `button` | `button`: the Keep warm button. `auto`: warm by itself before expiry. `off`: neither. |
| `keepWarmMax` | `3` | Auto-warms in a row, with no prompt from you in between, before auto mode stops and warns you. |

## Limits

- **The countdown is an estimate.** It starts when the last main-thread turn ends, which is close to the last cache refresh. It restarts after a compaction (the summary is a new prefix) and does not notice a `/model` switch, which also loses the cache.
- **The TTL and the mid-session anchor come from the session transcript** in `~/.claude/projects/`. The engine gives a mod only four token counts per reply, while the transcript keeps the API's raw usage, whose `cache_creation` splits each write into `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens`. The mod reads the tail after each turn. This depends on Claude Code's folder layout and transcript format and may break after an update; a model switch also reports the engine's own `cache_ttl`, and the `cacheTtl` setting can pin the value.
- **The expiry warning is a toast in the desktop app.** A mod's notification goes through the terminal's notification channel, the one Claude Code's own notifications use there; a session the desktop app hosts has no terminal, and a mod cannot raise the app's own notifications.
- **Cache breaks are inferred** from the usage the API reports per request, not read from Claude Code's own ledger. Their cause is shown only where the request itself shows a change. A mod loaded mid-session starts counting, and comparing, from its first request.

## Development

The module is [`hooks/register.tsx`](hooks/register.tsx); the pure logic (countdown, miss detection and session ledger, formatting, SVG meters, transcript parsing) is in [`hooks/lib.ts`](hooks/lib.ts), and [`types/index.d.ts`](types/index.d.ts) is the state contract.

```bash
claude plugin validate .
claude plugin test .
```

To work on it live, start a session with `claude --plugin-dir .` from this folder.

The tests were last run on Claude Code 2.1.299 (`claude plugin test` needs `ui.notify`, `model.fork` and `turn.step`).

## License

MIT
