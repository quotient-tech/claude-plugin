import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { FrictionRow } from '../types'
import { denial } from './fixtures/denial'
import { runTool } from './fixtures/run-tool'

type Api = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const LIST = 'quotient:list-fixes'
const FIX = 'quotient:fix-friction'
const SKILL_TEXT = 'the list-fixes skill ran'
const OPENED = 'Opened your frictions in a side pane'
const DENIED =
  "The Quotient pane couldn't read your frictions because Claude Code denied its call to Quotient. Why: https://github.com/quotient-tech/claude-plugin#if-claude-code-denies-quotients-calls"
const NO_FIXES = "No fixes from teammates yet. They'll show up in the status line when they arrive."
const ALL_APPLIED = "You've applied every teammate fix so far. New ones will show up in the status line when they arrive."
// The person typing /quotient:list-fixes at the prompt.
const TYPED = {
  command: LIST,
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
} as const
const LONG_TITLE =
  'The sandbox has Node 22 where the repo needs Node 26, so every test run fails before it reaches a single assertion'

/**
 * Builds one friction as `list_my_frictions` returns it with `format: "rows"`.
 *
 * @param id - The friction id
 * @param extra - Fields to override
 * @returns The row
 */
function row(id: string, extra: Partial<FrictionRow> = {}): FrictionRow {
  return {
    id,
    title: `Title of ${id}`,
    symbol: '▲',
    severity: 'High',
    status: '1 fix',
    description: `Description of ${id}`,
    identified: '2026-10-02',
    frequency: 'Every new worktree',
    impact: 'About ten minutes per worktree',
    affectedSessionCount: null,
    reviewedSessionCount: null,
    isFixable: true,
    solutions: [{ id: `s-${id}`, description: `Fix for ${id}`, found: '2026-10-21', isImplemented: false }],
    ownFix: null,
    ...extra,
  }
}

// Two frictions with a fix left to apply, then two the pane leaves out.
const ROWS: FrictionRow[] = [
  row('fr-1', {
    title: LONG_TITLE,
    solutions: [{ id: 's-1', description: 'Install Node 26 in the setup script', found: '2026-10-19', isImplemented: false }],
  }),
  row('fr-2', {
    symbol: '◆',
    severity: 'Medium',
    status: '1 of 3 done',
    isFixable: true,
    solutions: [
      { id: 's-2a', description: 'Pin Node 26 with fnm in the setup script', found: '2026-10-20', isImplemented: true },
      { id: 's-2b', description: null, found: '2026-10-21', isImplemented: false },
      { id: 's-2c', description: 'Use the Node 26 image', found: '2026-10-22', isImplemented: false },
    ],
  }),
  row('fr-3', {
    symbol: '•',
    severity: 'unclear',
    status: 'fixed by you',
    isFixable: false,
    solutions: [{ id: 's-3', description: 'Start Docker first', found: '2026-10-25', isImplemented: false }],
    ownFix: { description: 'Start Docker in the setup script', day: '2026-10-27' },
  }),
  row('fr-4', {
    status: '1 of 1 done',
    isFixable: false,
    solutions: [{ id: 's-4', description: 'Cache the image', found: '2026-10-23', isImplemented: true }],
  }),
]
// The frictions the pane lists from ROWS.
const LISTED = ROWS.filter(one => one.isFixable)

