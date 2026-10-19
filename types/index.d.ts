export type LastTurn = {
  endedAt: number
  model: string
  durationMs: number
  hitRate: number | null
}

export type Warm = {
  at: number
  hitRate: number | null
  count: number
  isAuto: boolean
}

export type DetectedTtl = {
  value: '1h' | '5m'
  source: 'api' | 'engine'
}

// The main thread's previous request: what it sent, and what the next one
// re-sends (its prompt plus the reply it got).
export type LastRequest = { prompt: number; stake: number; model: string }

// Why a request lost the cache: past its TTL, or a change before it.
export type MissCause = 'expired' | 'break'

// What a main-thread request's cached prefix was built from, as far as a mod
// can see it: section and tool contents are hashed. null where it could not
// be read.
export type Fingerprint = {
  model: string
  effort: string | null
  messages: number
  system: Record<string, number> | null
  tools: Record<string, number> | null
}

// The main thread's requests this session.
export type Ledger = {
  requests: number
  read: number
  written: number
  uncached: number
  coldStarts: number
  coldTokens: number
  breaks: number
  breakTokens: number
}

// The latest cache break: a warm cache the prefix lost.
export type Break = { at: number; tokens: number; causes: string[] }

declare module 'claude-code' {
  interface PluginState {
    'cache-pulse': {
      lastTurn: LastTurn | null
      cacheAnchor: number | null
      isWorking: boolean
      compactions: number
      tick: number
      toasted: string[]
      warm: Warm | null
      warming: boolean
      ttl: DetectedTtl | null
      ledger: Ledger
      lastRequest: LastRequest | null
      lastBreak: Break | null
      lastPrint: Fingerprint | null
    }
  }
}
