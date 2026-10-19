import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { ModelUsage, TurnStepInput } from 'claude-code'
import type { Break, DetectedTtl, Fingerprint, LastTurn, Warm } from '../types'
import type { CacheState, TtlName } from './lib'
import {
  blocks,
  breakText,
  cacheDetail,
  cacheFraction,
  cacheHex,
  cacheState,
  cacheTitle,
  coldRatio,
  EMPTY_LEDGER,
  explainBreak,
  fmtDur,
  fmtTokens,
  fmtTtl,
  footerLabel,
  hash,
  HEX,
  hitRate,
  lastAssistantAt,
  lastWriteTtl,
  ledgerLine,
  levelColor,
  levelHex,
  limitLabel,
  meterSvg,
  missCause,
  promptTokens,
  ringSvg,
  shortModel,
  tally,
  transcriptPath,
  ttlMs,
  warnMs,
} from './lib'

const lastTurn = atom({ plugin: 'cache-pulse', key: 'lastTurn' } as const, null)
const cacheAnchor = atom({ plugin: 'cache-pulse', key: 'cacheAnchor' } as const, null)
const isWorking = atom({ plugin: 'cache-pulse', key: 'isWorking' } as const, false)
const compactions = atom({ plugin: 'cache-pulse', key: 'compactions' } as const, 0)
const tick = atom({ plugin: 'cache-pulse', key: 'tick' } as const, 0)
const toasted = atom({ plugin: 'cache-pulse', key: 'toasted' } as const, [])
const warm = atom({ plugin: 'cache-pulse', key: 'warm' } as const, null)
const warming = atom({ plugin: 'cache-pulse', key: 'warming' } as const, false)
const detectedTtl = atom({ plugin: 'cache-pulse', key: 'ttl' } as const, null)
const ledger = atom({ plugin: 'cache-pulse', key: 'ledger' } as const, EMPTY_LEDGER)
const lastRequest = atom({ plugin: 'cache-pulse', key: 'lastRequest' } as const, null)
const lastBreak = atom({ plugin: 'cache-pulse', key: 'lastBreak' } as const, null)
const lastPrint = atom({ plugin: 'cache-pulse', key: 'lastPrint' } as const, null)

const TICK_MS = 15_000
const LIMIT_THRESHOLDS = [80, 95]
const PING = 'Cache keep-alive ping from the cache-pulse mod. Reply with the single word: ok'

// True while a keep-warm fork runs, so its own events are not taken for yours.
let isWarming = false

// Workaround: the engine hands a mod neither a cache timestamp nor the TTL
// split of a cache write, but the session transcript stores the API's raw
// usage for every reply. Reads its tail; null when there is none yet.
async function transcriptTail($: EngineInterface): Promise<string | null> {
  const configDir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const path = transcriptPath(configDir, await $.session.cwd(), await $.session.id())
  try {
    const { exitCode, stdout } = await $.process.run(['tail', '-c', '262144', path], {
      timeoutMs: 5_000,
    })

    return exitCode === 0 ? stdout : null
  } catch {
    return null
  }
}

// A mod loaded mid-session takes the time of the last reply as the anchor.
async function seedAnchor($: EngineInterface, tail: string | null): Promise<void> {
  if (tail === null || (await read($, cacheAnchor)) !== null) return
  const at = lastAssistantAt(tail)
  if (at !== null) await update($, cacheAnchor, () => at)
}

// The TTL the API says the newest cache write used.
async function detectTtl($: EngineInterface, tail: string | null): Promise<void> {
  const value = tail === null ? null : lastWriteTtl(tail)
  if (value === null) return
  const found: DetectedTtl = { value, source: 'api' }
  await update($, detectedTtl, () => found)
}

// The TTL in force: the pinned one, else the detected one, else 1h assumed.
async function ttlOf(
  $: EngineInterface,
  pinned: TtlName | null,
): Promise<{ ms: number; isKnown: boolean }> {
  const found = pinned === null ? await read($, detectedTtl) : null

  return { ms: ttlMs(pinned ?? found?.value ?? '1h'), isKnown: pinned !== null || found !== null }
}

