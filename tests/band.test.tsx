import type { ModelForkResult, On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  cacheState,
  cacheTone,
  coldLine,
  coldRatio,
  breakText,
  EMPTY_LEDGER,
  fmtDur,
  fmtTokens,
  footerLabel,
  lastAssistantAt,
  lastWriteTtl,
  ledgerLine,
  levelTone,
  metaLine,
  missCause,
  PING,
  requestChanges,
  tally,
  transcriptPath,
  ttlMs,
  warmedLine,
} from '../hooks/lib'

const HOUR = 60 * 60_000

test('cache countdown runs from the last turn to the TTL', async () => {
  expect(cacheState(null, false, 0, HOUR)).toEqual({ kind: 'none' })
  expect(cacheState(1000, true, 5000, HOUR)).toEqual({ kind: 'live' })
  expect(footerLabel(cacheState(0, false, 13 * 60_000, HOUR))).toBe('cache 47m')
  expect(cacheState(0, false, HOUR + 1, HOUR).kind).toBe('cold')
  expect(ttlMs('5m')).toBe(5 * 60_000)
  expect(ttlMs(undefined)).toBe(HOUR)
})

test('a reading earns a color only when it needs attention', async () => {
  expect(cacheTone(cacheState(0, false, 10 * 60_000, HOUR), HOUR)).toBe('ok')
  expect(cacheTone(cacheState(0, false, 56 * 60_000, HOUR), HOUR)).toBe('warn')
  expect(cacheTone(cacheState(0, false, HOUR + 1, HOUR), HOUR)).toBe('bad')
  expect(cacheTone(cacheState(0, true, 0, HOUR), HOUR)).toBe('live')
  expect(cacheTone(cacheState(null, false, 0, HOUR), HOUR)).toBe('neutral')
  expect([69, 70, 89, 90].map(levelTone)).toEqual(['neutral', 'warn', 'warn', 'bad'])
})

test('durations and token counts format', async () => {
  expect(fmtDur(45_000)).toBe('45s')
  expect(fmtDur(130 * 60_000)).toBe('2h10m')
  expect(fmtDur(76 * HOUR)).toBe('3d4h')
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(182_400)).toBe('182k')
  expect(fmtTokens(1_250_000)).toBe('1.3M')
  expect(coldRatio(HOUR, 'claude-sonnet-5-5')).toBe(20)
  expect(coldRatio(5 * 60_000, 'claude-sonnet-5-5')).toBe(12.5)
  // Cache reads priced below 0.1× base input widen the gap.
  expect(coldRatio(HOUR, 'claude-opus-5-5')).toBe(40)
  expect(coldRatio(HOUR, 'claude-fable-5-1')).toBe(80)
  expect(coldRatio(HOUR, 'claude-opus-5')).toBe(20)
  expect(coldRatio(HOUR, '')).toBe(20)
})

test('the band\'s own lines read as the README shows them', async () => {
  expect(coldLine(182_400, HOUR, 'claude-sonnet-5-5')).toBe(
    'next prompt rewrites 182k tokens: ≈20× the API cost of a warm prompt',
  )
  // 12.5× rounds down: the band never overstates the ratio.
  expect(coldLine(90_000, 5 * 60_000, '')).toBe('next prompt rewrites 90k tokens: ≈12× the API cost of a warm prompt')
  const w = { at: 0, hitRate: 0.981, count: 1, isAuto: true }
  expect(warmedLine(w, 2 * 60_000, 3)).toBe('Warmed 2m ago · 98% hit · auto 1/3')
  expect(warmedLine({ ...w, hitRate: null }, 2 * 60_000, null)).toBe('Warmed 2m ago')
  expect(metaLine(3.4, 12, 2 * HOUR)).toBe('$3.40 · 12 prompts · 2h')
  expect(metaLine(null, 1, 30_000)).toBe('1 prompt · 30s')
})

