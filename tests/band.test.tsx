import { expect, mock, test } from 'claude-code/testing'

import {
  cacheState,
  coldRatio,
  breakText,
  EMPTY_LEDGER,
  fmtDur,
  fmtTokens,
  footerLabel,
  lastAssistantAt,
  lastWriteTtl,
  ledgerLine,
  missCause,
  requestChanges,
  tally,
  transcriptPath,
  ttlMs,
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

test('durations and token counts format', async () => {
  expect(fmtDur(45_000)).toBe('45s')
  expect(fmtDur(130 * 60_000)).toBe('2h10m')
  expect(fmtDur(76 * HOUR)).toBe('3d4h')
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(182_400)).toBe('182k')
  expect(fmtTokens(1_250_000)).toBe('1.3M')
  expect(coldRatio(HOUR)).toBe(20)
  expect(coldRatio(5 * 60_000)).toBe(12.5)
})

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
  expect(ledgerLine(l, 1)).toBe('Session 28% from cache · 1 cold start (102k rewritten) · 1 cache break (90k) · 1 compaction')
  expect(ledgerLine(EMPTY_LEDGER, 0)).toBeNull()
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
  on('session.usage', () => ({
    value: {
      startedAt: 9 * HOUR,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(12 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 81 },
      ],
      cost: { usd: 3.4 },
    },
  }))
  on('session.turns', () => ({ value: 3 }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
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
  on('session.usage', () => ({
    value: {
      startedAt: 9 * HOUR,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 76, resetsAt: new Date(12 * HOUR).toISOString() }],
    },
  }))
  on('session.turns', () => ({ value: 3 }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
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
  on('session.usage', () => ({ value: { startedAt: 9 * HOUR, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.turns', () => ({ value: 2 }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
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
  on('session.usage', () => ({ value: { startedAt: 9 * HOUR, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.turns', () => ({ value: 2 }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
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

    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 0,
        },
      },
    }
  })
  on('session.usage', () => ({
    value: { startedAt: 9 * HOUR, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.turns', () => ({ value: 1 }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
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
  mock.env(on, { HOME: '/h' })
  let forks = 0
  const notes: string[] = []
  on('model.fork', () => {
    forks += 1

    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('ui.notify', (_$, e) => {
    notes.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  on('session.cwd', () => ({ value: '/x' }))
  on('session.id', () => ({ value: 'id' }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', () => ({ cwd: '/x' }))
  on('classic.SessionStart', () => ({}))

  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 50 * 60 })

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
  on('session.usage', () => ({
    value: { startedAt: 9 * HOUR, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.turns', () => ({ value: 1 }))
  on('classic.PreModelSwitch', () => ({}))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

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

    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('session.usage', () => ({
    value: { startedAt: 9 * HOUR, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.turns', () => ({ value: 1 }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
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
  on('session.usage', () => ({ value: { startedAt: 9 * HOUR, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.turns', () => ({ value: 2 }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
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