function cacheTheme(s: CacheState, ttl: number): string {
  if (s.kind === 'live') return 'suggestion'
  if (s.kind === 'hot') return s.remainingMs <= warnMs(ttl) ? 'warning' : 'success'
  if (s.kind === 'cold') return 'error'

  return 'inactive'
}

// Only a high reading earns a color; the rest stays in the text color.
function alertColor(percent: number): string | undefined {
  return percent >= 70 ? levelColor(percent) : undefined
}

async function toastOnce($: EngineInterface, key: string, text: string): Promise<void> {
  const seen = await read($, toasted)
  if (seen.includes(key)) return
  await update($, toasted, list => [...(list ?? []).slice(-50), key])
  $.ui.toast(text)
}

// Through the person's own notification channel, the one Claude Code's own
// notifications use. It writes a terminal sequence, so in a session the
// desktop app hosts it sends nothing (no-surface) and the toast stands alone:
// a mod has no way to raise the app's own notifications.
async function notify($: EngineInterface, text: string): Promise<void> {
  await $.ui.notify(text, { title: 'Claude Code · prompt cache' })
}

// What the request about to be sent is built from: the session's system
// prompt as the engine composes it, and the tools the model is offered.
async function fingerprint($: EngineInterface, e: TurnStepInput): Promise<Fingerprint> {
  let system: Record<string, number> | null = null
  let tools: Record<string, number> | null = null
  try {
    const { sections } = await $.prompt.compose({ model: e.model })
    system = Object.fromEntries(sections.map(s => [s.id, hash(s.text)]))
  } catch {
    // Not composable here: the system prompt is left out of the comparison.
  }
  try {
    tools = Object.fromEntries((await $.tool.list()).map(t => [t.name, hash(t.description)]))
  } catch {
    // Same for the tools.
  }

  return {
    model: e.model,
    effort: e.effort === undefined ? null : String(e.effort),
    messages: e.messageCount,
    system,
    tools,
  }
}

// One main-thread request: tallies it, and says when it lost a warm cache
// and what changed since the request before.
async function recordRequest(
  $: EngineInterface,
  model: string,
  usage: ModelUsage,
  isExpired: boolean,
  print: Fingerprint,
): Promise<void> {
  const now = await $.clock.now()
  const before = await read($, lastPrint)
  const cause = missCause(await read($, lastRequest), usage, isExpired)
  await update($, ledger, l => tally(l ?? EMPTY_LEDGER, usage, cause))
  const prompt = promptTokens(usage)
  await update($, lastRequest, () => ({ prompt, stake: prompt + usage.output_tokens, model }))
  await update($, lastPrint, () => print)
  // Each request reads and so refreshes the cache.
  await update($, cacheAnchor, () => now)
  if (cause === 'break') {
    const found: Break = { at: now, tokens: usage.cache_creation_input_tokens, causes: explainBreak(before, print) }
    await update($, lastBreak, () => found)
    $.ui.toast(breakText(found), { timeoutMs: 10_000 })
  }
}