// Beneath the plugin, what the band reads of the engine: the session's
// usage and prompt count, and an AbovePrompt of its own that draws nothing.
function engineBand(on: On, turns: number, usage: Partial<SessionUsage> = {}): void {
  on('session.usage', () => ({
    value: { startedAt: 9 * HOUR, context: { window: 200_000 }, rateLimits: [], ...usage },
  }))
  on('session.turns', () => ({ value: turns }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}

// A ping that read the whole 90k context from cache.
const FORK_OK: { value: ModelForkResult } = {
  value: {
    isAnswered: true,
    text: 'ok',
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 },
  },
}

// A terminal session resumed `seconds` after its last reply, with no
// transcript to read: the tick runs, as it does once a session starts.
// Called after the test's own hooks, since the first call on `$` loads them.
async function resumeInTerminal($: Engine, on: On, seconds: number): Promise<void> {
  mock.env(on, { HOME: '/h' })
  on('session.cwd', () => ({ value: '/x' }))
  on('session.id', () => ({ value: 'id' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', () => ({ cwd: '/x' }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: seconds })
}

const use = (read: number, written: number, input = 10, output = 500) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})

test('a request that reads well short of the previous prompt lost the cache', async () => {
  const prev = { prompt: 100_000, stake: 100_500, model: 'claude-opus-5-5' }
  // The usual request reads the whole previous prompt back.
  expect(missCause(prev, use(100_000, 2_000), false)).toBeNull()
  expect(missCause(null, use(0, 100_000), false)).toBeNull()
  expect(missCause(prev, use(0, 102_000), true)).toBe('expired')
  expect(missCause(prev, use(12_000, 90_000), false)).toBe('break')

  let l = tally(EMPTY_LEDGER, use(0, 100_000), null)
  l = tally(l, use(100_000, 2_000), null)
  l = tally(l, use(0, 102_000), 'expired')
  l = tally(l, use(12_000, 90_000), 'break')
  expect(ledgerLine(l, 1, 0.99)).toBe(
    'Cache hit: last turn 99% · session avg 28% · 1 cold start (102k rewritten) · 1 cache break (90k) · 1 compaction',
  )
  expect(ledgerLine(l, 0, null)).toBe('Cache hit: session avg 28% · 1 cold start (102k rewritten) · 1 cache break (90k)')
  expect(ledgerLine(EMPTY_LEDGER, 0, null)).toBeNull()
})

test('the footer gets a cache label on every surface that draws it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  // The engine's own footer, beneath the plugin: the labels joined.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.modes.join(' & ')}</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cache-pulse',
      surface,
      component: 'SessionMode',
      props: { modes: ['focus'] },
    })
    expect(await ui.find({ type: 'Text', text: 'focus & cache —' })).toBeDefined()
    await ui.unmount()
  }
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9, contentRows: 0 },
  view: {},
} as never

test('a break lists only what the request shows changed since the one before', async () => {
  const print = { model: 'claude-opus-5-5', effort: 'high', messages: 40 }
  expect(requestChanges(print, { ...print, model: 'claude-sonnet-5-5' })).toEqual(['model (opus-5-5 → sonnet-5-5)'])
  expect(requestChanges(print, { ...print, effort: 'max' })).toEqual(['effort (high → max)'])
  expect(requestChanges(print, { ...print, messages: 12 })).toEqual(['fewer messages (40 → 12)'])
  expect(requestChanges(print, { ...print, messages: 42 })).toEqual([])
  expect(requestChanges(null, print)).toEqual([])
})

test('a break states what was measured, and no cause it cannot see', async () => {
  const measured = { at: 0, read: 48_166, prompt: 68_982, written: 23_497 }
  expect(breakText({ ...measured, changes: [] })).toBe(
    'Cache break: the request read back 48k of the previous 69k-token prompt while warm and rewrote 23k. The cause is not visible to the mod.',
  )
  expect(breakText({ ...measured, changes: ['model (opus-5-5 → sonnet-5-5)'] })).toMatch(
    /rewrote 23k\. Changed since the previous request: model \(opus-5-5 → sonnet-5-5\)\.$/,
  )
})

