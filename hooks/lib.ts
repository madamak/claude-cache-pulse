import type { ModelUsage, ThemeKey } from 'claude-code'

import type { Break, Fingerprint, LastRequest, Ledger, MissCause, Warm } from '../types'

export type CacheState =
  | { kind: 'none' }
  | { kind: 'live' }
  | { kind: 'hot'; remainingMs: number; idleMs: number }
  | { kind: 'cold'; idleMs: number }

export type TtlName = '1h' | '5m'

// The keep-warm fork's one message.
export const PING = 'Cache keep-alive ping from the cache-pulse mod. Reply with the single word: ok'

export function ttlMs(ttl: unknown): number {
  return ttl === '5m' ? 5 * 60_000 : 60 * 60_000
}

// What the module reads of a transcript row.
type Row = {
  type?: string
  isSidechain?: boolean
  timestamp?: string
  message?: { usage?: { cache_creation?: Record<string, number> } }
}

// The main thread's assistant rows in a transcript's tail, newest first.
// `needle` skips the parse of a line that cannot be one of interest.
function* mainAssistantRows(jsonl: string, needle: string): Generator<Row> {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line || !line.includes(needle)) continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      // The tail's first line is usually cut mid-row.
      continue
    }
    if (row.type === 'assistant' && !row.isSidechain) yield row
  }
}