// One tool-less fork over the main thread's last request: it reads the whole
// cached prefix, and a cache read restarts the entry's TTL.
async function warmCache($: EngineInterface, isAuto: boolean): Promise<void> {
  if (isWarming || (await read($, isWorking))) return
  isWarming = true
  // The fork resends the whole context and takes seconds: show it in the band.
  await update($, warming, () => true)
  try {
    const result = await $.model.fork({ prompt: PING })
    if (!result.isAnswered && result.reason === 'nothing-to-fork') {
      $.ui.toast('Nothing to warm yet: no reply in this conversation.')
      return
    }
    const usage = 'usage' in result ? result.usage : undefined
    if (!usage || usage.cache_read_input_tokens + usage.cache_creation_input_tokens === 0) {
      const why = result.isAnswered ? 'no cache was read or written' : result.reason
      $.ui.toast(`Keep-warm failed: ${why}.`)
      return
    }
    const now = await $.clock.now()
    const rate = hitRate(usage)
    await update($, cacheAnchor, () => now)
    // A ping that read nothing paid the cold start itself.
    if (usage.cache_read_input_tokens === 0) {
      await update($, ledger, l => ({
        ...(l ?? EMPTY_LEDGER),
        coldStarts: (l ?? EMPTY_LEDGER).coldStarts + 1,
        coldTokens: (l ?? EMPTY_LEDGER).coldTokens + usage.cache_creation_input_tokens,
      }))
    }
    await update($, warm, w => ({
      at: now,
      hitRate: rate,
      count: (w?.count ?? 0) + 1,
      isAuto,
    }))
    if (usage.cache_read_input_tokens === 0) {
      $.ui.toast('The cache had already expired: the ping wrote it again.')
    } else if (!isAuto) {
      $.ui.toast(`Cache warmed: ${Math.round((rate ?? 0) * 100)}% read from cache.`)
    }
  } finally {
    isWarming = false
    await update($, warming, () => false)
  }
}