test('the band leaves out the weekly limit and shows the 5h one only when high', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  engineBand(on, 3, {
    context: { window: 200_000, tokens: 84_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(12 * HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 81 },
    ],
    cost: { usd: 3.4 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-pulse', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: '81%' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '23%' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'ctx' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '$3.40 · 3 prompts · 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'waiting for a turn' })).toBeDefined()
    await ui.unmount()
  }
})

test('a 5h limit at 70% or more joins the band', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  engineBand(on, 3, {
    rateLimits: [{ kind: 'five_hour', percentUsed: 76, resetsAt: new Date(12 * HOUR).toISOString() }],
  })

  const term = await $.ui.mount({ plugin: 'cache-pulse', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await term.find({ type: 'Text', text: '76%' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '▰▰▰▰▰▰▱▱' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '↺ 2h' })).toBeDefined()
  await term.unmount()
})

const step = (model: string, usage: ReturnType<typeof use>) => ({
  turnId: 't',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn' as const,
  usage: { ...usage, model },
})

async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  for await (const _ of stream) {
    // The chunks are the engine's; the test reads the result.
  }
}

test('a warm cache lost to a model switch is flagged and counted', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  engineBand(on, 2)
  let next = step('claude-opus-5-5', use(0, 100_000))
  on('turn.step', async function* (_$, e) {
    return { ...next, turnId: e.turnId, index: e.index }
  })

  await drain($.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await clock.advance(60_000)
  next = step('claude-sonnet-5-5', use(0, 101_000))
  await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', messageCount: 3 }))

  expect(toasts).toContain(
    'Cache break: the request read back 0 of the previous 100k-token prompt while warm and rewrote 101k. Changed since the previous request: model (opus-5-5 → sonnet-5-5).',
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-pulse', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: /1 cache break \(101k\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⚠ Cache break/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/ 1h\? · 102k tokens/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a cold cache says what the next prompt rewrites, and the request counts as a cold start', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  engineBand(on, 2)
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* () {
    return step('claude-opus-5-5', use(0, 92_000))
  })
  // Resumed two hours after a reply that left 90k tokens in the window.
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 3600, context_tokens: 90_000 })

  const ui = await $.ui.mount({ plugin: 'cache-pulse', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /next prompt rewrites 90k tokens: ≈20× the API cost of a warm prompt/ })).toBeDefined()
  await ui.unmount()

  await drain($.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 5 }))
  await clock.advance(1_000)
  const after = await $.ui.mount({ plugin: 'cache-pulse', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await after.find({ type: 'Text', text: /1 cold start \(92k rewritten\)/ })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /⚠/ })).toBeUndefined()
  await after.unmount()
})

test('a mod loaded mid-session finds the last reply in the transcript', async () => {
  const tail = [
    '{"type":"user","timestamp":"2026-10-15T12:00:00.000Z"}',
    '{"type":"assistant","timestamp":"2026-10-15T12:30:00.000Z"}',
    '{"type":"assistant","isSidechain":true,"timestamp":"2026-10-15T12:40:00.000Z"}',
    '{"type":"attachment","timestamp":"2026-10-15T12:41:00.000Z"}',
  ].join('\n')
  expect(lastAssistantAt('cut-off-row"assistant"}\n' + tail)).toBe(Date.parse('2026-10-15T12:30:00.000Z'))
  expect(transcriptPath('/h/.claude', '/a/b.c/d', 'id')).toBe('/h/.claude/projects/-a-b-c-d/id.jsonl')
})

test('Keep warm forks the session and restarts the countdown', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  let forks = 0
  on('model.fork', () => {
    forks += 1

    return FORK_OK
  })
  engineBand(on, 1)
  on('classic.SessionStart', () => ({}))
  // A resumed session whose last reply was 50 minutes ago: 10 minutes left.
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 50 * 60 })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cache-pulse',
      surface,
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: '10m left' })).toBeDefined()
    await ui.press({ key: 'warm' })
    expect(await ui.find({ type: 'Text', text: '1h left' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Warmed 0s ago · 100% hit/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(50 * 60_000)
  }
  expect(forks).toBe(2)
})

