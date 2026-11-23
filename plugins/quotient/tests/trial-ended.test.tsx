import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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

type On = Parameters<TestBody>[1]

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
 * @returns What the plugin did, and a switch for the trial
 */
function engine(
  on: On,
  opts: { refusal?: string; page?: string; sessionId?: string; stored?: Record<string, unknown> } = {},
) {
  const seen = {
    ended: true,
    calls: [] as string[],
    status: [] as (string | undefined)[],
    logs: [] as string[],
    sessionIdAsks: 0,
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