export const register: Register = (on, options) => {
  // `auto` (the default) follows the TTL the API reports; `1h` or `5m` pins it.
  const pinned: TtlName | null =
    options.cacheTtl === '1h' || options.cacheTtl === '5m' ? options.cacheTtl : null
  const isWarning = options.cacheWarning !== false
  const keepWarm = options.keepWarm === 'auto' || options.keepWarm === 'off' ? options.keepWarm : 'button'
  const keepWarmMax = typeof options.keepWarmMax === 'number' ? options.keepWarmMax : 3

  on('session.start', async ($, e, next) => {
    // A reload mid-warm never ran its finally: clear the flag it left.
    await update($, warming, () => false)
    const tail = await transcriptTail($)
    await seedAnchor($, tail)
    await detectTtl($, tail)
    $.clock.every(TICK_MS, () => {
      void (async () => {
        await update($, tick, n => (n ?? 0) + 1)
        const ttl = (await ttlOf($, pinned)).ms
        const anchor = await read($, cacheAnchor)
        const s = cacheState(anchor, await read($, isWorking), await $.clock.now(), ttl)
        if (s.kind !== 'hot' || s.remainingMs > warnMs(ttl)) return

        const warms = (await read($, warm))?.count ?? 0
        if (keepWarm === 'auto' && warms < keepWarmMax) {
          await warmCache($, true)
          return
        }
        if (!isWarning) return
        const capped = keepWarm === 'auto' ? ` Auto-warm stopped after ${warms} in a row.` : ''
        const text = `Prompt cache expires in ${fmtDur(s.remainingMs)}. Reply now to keep it warm.${capped}`
        const seen = (await read($, toasted)).includes(`cache:${anchor}`)
        await toastOnce($, `cache:${anchor}`, text)
        if (!seen) await notify($, text)
      })()
    })

    return next(e)
  })

  // A resumed session: seed the countdown and the stake from the
  // transcript's last response.
  on('classic.SessionStart', async ($, e, next) => {
    const seconds = e.seconds_since_last_response
    if (typeof seconds === 'number' && (await read($, cacheAnchor)) === null) {
      const now = await $.clock.now()
      await update($, cacheAnchor, () => now - seconds * 1000)
    }
    const tokens = e.context_tokens
    if (typeof tokens === 'number' && tokens > 0 && (await read($, lastRequest)) === null) {
      await update($, lastRequest, () => ({ prompt: tokens, stake: tokens, model: e.model ?? '' }))
    }

    return next(e)
  })

  // The engine's own TTL, raised on a model switch.
  on('classic.PreModelSwitch', async ($, e, next) => {
    const found: DetectedTtl = { value: e.cache_ttl, source: 'engine' }
    await update($, detectedTtl, () => found)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (isWarming || e.agentId !== undefined) return next(e)
    await update($, isWorking, () => true)
    await update($, lastBreak, () => null)

    return next(e)
  })

  // Each model request of the main thread, with the usage the API reported.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || isWarming) return yield* next(e)
    const ttl = (await ttlOf($, pinned)).ms
    const anchor = await read($, cacheAnchor)
    const isExpired = anchor !== null && (await $.clock.now()) - anchor >= ttl
    const print = await fingerprint($, e)
    const result = yield* next(e)
    if (result.usage) await recordRequest($, e.model, result.usage, isExpired, print)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || isWarming) return next(e)

    const now = await $.clock.now()
    await update($, isWorking, () => false)
    // A turn of yours: the auto-warm cap starts over.
    await update($, warm, () => null)
    if (e.usage) {
      const usage = e.usage
      const turn: LastTurn = {
        endedAt: now,
        model: usage.model,
        durationMs: e.durationMs,
        hitRate: hitRate(usage),
      }
      await update($, lastTurn, () => turn)
      await update($, cacheAnchor, () => now)
      // The reply's row lands in the transcript as the turn ends: read it
      // once it is written. A usage-overage switch to 5m shows up here.
      if (usage.cache_creation_input_tokens > 0) {
        $.clock.after(2_000, () => {
          void (async () => detectTtl($, await transcriptTail($)))()
        })
      }
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !('skip' in result)) {
      await update($, compactions, n => (n ?? 0) + 1)
      // The summary is a new prefix: nothing of it is cached yet, and the
      // rewrite the next request does is expected.
      await update($, cacheAnchor, () => null)
      await update($, lastRequest, () => null)
    }

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, cacheAnchor, () => null)
      await update($, lastTurn, () => null)
      await update($, compactions, () => 0)
      await update($, warm, () => null)
      await update($, ledger, () => EMPTY_LEDGER)
      await update($, lastRequest, () => null)
      await update($, lastBreak, () => null)
      await update($, lastPrint, () => null)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      for (const limit of e.rateLimits) {
        const crossed = LIMIT_THRESHOLDS.filter(t => limit.percentUsed >= t).pop()
        if (crossed === undefined) continue
        const resets = limit.resetsAt
          ? `, resets in ${fmtDur(Date.parse(limit.resetsAt) - (await $.clock.now()))}`
          : ''
        await toastOnce(
          $,
          `limit:${limit.kind}:${crossed}:${limit.resetsAt ?? ''}`,
          `${limitLabel(limit.kind)} usage limit at ${limit.percentUsed}%${resets}`,
        )
      }
    }

    return next(e)
  })

  // The countdown in the prompt footer, beside the model and effort.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    await read($, tick)
    const s = cacheState(
      await read($, cacheAnchor),
      await read($, isWorking),
      await $.clock.now(),
      (await ttlOf($, pinned)).ms,
    )

    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, footerLabel(s)] } })
  })

  // What happens if you come back later: the cache, what expiry costs, and
  // how the session's cache has fared. A usage limit shows once it is high.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    await read($, tick)
    const { ms: ttl, isKnown: isTtlKnown } = await ttlOf($, pinned)
    const now = await $.clock.now()
    const working = e.props.isWorking || (await read($, isWorking))
    const s = cacheState(await read($, cacheAnchor), working, now, ttl)
    const last = await read($, lastTurn)
    const compactCount = await read($, compactions)
    const warmed = await read($, warm)
    const stake = (await read($, lastRequest))?.stake ?? null
    const totals = ledgerLine(await read($, ledger), compactCount)
    const broke = await read($, lastBreak)
    const prompts = await $.session.turns()
    const usage = await $.session.usage()

    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Every surface but the terminal draws Svg.
    const Svg = e.surface === 'terminal' ? undefined : (els as Elements['desktop']).Svg

    const meter = (label: string, percent: number) =>
      Svg ? (
        <Svg
          source={meterSvg(percent, levelHex(percent))}
          alt={`${label} ${percent}%`}
          width={44}
          height={5}
        />
      ) : (
        <Text color={levelColor(percent)}>{blocks(percent)}</Text>
      )

    const isWarmingNow = await read($, warming)
    const cacheLabel = isWarmingNow ? 'Cache warming' : cacheTitle(s)
    const cacheText = isWarmingNow ? 'resending the last request' : cacheDetail(s, ttl)
    const cache = (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {Svg ? (
          <Svg
            source={ringSvg(isWarmingNow ? 1 : cacheFraction(s, ttl), isWarmingNow ? HEX.live : cacheHex(s, ttl))}
            alt={`${cacheLabel}, ${cacheText}`}
            width={14}
            height={14}
          />
        ) : (
          <Text color={isWarmingNow ? 'suggestion' : cacheTheme(s, ttl)}>
            {isWarmingNow || s.kind === 'hot' || s.kind === 'live' ? '●' : '○'}
          </Text>
        )}
        <Text
          bold
          color={
            isWarmingNow ? 'suggestion' : s.kind === 'hot' && s.remainingMs > warnMs(ttl) ? undefined : cacheTheme(s, ttl)
          }
        >
          {cacheLabel}
        </Text>
        <Text>{cacheText}</Text>
        <Text dimColor>
          / {fmtTtl(ttl)}
          {isTtlKnown ? '' : '?'}
          {stake !== null && s.kind !== 'cold' ? ` · ${fmtTokens(stake)} tokens` : ''}
        </Text>
        {stake !== null && s.kind === 'cold' && !isWarmingNow ? (
          <Text color="warning">
            next prompt rewrites {fmtTokens(stake)}, ≈{Math.floor(coldRatio(ttl))}× a warm prompt
          </Text>
        ) : null}
        {isWarmingNow ? (
          <Text dimColor>Warming…</Text>
        ) : keepWarm !== 'off' && s.kind === 'hot' ? (
          <Button key="warm" label="Keep warm" onPress={() => warmCache($, false)} />
        ) : null}
      </Box>
    )

    // The weekly window cannot be acted on in a session: its toasts at 80%
    // and 95% say enough.
    const limits = usage.rateLimits
      .filter(limit => limit.kind !== 'seven_day' && limit.percentUsed >= 70)
      .map(limit => (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Text dimColor>{limitLabel(limit.kind)}</Text>
          {meter(limitLabel(limit.kind), limit.percentUsed)}
          <Text color={alertColor(limit.percentUsed)}>{limit.percentUsed}%</Text>
          {limit.resetsAt ? (
            <Text dimColor>↺ {fmtDur(Date.parse(limit.resetsAt) - now)}</Text>
          ) : null}
        </Box>
      ))

    const meta = [
      usage.cost ? `$${usage.cost.usd.toFixed(2)}` : null,
      `${prompts} prompt${prompts === 1 ? '' : 's'}`,
      fmtDur(now - usage.startedAt),
    ]
      .filter(x => x !== null)
      .join(' · ')

    const detail = [
      totals ? <Text dimColor>{totals}</Text> : null,
      last ? (
        <Text dimColor>
          Last turn {shortModel(last.model)} · {fmtDur(last.durationMs)}
          {last.hitRate !== null ? ` · ${Math.round(last.hitRate * 100)}% cache hit` : ''}
        </Text>
      ) : null,
      warmed ? (
        <Text dimColor>
          Warmed {fmtDur(now - warmed.at)} ago
          {warmed.hitRate !== null ? ` · ${Math.round(warmed.hitRate * 100)}% hit` : ''}
          {keepWarm === 'auto' ? ` · auto ${warmed.count}/${keepWarmMax}` : ''}
        </Text>
      ) : null,
    ].filter(x => x !== null)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={3} flexWrap="wrap">
          <Box flexDirection="row" alignItems="center" columnGap={3} flexWrap="wrap">
            {[cache, ...limits]}
          </Box>
          <Text dimColor>{meta}</Text>
        </Box>
        {detail.length > 0 ? (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {detail}
          </Box>
        ) : null}
        {broke ? <Text color="warning">⚠ {breakText(broke)}</Text> : null}
      </Box>
    )
  })
}