test('auto mode warms before expiry, then stops at the cap and notifies', { options: { keepWarm: 'auto', keepWarmMax: 2 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  let forks = 0
  const notes: string[] = []
  on('model.fork', () => {
    forks += 1

    return FORK_OK
  })
  on('ui.notify', (_$, e) => {
    notes.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  // Resumed 50 minutes after the last reply: 10 minutes left.
  await resumeInTerminal($, on, 50 * 60)

  await clock.advance(6 * 60_000) // 4m left: first auto-warm
  expect(forks).toBe(1)
  await clock.advance(56 * 60_000) // 4m left again: second
  expect(forks).toBe(2)
  await clock.advance(56 * 60_000) // cap reached: notify instead
  expect(forks).toBe(2)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Auto-warm stopped after 2 in a row')
})

test('the TTL comes from the newest cache write the API reported', async () => {
  const row = (ttl: '1h' | '5m' | null, extra = '') =>
    JSON.stringify({
      type: 'assistant',
      ...(extra ? { isSidechain: true } : {}),
      message: {
        usage: {
          cache_creation: {
            ephemeral_1h_input_tokens: ttl === '1h' ? 900 : 0,
            ephemeral_5m_input_tokens: ttl === '5m' ? 900 : 0,
          },
        },
      },
    })
  expect(lastWriteTtl([row('1h'), row('5m')].join('\n'))).toBe('5m')
  // A read-only reply and a subagent's write say nothing about the main cache.
  expect(lastWriteTtl([row('1h'), row(null), row('5m', 'sidechain')].join('\n'))).toBe('1h')
  expect(lastWriteTtl('{"type":"user"}')).toBeNull()
})

test('the band marks an assumed TTL and follows the engine on a model switch', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  engineBand(on, 1)
  on('classic.PreModelSwitch', () => ({}))

  const before = await $.ui.mount({
    plugin: 'cache-pulse',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await before.find({ type: 'Text', text: '/ 1h?' })).toBeDefined()
  await before.unmount()

  await $.classic.PreModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: 90_000,
    prompt_cache_warm: true,
    cache_ttl: '5m',
    estimated_cache_write_usd: 0.3,
  } as never)

  const after = await $.ui.mount({
    plugin: 'cache-pulse',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await after.find({ type: 'Text', text: '/ 5m' })).toBeDefined()
  await after.unmount()
})

test('the band says it is warming while the fork runs', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('model.fork', async () => {
    await held

    return FORK_OK
  })
  engineBand(on, 1)
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 50 * 60 })

  const ui = await $.ui.mount({ plugin: 'cache-pulse', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  const pressing = ui.press({ key: 'warm' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'Warming…' })).toBeDefined()
  expect(await ui.find({ key: 'warm' })).toBeUndefined()
  release()
  await pressing
  expect(await ui.find({ type: 'Text', text: 'Warming…' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '1h left' })).toBeDefined()
  await ui.unmount()
})

test('an MCP server connecting mid-session is not named as the cause', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  let tools = [
    { name: 'Bash', description: 'Runs a command', mcp: false },
    { name: 'Read', description: 'Reads a file', mcp: false },
  ]
  on('tool.list', () => ({ value: tools }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  engineBand(on, 2)
  let next = step('claude-opus-5-5', use(0, 100_000))
  on('turn.step', async function* (_$, e) {
    return { ...next, turnId: e.turnId, index: e.index }
  })

  await drain($.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await clock.advance(60_000)
  tools = [
    ...tools,
    { name: 'mcp__linear__create_issue', description: 'Creates an issue', mcp: true },
    { name: 'mcp__linear__list_issues', description: 'Lists issues', mcp: true },
  ]
  next = step('claude-opus-5-5', use(0, 104_000))
  await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 }))

  const ui = await $.ui.mount({ plugin: 'cache-pulse', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  // The mod cannot read the tools the request sent, so it names none.
  expect(await ui.find({ type: 'Text', text: /The cause is not visible to the mod\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /linear/ })).toBeUndefined()
  await ui.unmount()
})

test('the last turn shows its cache hit, and no model', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  engineBand(on, 2)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.turn.complete({
    turnId: 't',
    reason: 'answer',
    answer: 'done',
    durationMs: 120_000,
    isAborted: false,
    usage: { ...use(99_000, 1_000, 0), model: 'claude-opus-5-5' },
  })

  const ui = await $.ui.mount({ plugin: 'cache-pulse', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Cache hit: last turn 99%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /opus/ })).toBeUndefined()
  await ui.unmount()
})

