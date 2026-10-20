// The main thread's latest turn: the share of its input read from cache.
export type LastTurn = { hitRate: number | null }

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

// What a main-thread request shows of itself on `turn.step`: the model it
// names, the effort it asks for, how many messages it carries.
export type Fingerprint = {
  model: string
  effort: string | null
  messages: number
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

// The latest cache break: a warm cache the prefix lost. `read` and `written`
// are the request's own usage, `prompt` the previous request's; `changes`
// is what the request shows changed since the previous one, empty when none.
export type Break = { at: number; read: number; prompt: number; written: number; changes: string[] }

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
      cacheBreak: Break | null
      lastPrint: Fingerprint | null
    }
  }
}
