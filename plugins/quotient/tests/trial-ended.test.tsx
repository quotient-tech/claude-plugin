import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { runTool } from './fixtures/run-tool'

const SERVER = 'plugin:quotient:agex'
const INTERACTIVE = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const FIFTEEN_MINUTES = 15 * 60 * 1000
const ENDED = "Your company's Quotient free trial has ended, so the plugin has stopped working."
const ADMIN_REFUSAL = `${ENDED} Upgrade your plan to use it again: https://app.getquotient.com/billing`
const EMPTY_PAGE = JSON.stringify({ frictions: [], nextCursor: null })
const ONE_FIX_PAGE = JSON.stringify({
  frictions: [{ solutions: [{ isOwn: false, implementedAt: null, viewedAt: null }] }],
  nextCursor: null,
})

type Api = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const COMMANDS = ['setup', 'list-fixes', 'fix-friction', 'find-solutions', 'review-frictions'].map(name => `quotient:${name}`)
const SKILL_TEXT = 'the skill ran'
const OPENED = 'Opened Quotient in a side pane'
const BILLING = 'https://app.getquotient.com/billing'
const NON_ADMIN_REFUSAL = `${ENDED} Ask a Quotient admin at your company to upgrade its plan.`
const PANE = {
  plugin: 'quotient',
  component: 'Pane',
  requestId: 'trial-ended',
  props: {
    title: 'Quotient',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/**
 * The person typing a command at the prompt.
 *
 * @param command - The command's name
 * @returns The command's run
 */
function typed(command: string) {
  return { command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const
}

/**
 * Fakes the engine around the plugin: Quotient answers every tool with the
 * trial-ended refusal while `ended` is true, and with an empty page otherwise.
 *
 * @param on - Adds the test's hooks
 * @param opts - The fake's settings
 * @param opts.refusal - The refusal sent while the trial has ended
 * @param opts.page - The page `list_my_frictions` sends while it hasn't
 * @param opts.sessionId - What `$.session.id()` answers
 * @param opts.stored - Values an earlier session left in the plugin's state, by key
 * @param opts.isPlaced - Whether a pane opens
 * @param opts.isCopied - Whether a copy reaches the clipboard
 * @returns What the plugin did, and a switch for the trial
 */
function engine(
  on: On,
  opts: {
    refusal?: string
    page?: string
    sessionId?: string
    stored?: Record<string, unknown>
    isPlaced?: boolean
    isCopied?: boolean
  } = {},
) {
  const seen = {
    ended: true,
    calls: [] as string[],
    status: [] as (string | undefined)[],
    logs: [] as string[],
    sessionIdAsks: 0,
    skills: [] as string[],
    opened: [] as Record<string, unknown>[],
    closed: [] as string[],
    copied: [] as string[],
  }
  mock.env(on, { HOME: '/home/op' })
  on('mcp.connect', () => ({ value: { isConnected: true, server: SERVER } }))
  on('mcp.call', (_, e) => {
    seen.calls.push(e.tool)
    if (seen.ended) return { value: { content: [{ type: 'text', text: opts.refusal ?? ADMIN_REFUSAL }], isError: true } }
    const text = e.tool === 'list_my_frictions' ? (opts.page ?? EMPTY_PAGE) : '{}'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('session.id', () => {
    seen.sessionIdAsks += 1
    return { value: opts.sessionId ?? 's1' }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    if (e.to !== 'debug') seen.logs.push(e.text)
    return { value: undefined }
  })
  if (opts.stored !== undefined) {
    // What an earlier session stored outlives it; this stands for the
    // engine's store of those values, versions included.
    const store = new Map(Object.entries(opts.stored).map(([key, value]) => [key, { value, version: 1 }]))
    on('state.get', (_, e, next) => {
      const kept = store.get(e.key)
      return kept === undefined ? next(e) : { value: kept }
    })
    on('state.set', (_, e, next) => {
      const kept = store.get(e.key)
      if (kept === undefined) return next(e)
      if (e.ifVersion !== undefined && e.ifVersion !== kept.version) return { value: { isSet: false, version: kept.version } }
      store.set(e.key, { value: e.value, version: kept.version + 1 })
      return { value: { isSet: true, version: kept.version + 1 } }
    })
  }
  on('command.run', (_, e) => {
    seen.skills.push(e.command)
    return { text: SKILL_TEXT }
  })
  on('ui.open', (_, e) => {
    seen.opened.push({ ...e })
    return { value: opts.isPlaced === false ? { isPlaced: false, reason: 'no-surface: a test' } : { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)
    return { value: opts.isCopied === false ? { isCopied: false, reason: 'no-clipboard' } : { isCopied: true } } as never
  })
  on('tool.call', () =>
    seen.ended
      ? { result: 'failed', text: opts.refusal ?? ADMIN_REFUSAL, isError: true as const }
      : { result: 'ran', text: '{"recorded":1}' },
  )
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quotient__${e.name}` } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return seen
}

test("a session that starts after the trial ended shows 'trial ended' in the status line", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.status.at(-1)).toBe('trial ended')
})

test('an ended trial shows nothing but the status line: every refused call stays out of the transcript', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(seen.logs).toEqual([])
})

test("'trial ended' stays for the rest of the session, even once Quotient answers again", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { page: ONE_FIX_PAGE })

  await $.session.start(INTERACTIVE)
  await clock.settle()
  seen.ended = false
  await clock.advance(FIFTEEN_MINUTES)
  await clock.settle()

  expect(seen.status).not.toEqual([])
  expect(seen.status.every(line => line === 'trial ended')).toBe(true)
})

test("a non-admin's refusal shows the same status line", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { refusal: `${ENDED} Ask a Quotient admin at your company to upgrade its plan.` })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.status.at(-1)).toBe('trial ended')
})

test("while the trial hasn't ended, the session's id is never asked for and the status line is unchanged", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { page: ONE_FIX_PAGE })
  seen.ended = false

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.status).toEqual(['1 friction to fix · run /list-fixes'])
  expect(seen.sessionIdAsks).toBe(0)
})

test("a trial end an earlier session saw doesn't carry over: the next session clears it", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    sessionId: 's2',
    page: ONE_FIX_PAGE,
    stored: {
      trialEnded: { sessionId: 's1', billingUrl: null },
      statusParts: { trialEnded: 'trial ended', setup: null, frictionsToFix: null, fixes: null },
    },
  })
  seen.ended = false

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.status.at(-1)).toBe('1 friction to fix · run /list-fixes')
})

/**
 * Starts an interactive session whose first read Quotient refuses, so the
 * session knows the trial has ended.
 *
 * @param $ - The engine
 * @param on - Adds the test's hooks
 * @param opts - The fake's settings
 * @returns What the plugin did
 */
async function endedSession($: Api, on: On, opts: Parameters<typeof engine>[1] = {}) {
  const clock = mock.clock(on)
  const seen = engine(on, opts)
  await $.session.start(INTERACTIVE)
  await clock.settle()
  return seen
}

/**
 * Draws the trial-ended pane and returns what it shows.
 *
 * @param $ - The engine
 * @returns The mounted pane and its joined text
 */
async function drawPane($: Api) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shown = (await ui.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  return { ui, shown }
}

for (const command of COMMANDS) {
  test(`once the trial has ended, /${command} opens the trial-ended pane and runs nothing`, async ($, on) => {
    const seen = await endedSession($, on)
    const callsBefore = seen.calls.length

    const ran = await $.command.run(typed(command))

    expect(ran.text).toBe(OPENED)
    expect(seen.opened.map(open => open.id)).toEqual(['trial-ended'])
    expect(seen.skills).toEqual([])
    expect(seen.calls.length).toBe(callsBefore)
  })
}

test("an admin's pane says the trial ended, offers the Billing page and Close, and shows none of Quotient's text", async ($, on) => {
  await endedSession($, on)
  await $.command.run(typed('quotient:list-fixes'))

  const { shown } = await drawPane($)

  for (const line of [
    'TRIAL ENDED',
    "Your company's Quotient trial has ended",
    'Quotient has stopped for everyone at your company.',
    'Frictions and fixes from the trial are kept, and come back when your company upgrades.',
    'Upgrade on the Billing page to turn it back on.',
    'Open Billing',
    BILLING,
    'Close',
    'any /quotient command shows this again',
    '↑↓ choose · Enter select · Esc close',
  ]) {
    expect(shown).toContain(line)
  }
  expect(shown).not.toContain('free trial')
  expect(shown).not.toContain('Ask a company admin')
})

test("anyone else's pane says to ask a company admin, and offers only Close", async ($, on) => {
  await endedSession($, on, { refusal: NON_ADMIN_REFUSAL })
  await $.command.run(typed('quotient:list-fixes'))

  const { shown } = await drawPane($)

  for (const line of [
    'TRIAL ENDED',
    "Your company's Quotient trial has ended",
    'Ask a company admin to upgrade to turn it back on.',
    "Only a company admin can upgrade. Quotient doesn't contact them for you.",
    '1. Close',
    'Enter select · Esc close',
  ]) {
    expect(shown).toContain(line)
  }
  expect(shown).not.toContain('Open Billing')
  expect(shown).not.toContain('billing')
  expect(shown).not.toContain('↑↓')
})

test("Enter on Open Billing copies the Billing page's address and says so", async ($, on) => {
  const seen = await endedSession($, on)
  await $.command.run(typed('quotient:list-fixes'))
  const { ui } = await drawPane($)

  await ui.press({ key: 'billing' })

  await ui.unmount()

  expect(seen.copied).toEqual([BILLING])
  expect((await drawPane($)).shown).toContain('Copied the Billing link')
})

test("a copy that doesn't reach the clipboard says to click the link instead", async ($, on) => {
  await endedSession($, on, { isCopied: false })
  await $.command.run(typed('quotient:list-fixes'))
  const { ui } = await drawPane($)

  await ui.press({ key: 'billing' })
  await ui.unmount()

  expect((await drawPane($)).shown).toContain("Couldn't copy. Click the link instead")
})

test('Close closes the pane', async ($, on) => {
  const seen = await endedSession($, on)
  await $.command.run(typed('quotient:list-fixes'))
  const { ui } = await drawPane($)

  await ui.press({ key: 'close' })

  expect(seen.closed).toEqual(['trial-ended'])
})

test("where no pane can open, the command says the same as text and still runs nothing", async ($, on) => {
  const seen = await endedSession($, on, { isPlaced: false })

  const ran = await $.command.run(typed('quotient:find-solutions'))

  expect(ran.text).toContain("Your company's Quotient trial has ended")
  expect(ran.text).toContain(BILLING)
  expect(seen.skills).toEqual([])
})

test("a trial that ends mid-session is caught by the command's own call: the pane opens instead of the command's skill", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)
  seen.ended = false
  await $.session.start(INTERACTIVE)
  await clock.settle()
  seen.ended = true

  const ran = await $.command.run(typed('quotient:list-fixes'))

  expect(ran.text).toBe(OPENED)
  expect(seen.opened.map(open => open.id)).toContain('trial-ended')
  expect(seen.status.at(-1)).toBe('trial ended')
})

test("while the trial hasn't ended, a command runs as it always did", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)
  seen.ended = false
  await $.session.start(INTERACTIVE)
  await clock.settle()

  const ran = await $.command.run(typed('quotient:find-solutions'))

  expect(ran.text).toBe(SKILL_TEXT)
  expect(seen.skills).toEqual(['quotient:find-solutions'])
  expect(seen.sessionIdAsks).toBe(0)
})

test("a trial end kept by an earlier session doesn't block this session's commands", async ($, on) => {
  const seen = engine(on, { sessionId: 's2', stored: { trialEnded: { sessionId: 's1', billingUrl: null } } })
  seen.ended = false

  const ran = await $.command.run(typed('quotient:find-solutions'))

  expect(ran.text).toBe(SKILL_TEXT)
  expect(seen.opened).toEqual([])
})

for (const tool of ['mcp__plugin_quotient_agex__submit_solutions', 'mcp__claude_ai_Quotient__submit_solutions']) {
  test(`a refusal of Claude's own call opens the trial-ended pane and passes on unchanged: ${tool}`, async ($, on) => {
    const seen = engine(on)

    const called = await runTool($, { tool, answers: [] })

    expect(called.isError).toBe(true)
    expect(called.text).toBe(ADMIN_REFUSAL)
    expect(seen.opened.map(open => open.id)).toEqual(['trial-ended'])
    expect(seen.status.at(-1)).toBe('trial ended')
  })
}

test("Claude's quotient call that Quotient answers changes nothing", async ($, on) => {
  const seen = engine(on)
  seen.ended = false

  const called = await runTool($, { tool: 'mcp__plugin_quotient_agex__submit_solutions', answers: [] })

  expect(called.text).toBe('{"recorded":1}')
  expect(seen.opened).toEqual([])
  expect(seen.status).toEqual([])
})

test("another server's refusal in the same words is not a trial end", async ($, on) => {
  const seen = engine(on)

  await runTool($, { tool: 'mcp__other__submit_solutions', answers: [] })

  expect(seen.opened).toEqual([])
  expect(seen.status).toEqual([])
})