test('a /clear starts the conversation over and keeps the TTL', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  engineBand(on, 2)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.PreModelSwitch', () => ({}))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.turn.complete({
    turnId: 't',
    reason: 'answer',
    answer: 'done',
    durationMs: 1_000,
    isAborted: false,
    usage: { ...use(99_000, 1_000, 0), model: 'claude-opus-5-5' },
  })
  await $.classic.PreModelSwitch({ cache_ttl: '5m' } as never)
  await $.session.end({ reason: 'clear', sessionId: 'id' } as never)

  const ui = await $.ui.mount({ plugin: 'cache-pulse', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: 'waiting for a turn' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cache hit/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '/ 5m' })).toBeDefined()
  await ui.unmount()
})

test('a failed auto-warm is tried once, and the expiry warning still comes', { options: { keepWarm: 'auto', keepWarmMax: 3 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  let forks = 0
  const toasts: string[] = []
  const notes: string[] = []
  on('model.fork', () => {
    forks += 1

    return {
      value: {
        isAnswered: false,
        reason: 'api-error',
        status: 529,
        error: 'overloaded_error',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never,
    }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', (_$, e) => {
    notes.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  // Resumed 50 minutes after the last reply: 10 minutes left.
  await resumeInTerminal($, on, 50 * 60)

  await clock.advance(6 * 60_000) // 4m left: the auto-warm fails
  await clock.advance(2 * 60_000) // eight more ticks
  expect(forks).toBe(1)
  expect(toasts.filter(t => t.startsWith('Keep-warm failed')).length).toBe(1)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Auto-warm failed.')
})

test('a turn you start while the ping runs still counts, and the ping\'s own does not', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * HOUR })
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  on('model.fork', async () => {
    await held

    return FORK_OK
  })
  engineBand(on, 1)
  on('classic.SessionStart', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { ...step('claude-opus-5-5', e.turnId === 'ping' ? use(0, 50_000) : use(90_000, 1_000)), turnId: e.turnId, index: e.index }
  })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 50 * 60 })

  const ui = await $.ui.mount({ plugin: 'cache-pulse', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  const pressing = ui.press({ key: 'warm' })
  await clock.settle()
  // Should the fork raise a turn of its own, it is left out.
  await $.turn.start({ turnId: 'ping', text: PING })
  await drain($.turn.step({ turnId: 'ping', index: 0, model: 'claude-opus-5-5', messageCount: 9 }))
  // Yours, sent while the ping runs.
  await $.turn.start({ turnId: 'yours', text: 'next question' })
  await drain($.turn.step({ turnId: 'yours', index: 0, model: 'claude-opus-5-5', messageCount: 9 }))
  release()
  await pressing
  expect(await ui.find({ type: 'Text', text: 'Cache live' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Cache hit: session avg 99%' })).toBeDefined()
  await ui.unmount()
})

test('the cold ratio follows the model of the last request', async ($, on) => {
  mock.clock(on, { now: 10 * HOUR })
  engineBand(on, 2)
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({
    source: 'resume',
    seconds_since_last_response: 2 * 3600,
    context_tokens: 90_000,
    model: 'claude-opus-5-5',
  })

  const ui = await $.ui.mount({ plugin: 'cache-pulse', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /next prompt rewrites 90k tokens: ≈40× the API cost of a warm prompt/ })).toBeDefined()
  await ui.unmount()
})