const PANE = {
  plugin: 'quotient',
  component: 'Pane',
  requestId: 'frictions',
  props: {
    title: 'Quotient',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SERVER = 'plugin:quotient:agex'
const CONNECTOR = 'claude.ai Quotient'

/**
 * Builds one page of `list_my_frictions` with `format: "rows"`, as its text.
 *
 * @param frictions - The page's rows
 * @param nextCursor - Where the next page starts, or null on the last page
 * @returns The page as the tool's text
 */
function page(frictions: unknown[], nextCursor: string | null = null): string {
  return JSON.stringify({ frictions, nextCursor })
}

type Connect = { isConnected: true; server: string } | { isConnected: false; reason: 'unlisted' | 'auth'; message: string }

/**
 * Answers the plugin's calls the way the engine would, and records them.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param opts.replies - The text of each `list_my_frictions` reply in turn; the last repeats
 * @param opts.isError - Whether the tool reports its call as failed
 * @param opts.connect - What `$.mcp.connect("agex")` resolves to
 * @param opts.isPlaced - Whether the pane is placed
 * @param opts.callFails - Whether the tool call rejects
 * @param opts.callDenied - The reason Claude Code denies the pane's call with
 * @param opts.newFixes - How many frictions the fix-status part's json read finds
 * @returns What the plugin connected, called, opened, closed, logged to the
 *   transcript and to the debug log, ran and showed on the status line, how
 *   many json reads the fix-status part made, and how many thank-you checks
 */
function engine(
  on: On,
  opts: {
    replies?: string[]
    isError?: boolean
    connect?: Connect
    isPlaced?: boolean
    callFails?: boolean
    callDenied?: string
    newFixes?: number
  } = {},
) {
  const seen = {
    connected: [] as string[],
    calls: [] as { server: string; tool: string; args: Record<string, unknown> }[],
    opened: [] as Record<string, unknown>[],
    closed: [] as string[],
    logged: [] as string[],
    debugged: [] as string[],
    commands: [] as { command: string; args?: string }[],
    status: [] as (string | undefined)[],
    fixReads: 0,
    thankYouChecks: 0,
  }
  on('mcp.connect', (_, e) => {
    seen.connected.push(e.server)
    return { value: opts.connect ?? { isConnected: true, server: SERVER } }
  })
  on('mcp.call', (_, e) => {
    // The fix-status part reads the same tool as json; its reads are answered
    // and counted apart, so these tests see only the pane's.
    if (e.args.format === 'json') {
      seen.fixReads += 1
      const fix = { isOwn: false, implementedAt: null, viewedAt: null }
      const frictions = Array.from({ length: opts.newFixes ?? 0 }, () => ({ solutions: [fix] }))
      return { value: { content: [{ type: 'text', text: JSON.stringify({ frictions, nextCursor: null }) }], isError: false } }
    }
    if (e.tool === 'check_thank_yous') {
      seen.thankYouChecks += 1
      return { value: { content: [{ type: 'text', text: '{"thankYous":[]}' }], isError: false } }
    }
    seen.calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (opts.callFails) throw new Error('call failed')
    if (opts.callDenied !== undefined) return { deny: opts.callDenied }
    const replies = opts.replies ?? [page(ROWS)]
    const text = replies[Math.min(seen.calls.length, replies.length) - 1]!
    return { value: { content: [{ type: 'text', text }], isError: opts.isError ?? false } }
  })
  on('ui.open', (_, e) => {
    seen.opened.push({ ...e })
    return { value: opts.isPlaced === false ? { isPlaced: false, reason: 'no-surface: a test' } : { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    if (e.to === 'debug') seen.debugged.push(e.text)
    else seen.logged.push(e.text)
    return { value: undefined }
  })
  on('command.run', (_, e) => {
    seen.commands.push({ command: e.command, args: e.args })
    return { text: e.command === LIST ? SKILL_TEXT : '' }
  })
  return seen
}

/**
 * Presses a row or a fix. Opening a friction's details ends by moving the
 * focus ring with $.ui.focus, which the test kit doesn't hand to a test's
 * hooks, so that error shows the press got that far.
 *
 * @param ui - The mounted pane
 * @param key - The element's key
 */
async function press(ui: { press: (target: { key: string }) => Promise<unknown> }, key: string) {
  try {
    await ui.press({ key })
  } catch (err) {
    expect(String(err)).toMatch(/no implementation for ui\.focus/)
  }
}

/**
 * Asserts that each part appears in the text, in the order given.
 *
 * @param shown - The drawn text
 * @param parts - What it must hold, in order
 */
function expectInOrder(shown: string, parts: readonly string[]) {
  let from = 0
  for (const part of parts) {
    const at = shown.indexOf(part, from)
    expect(at).toBeGreaterThanOrEqual(from)
    from = at + part.length
  }
}

/**
 * Draws the pane and returns what it shows.
 *
 * @param $ - The engine
 * @param bodyColumns - The pane's body width
 * @returns The mounted pane and its joined text
 */
async function drawPane($: Api, bodyColumns = 80) {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
  const shown = (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  return { ui, shown }
}

test('the command opens the Quotient pane with focus, says so, and runs no skill', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  const ran = await $.command.run(TYPED)
  await clock.settle()

  expect(ran.text).toBe(OPENED)
  // One connect for the pane; the rest were the fix-status part's and the
  // thank-yous check's own.
  expect(seen.connected.length - seen.fixReads - seen.thankYouChecks).toBe(1)
  expect(seen.connected.every(server => server === 'agex')).toBe(true)
  expect(seen.calls).toEqual([{ server: SERVER, tool: 'list_my_frictions', args: { format: 'rows' } }])
  expect(seen.opened).toHaveLength(1)
  expect(seen.opened[0]).toMatchObject({ id: 'frictions', title: 'Quotient', focus: true, closeOnEscape: true, columns: 200 })
  expect(seen.opened[0]?.holdToasts).toBeUndefined()
  expect(seen.commands).toEqual([])
})

test('once the pane has opened, the fix-status part reads its count again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { newFixes: 2 })

  await $.command.run(TYPED)
  await clock.settle()

  expect(seen.fixReads).toBe(1)
  expect(seen.status).toEqual(['2 frictions to fix · run /list-fixes'])
})

test("when the pane's read rejects, nothing was seen, so the fix-status part waits for its next refresh", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { callFails: true, newFixes: 2 })

  await $.command.run(TYPED)
  await clock.settle()

  expect(seen.fixReads).toBe(0)
})

test('the pane reads every page of the frictions before it opens', async ($, on) => {
  const seen = engine(on, { replies: [page(ROWS.slice(0, 1), 'c-2'), page(ROWS.slice(1))] })

  await $.command.run(TYPED)
  const { shown } = await drawPane($)

  expect(seen.calls.map(call => call.args)).toEqual([{ format: 'rows' }, { format: 'rows', cursor: 'c-2' }])
  expect(shown).toContain(`FIXES READY · ${LISTED.length}`)
})

test("in a cloud session, where the plugin's server isn't listed, the pane reads through the Quotient connector", async ($, on) => {
  const seen = engine(on, { connect: { isConnected: false, reason: 'unlisted', message: 'not listed' } })

  const ran = await $.command.run(TYPED)

  expect(ran.text).toBe(OPENED)
  expect(seen.calls[0]?.server).toBe(CONNECTOR)
})

test('running the command again while the pane is open focuses it and shows fresh rows', async ($, on) => {
  const fresh = [row('fr-9', { title: 'A newer friction' })]
  const seen = engine(on, { replies: [page(ROWS), page(fresh)] })
  await $.command.run(TYPED)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.command.run(TYPED)

  expect(seen.opened).toHaveLength(2)
  expect(seen.opened[1]).toMatchObject({ id: 'frictions', focus: true })
  expect((await ui.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['fr-9'])
  await ui.unmount()
})

test('with no teammate fixes the pane stays shut and the transcript says so', async ($, on) => {
  const seen = engine(on, { replies: [page([])] })

  const ran = await $.command.run(TYPED)

  expect(ran.text).toBe(NO_FIXES)
  expect(seen.opened).toEqual([])
  expect(seen.commands).toEqual([])
})

test('when every friction has its teammate fixes applied, the pane stays shut and the transcript says so', async ($, on) => {
  const seen = engine(on, { replies: [page(ROWS.filter(one => !one.isFixable))] })

  const ran = await $.command.run(TYPED)

  expect(ran.text).toBe(ALL_APPLIED)
  expect(seen.opened).toEqual([])
  expect(seen.commands).toEqual([])
})

test('when Claude Code denies the read, the transcript says so and the command goes on to the skill', async ($, on) => {
  const seen = engine(on, { callDenied: denial(SERVER, 'list_my_frictions') })

  const ran = await $.command.run(TYPED)

  expect(seen.logged).toEqual([DENIED])
  expect(ran.text).toBe(SKILL_TEXT)
  expect(seen.commands.map(run => run.command)).toEqual([LIST])
  expect(seen.opened).toEqual([])
  expect(seen.debugged.filter(line => line.includes('list_my_frictions denied'))).toHaveLength(1)
})

test("when the read rejects otherwise, only the debug log says why and the skill lists the frictions as text", async ($, on) => {
  const seen = engine(on, { callFails: true })

  const ran = await $.command.run(TYPED)

  expect(seen.logged).toEqual([])
  expect(ran.text).toBe(SKILL_TEXT)
  expect(seen.debugged.filter(line => line.startsWith('quotient list-fixes: list_my_frictions failed: '))).toHaveLength(1)
})

test('when the reply is not usable rows, the debug log says so and the command goes on to the skill', async ($, on) => {
  const seen = engine(on, { isError: true })

  const ran = await $.command.run(TYPED)

  expect(ran.text).toBe(SKILL_TEXT)
  expect(seen.logged).toEqual([])
  expect(seen.debugged).toContain('quotient list-fixes: list_my_frictions gave no usable page')
})

const FALLBACKS: { name: string; opts: Parameters<typeof engine>[1]; opens: boolean }[] = [
  { name: 'the tool reports an error', opts: { isError: true }, opens: false },
  { name: "the tool's reply isn't JSON", opts: { replies: ['<html>'] }, opens: false },
  { name: 'the rows have the wrong shape', opts: { replies: [page([{ id: 'fr-1' }])] }, opens: false },
  { name: 'a solution has no id', opts: { replies: [page([{ ...ROWS[1], solutions: [{ found: 'x', isImplemented: false }] }])] }, opens: false },
  { name: 'a row has no own-fix field', opts: { replies: [page([{ ...ROWS[1], ownFix: undefined }])] }, opens: false },
  { name: 'a later page fails', opts: { replies: [page(ROWS, 'c-2'), 'Quotient couldn\'t complete this request'] }, opens: false },
  { name: 'the tool call rejects', opts: { callFails: true }, opens: false },
  { name: "the operator isn't signed in", opts: { connect: { isConnected: false, reason: 'auth', message: 'needs sign-in' } }, opens: false },
  { name: 'a session count is not a whole number', opts: { replies: [page([{ ...ROWS[1], affectedSessionCount: 1.5 }])] }, opens: false },
  { name: 'the pane is not placed', opts: { isPlaced: false }, opens: true },
]

for (const { name, opts, opens } of FALLBACKS) {
  test(`the skill lists the frictions as text instead when ${name}`, async ($, on) => {
    const seen = engine(on, opts)

    const ran = await $.command.run(TYPED)

    expect(ran.text).toBe(SKILL_TEXT)
    expect(seen.commands.map(run => run.command)).toEqual([LIST])
    expect(seen.opened).toHaveLength(opens ? 1 : 0)
    expect(seen.closed).toEqual(opens ? ['frictions'] : [])
  })
}

test('the list shows the header, the count, each row, the note and the key hints, in order', async ($, on) => {
  engine(on)
  await $.command.run(TYPED)

  const { ui, shown } = await drawPane($)
  const buttons = await ui.findAll({ type: 'Button' })
  await ui.unmount()

  expectInOrder(shown, [
    'Quotient',
    'FIXES READY · 2',
    'Only frictions with a teammate fix left to apply are listed.',
    '↑↓ move · Enter open · Esc close',
  ])
  expect(buttons.map(button => button.key)).toEqual(['fr-1', 'fr-2'])
  expect(shown).toContain('1 of 3 done')
})

test('a friction with no teammate fix left to apply is not listed', async ($, on) => {
  engine(on)
  await $.command.run(TYPED)

  const { ui, shown } = await drawPane($)
  const buttons = await ui.findAll({ type: 'Button' })
  await ui.unmount()

  expect(buttons.map(button => button.key)).not.toContain('fr-3')
  expect(buttons.map(button => button.key)).not.toContain('fr-4')
  expect(shown).not.toContain('fixed by you')
  expect(shown).not.toContain('1 of 1 done')
})

test('each row shows its severity symbol in its color and its status in green', async ($, on) => {
  engine(on)
  await $.command.run(TYPED)

  const { ui } = await drawPane($)
  const high = await ui.find({ type: 'Text', text: '▲' })
  const medium = await ui.find({ type: 'Text', text: '◆' })
  const status = await ui.find({ type: 'Text', text: '1 of 3 done' })
  await ui.unmount()

  expect(high?.props.color).toBe('error')
  expect(medium?.props.color).toBe('warning')
  expect(status?.props.color).toBe('success')
})

test('a long title is shown whole, never cut with an ellipsis, however narrow the pane', async ($, on) => {
  engine(on)
  await $.command.run(TYPED)

  for (const columns of [80, 40]) {
    const { ui, shown } = await drawPane($, columns)
    const title = await ui.find({ type: 'Button', key: 'fr-1' })
    await ui.unmount()
    expect(title?.text).toBe(LONG_TITLE)
    expect(shown).not.toContain('…')
  }
})

test('the desktop app draws the same rows', async ($, on) => {
  engine(on)
  await $.command.run(TYPED)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const buttons = await ui.findAll({ type: 'Button' })
  await ui.unmount()

  expect(buttons.map(button => button.text)).toEqual([LONG_TITLE, 'Title of fr-2'])
})

test('a friction with fixes to use opens details that lead with the friction, then numbered fixes', async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED)

  const { ui } = await drawPane($)
  await press(ui, 'fr-2')
  const shown = (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  const buttons = await ui.findAll({ type: 'Button' })

  expectInOrder(shown, [
    'Quotient',
    'FRICTION',
    'Title of fr-2',
    'Found 2026-10-02',
    '◆ Medium',
    ' · About ten minutes per worktree · Every new worktree',
    'Description of fr-2',
    'FIXES FROM TEAMMATES',
    '1. Pin Node 26 with fnm in the setup script',
    'implemented · found 2026-10-20',
    'recommended · found 2026-10-21',
    'found 2026-10-22',
    '↑↓ choose · Enter use this fix · Esc back',
  ])
  // Only the fixes still to implement can be picked; the first of them is recommended.
  expect(buttons.map(button => [button.key, button.text])).toEqual([
    ['fix:s-2b', '2. A prompt only'],
    ['fix:s-2c', '3. Use the Node 26 image'],
  ])
  expect((await ui.findAll({ type: 'Text', text: 'recommended · ' })).length).toBeGreaterThan(0)
  await ui.unmount()
  expect(seen.opened).toHaveLength(2)
  expect(seen.opened[1]?.rows).toBeGreaterThan(8)
})

test('the details never show an email, a prompt or an id', async ($, on) => {
  engine(on)
  await $.command.run(TYPED)

  const { ui } = await drawPane($)
  await press(ui, 'fr-2')
  const shown = (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  await ui.unmount()

  expect(shown).not.toContain('@')
  for (const id of ['s-2a', 's-2b', 's-2c']) expect(shown).not.toContain(id)
})

test('the details show how many sessions a counted friction appeared in, and their share', async ($, on) => {
  const counted = [
    row('fr-6', { affectedSessionCount: 12, reviewedSessionCount: 86 }),
    row('fr-7', { affectedSessionCount: 1, reviewedSessionCount: null }),
    row('fr-8', { affectedSessionCount: 1, reviewedSessionCount: 400 }),
  ]
  engine(on, { replies: [page(counted)] })
  await $.command.run(TYPED)

  const shown: string[] = []
  for (const id of ['fr-6', 'fr-7', 'fr-8']) {
    const { ui } = await drawPane($)
    await press(ui, id)
    shown.push((await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n'))
    await ui.unmount()
    await $.command.run(TYPED)
  }

  expect(shown[0]).toContain(' · About ten minutes per worktree · 12 occurrences in last 2 weeks · 14% of sessions')
  expect(shown[0]).not.toContain('Every new worktree')
  expect(shown[1]).toContain(' · 1 occurrence in last 2 weeks')
  expect(shown[1]).not.toContain('% of sessions')
  expect(shown[2]).toContain('1 occurrence in last 2 weeks · 1% of sessions')
})

test("the details name a friction's impact category by its label, and show older freeform impact as sent", async ($, on) => {
  const labels: Record<string, string> = {
    SAFETY: 'Safety & privacy',
    QUALITY: 'Quality',
    BLOCKED: 'Blocked',
    OPERATOR_ATTENTION: 'Operator effort',
    COST: 'Token cost',
    TIME: 'Time lost',
  }
  const categorized = Object.keys(labels).map(impact => row(`fr-${impact}`, { impact }))
  engine(on, { replies: [page([...categorized, row('fr-legacy')])] })
  await $.command.run(TYPED)

  const shown = new Map<string, string>()
  for (const { id } of [...categorized, row('fr-legacy')]) {
    const { ui } = await drawPane($)
    await press(ui, id)
    shown.set(id, (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n'))
    await ui.unmount()
    await $.command.run(TYPED)
  }

  for (const [impact, label] of Object.entries(labels)) {
    expect(shown.get(`fr-${impact}`)).toContain(` · ${label} · Every new worktree`)
    expect(shown.get(`fr-${impact}`)).not.toContain(` · ${impact} · `)
  }
  expect(shown.get('fr-legacy')).toContain(' · About ten minutes per worktree · Every new worktree')
})

test('one fix to use is not marked recommended', async ($, on) => {
  const single = [row('fr-5', { isFixable: true, solutions: [{ id: 's-5', description: 'Only fix', found: '2026-10-21', isImplemented: false }] })]
  engine(on, { replies: [page(single)] })
  await $.command.run(TYPED)

  const { ui } = await drawPane($)
  await press(ui, 'fr-5')
  const shown = (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  await ui.unmount()

  expect(shown).toContain('1.')
  expect(shown).not.toContain('recommended')
})

test("a fix picked in the pane shows its teammate's fix to fix-friction, even after a review hid them", async ($, on) => {
  engine(on)
  mock.env(on, {})
  on('tool.check', () => ({ decision: 'allow' }))
  const page = { frictions: [{ id: 'fr-2', solutions: [{ id: 's-2c', isOwn: false, prompt: 'Run ESLint from the repo root', implementedAt: null }] }], nextCursor: null }
  on('tool.call', { tool: 'mcp__plugin_quotient_agex__list_my_frictions' }, () => ({ result: 'ran', text: JSON.stringify(page) }))
  const listed = async () => {
    const called = await runTool($, { tool: 'mcp__plugin_quotient_agex__list_my_frictions', format: 'json' })
    const { result } = called as { result: unknown }
    return Array.isArray(result) ? result.map(block => (block as { text?: string }).text ?? '').join('') : (called.text ?? '')
  }
  await $.command.run({ ...TYPED, command: 'quotient:review-frictions' })
  expect(await listed()).not.toContain('Run ESLint from the repo root')

  await $.command.run(TYPED)
  const { ui } = await drawPane($)
  await press(ui, 'fr-2')
  await press(ui, 'fix:s-2c')
  await ui.unmount()

  expect(await listed()).toContain('Run ESLint from the repo root')
})

test('using a fix keeps the pane open without focus, outlines the row and starts fix-friction with both ids', async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED)

  const { ui } = await drawPane($)
  await press(ui, 'fr-2')
  await press(ui, 'fix:s-2c')
  const shown = (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  const outlined = await ui.find({ type: 'Box', key: 'row:fr-2' })
  const plain = await ui.find({ type: 'Box', key: 'row:fr-1' })
  await ui.unmount()

  expect(seen.closed).toEqual(['frictions'])
  expect(seen.opened.at(-1)).toMatchObject({ id: 'frictions', title: 'Quotient' })
  expect(seen.opened.at(-1)?.focus).toBeUndefined()
  expect(seen.logged).toEqual(['Using a teammate\'s fix for "Title of fr-2"'])
  expect(seen.commands).toEqual([{ command: FIX, args: 'fr-2 s-2c' }])
  expect(shown).toContain('FIXES READY · 2')
  expect(shown).toContain('working on 1 in the main thread')
  expect(shown).not.toContain('Esc close')
  expect(outlined?.props.borderStyle).toBe('round')
  expect(plain?.props.borderStyle).toBeUndefined()
})