// The TTL the newest cache write used, from the API's own usage on the main
// thread's assistant rows: `cache_creation.ephemeral_1h_input_tokens` or
// `ephemeral_5m_input_tokens`. A row that only read the cache says nothing,
// so the scan goes back to the newest row that wrote.
export function lastWriteTtl(jsonl: string): TtlName | null {
  for (const row of mainAssistantRows(jsonl, '"cache_creation"')) {
    const written = row.message?.usage?.cache_creation
    if ((written?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
    if ((written?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
  }

  return null
}

export function warnMs(ttl: number): number {
  return ttl <= 5 * 60_000 ? 60_000 : 5 * 60_000
}

export function cacheState(
  anchor: number | null,
  isWorking: boolean,
  now: number,
  ttl: number,
): CacheState {
  if (isWorking) return { kind: 'live' }
  if (anchor === null) return { kind: 'none' }
  const idleMs = Math.max(0, now - anchor)
  const remainingMs = ttl - idleMs

  return remainingMs > 0
    ? { kind: 'hot', remainingMs, idleMs }
    : { kind: 'cold', idleMs }
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)

  return h % 24 ? `${d}d${h % 24}h` : `${d}d`
}

export function fmtTtl(ttl: number): string {
  return ttl >= 60 * 60_000 ? '1h' : fmtDur(ttl)
}

// Footer label, kept short: it sits beside the model and effort.
export function footerLabel(s: CacheState): string {
  switch (s.kind) {
    case 'live':
      return 'cache live'
    case 'hot':
      return `cache ${fmtDur(s.remainingMs)}`
    case 'cold':
      return 'cache cold'
    case 'none':
      return 'cache —'
  }
}

// The tokens a request was answered over, cached or not.
export function promptTokens(u: ModelUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

// The share of a request's prompt read from cache.
export function hitRate(u: ModelUsage): number | null {
  const total = promptTokens(u)

  return total > 0 ? u.cache_read_input_tokens / total : null
}

export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'

  return kind.replace(/_/g, ' ')
}

export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

// What a reading says, decided once and drawn two ways: a theme color in
// the terminal, a fixed hex in the Svg meters.
export type Tone = 'ok' | 'warn' | 'bad' | 'live' | 'neutral'

export function cacheTone(s: CacheState, ttl: number): Tone {
  if (s.kind === 'live') return 'live'
  if (s.kind === 'hot') return s.remainingMs <= warnMs(ttl) ? 'warn' : 'ok'
  if (s.kind === 'cold') return 'bad'

  return 'neutral'
}

// Only a high reading earns a color.
export function levelTone(percent: number): Tone {
  if (percent >= 90) return 'bad'
  if (percent >= 70) return 'warn'

  return 'neutral'
}

export const THEME: Record<Tone, ThemeKey> = {
  ok: 'success',
  warn: 'warning',
  bad: 'error',
  live: 'suggestion',
  neutral: 'inactive',
}

// Inline SVG meters for surfaces that draw Svg (desktop, vscode, mobile).
// Drawn as images, so the colors are fixed hex that read on light and dark.
export const HEX: Record<Tone, string> = {
  ok: '#3fb950',
  warn: '#d29922',
  bad: '#f85149',
  live: '#58a6ff',
  neutral: '#8b949e',
}

// What is left of the cache's life, 0 to 1: full while a turn runs.
export function cacheFraction(s: CacheState, ttl: number): number {
  if (s.kind === 'live') return 1
  if (s.kind === 'hot') return Math.min(1, s.remainingMs / ttl)

  return 0
}

export function ringSvg(fraction: number, color: string): string {
  const r = 5
  const c = 2 * Math.PI * r
  const arc =
    fraction > 0
      ? `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="${(c * fraction).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 7 7)"/>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="${r}" fill="none" stroke="${HEX.neutral}" stroke-opacity="0.3" stroke-width="2.2"/>${arc}</svg>`
}

export function meterSvg(percent: number, color: string, width = 44): string {
  const fill = percent > 0 ? Math.max(4, (width * Math.min(100, percent)) / 100) : 0
  const bar = fill > 0 ? `<rect width="${fill.toFixed(1)}" height="5" rx="2.5" fill="${color}"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="5" viewBox="0 0 ${width} 5"><rect width="${width}" height="5" rx="2.5" fill="${HEX.neutral}" fill-opacity="0.25"/>${bar}</svg>`
}

// Terminal meters: thin blocks, no Svg there.
export function blocks(percent: number, cells = 8): string {
  const filled = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)))

  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

export function cacheTitle(s: CacheState): string {
  if (s.kind === 'live') return 'Cache live'
  if (s.kind === 'hot') return 'Cache hot'
  if (s.kind === 'cold') return 'Cache cold'

  return 'Cache'
}

export function cacheDetail(s: CacheState, ttl: number): string {
  if (s.kind === 'live') return 'turn running'
  if (s.kind === 'hot') return `${fmtDur(s.remainingMs)} left`
  if (s.kind === 'cold') return `idle ${fmtDur(s.idleMs)}`

  return 'waiting for a turn'
}

// ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<session id>.jsonl
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

// The time of the main thread's last assistant row in a transcript's tail.
export function lastAssistantAt(jsonl: string): number | null {
  for (const row of mainAssistantRows(jsonl, '"assistant"')) {
    const at = row.timestamp ? Date.parse(row.timestamp) : Number.NaN
    if (!Number.isNaN(at)) return at
  }

  return null
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`

  return `${(n / 1_000_000).toFixed(1)}M`
}

// A cache read against base input, at API list prices: 0.1× on most models,
// less on those whose cache reads are priced lower.
const READ_RATES: [RegExp, number][] = [
  [/opus-5-5/, 0.05],
  [/(fable|mythos)-5-1/, 0.025],
]

export function readRate(model: string): number {
  return READ_RATES.find(([pattern]) => pattern.test(model))?.[1] ?? 0.1
}

// What a cold restart costs against a warm prompt, at API list prices: a
// cache write is 2× base input for a 1h entry and 1.25× for a 5m one, over
// the model's cache-read rate. How a subscription weighs them against its
// limits is not published, so the band says it relative to a warm prompt,
// never in money.
export function coldRatio(ttl: number, model: string): number {
  return (ttl <= 5 * 60_000 ? 1.25 : 2) / readRate(model)
}

// Whether a request lost the cache. Claude Code puts its cache breakpoint at
// the end of each request, so the next request reads back about the whole
// previous prompt; a read well short of it means the cached prefix was lost:
// past the TTL it expired, otherwise something before it changed (a break).
export function missCause(prev: LastRequest | null, u: ModelUsage, isExpired: boolean): MissCause | null {
  if (prev === null) return null
  const lost = prev.prompt - u.cache_read_input_tokens
  if (lost <= Math.max(4096, prev.prompt * 0.2)) return null

  return isExpired ? 'expired' : 'break'
}

// What changed between two requests, among what a request shows of itself:
// the model it names, the effort it asks for, how many messages it carries.
// The tools and system prompt it sends are not given to mods, so they are
// never compared: a mod can only recompose them, not read what was sent.
export function requestChanges(before: Fingerprint | null, after: Fingerprint): string[] {
  if (before === null) return []
  const changes: string[] = []
  if (before.model !== after.model) {
    changes.push(`model (${shortModel(before.model)} → ${shortModel(after.model)})`)
  }
  if (before.effort !== after.effort) {
    changes.push(`effort (${before.effort ?? 'default'} → ${after.effort ?? 'default'})`)
  }
  if (after.messages < before.messages) {
    changes.push(`fewer messages (${before.messages} → ${after.messages})`)
  }

  return changes
}

export const EMPTY_LEDGER: Ledger = {
  requests: 0,
  read: 0,
  written: 0,
  uncached: 0,
  coldStarts: 0,
  coldTokens: 0,
  breaks: 0,
  breakTokens: 0,
}

export function tally(l: Ledger, u: ModelUsage, cause: MissCause | null): Ledger {
  const rewritten = u.cache_creation_input_tokens

  return {
    requests: l.requests + 1,
    read: l.read + u.cache_read_input_tokens,
    written: l.written + rewritten,
    uncached: l.uncached + u.input_tokens,
    coldStarts: l.coldStarts + (cause === 'expired' ? 1 : 0),
    coldTokens: l.coldTokens + (cause === 'expired' ? rewritten : 0),
    breaks: l.breaks + (cause === 'break' ? 1 : 0),
    breakTokens: l.breakTokens + (cause === 'break' ? rewritten : 0),
  }
}

// `next prompt rewrites 182k tokens: ≈20× the API cost of a warm prompt`
export function coldLine(stake: number, ttl: number, model: string): string {
  return `next prompt rewrites ${fmtTokens(stake)} tokens: ≈${Math.floor(coldRatio(ttl, model))}× the API cost of a warm prompt`
}

// `Warmed 2m ago · 98% hit · auto 1/3`: the cap only in auto mode.
export function warmedLine(w: Warm, now: number, autoMax: number | null): string {
  const hit = w.hitRate !== null ? ` · ${Math.round(w.hitRate * 100)}% hit` : ''
  const auto = autoMax !== null ? ` · auto ${w.count}/${autoMax}` : ''

  return `Warmed ${fmtDur(now - w.at)} ago${hit}${auto}`
}

// `$3.40 · 12 prompts · 2h`: the cost only where the engine reports one.
export function metaLine(usd: number | null, prompts: number, ageMs: number): string {
  return [usd !== null ? `$${usd.toFixed(2)}` : null, plural(prompts, 'prompt'), fmtDur(ageMs)]
    .filter(x => x !== null)
    .join(' · ')
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// `Cache hit: last turn 99% · session avg 96% · 1 cold start (180k rewritten)`
// The last turn's cache hit beside the session's average, weighted by tokens,
// so the one reads against the other.
export function ledgerLine(l: Ledger, compactions: number, lastHit: number | null): string | null {
  const total = l.read + l.written + l.uncached
  const hits = [
    lastHit !== null ? `last turn ${Math.round(lastHit * 100)}%` : null,
    l.requests > 0 ? `session avg ${total > 0 ? Math.round((l.read / total) * 100) : 0}%` : null,
  ].filter(x => x !== null)
  if (hits.length === 0) return null
  const parts = [`Cache hit: ${hits.join(' · ')}`]
  if (l.coldStarts > 0) parts.push(`${plural(l.coldStarts, 'cold start')} (${fmtTokens(l.coldTokens)} rewritten)`)
  if (l.breaks > 0) parts.push(`${plural(l.breaks, 'cache break')} (${fmtTokens(l.breakTokens)})`)
  if (compactions > 0) parts.push(plural(compactions, 'compaction'))

  return parts.join(' · ')
}

export function breakText(b: Break): string {
  const measured = `Cache break: the request read back ${fmtTokens(b.read)} of the previous ${fmtTokens(b.prompt)}-token prompt while warm and rewrote ${fmtTokens(b.written)}.`
  const seen =
    b.changes.length > 0
      ? `Changed since the previous request: ${b.changes.join('; ')}.`
      : 'The cause is not visible to the mod.'

  return `${measured} ${seen}`
}
