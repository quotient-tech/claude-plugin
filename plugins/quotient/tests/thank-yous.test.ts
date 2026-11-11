import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { readThankYous, thankYouText } from '../hooks/thank-yous'
import { denial } from './fixtures/denial'

const SERVER = 'plugin:quotient:agex'
const CONNECTOR = 'claude.ai Quotient'
const INTERACTIVE = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const HEADLESS = { cwd: '/data', surface: null, isInteractive: false } as const
const FIFTEEN_MINUTES = 15 * 60 * 1000
const ANSWERED = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const THANK_YOU_ID = '0b5d3c1e-8f4a-4d2b-9c6e-1a2b3c4d5e6f'
const SOLUTION_ID = '7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b'

type On = Parameters<TestBody>[1]
type Connect =
  | { isConnected: true; server: string }
  | { isConnected: false; reason: 'unlisted' | 'auth' | 'failed'; message: string }

/**
 * One thank-you as `check_thank_yous` returns it.
 *
 * @param fields - The fields that differ from a high-five for a described fix
 * @returns The thank-you
 */
function thankYou(
  fields: Partial<{ message: string | null; fixDescription: string | null; frictionTitle: string | null }> = {},
) {
  return {
    id: THANK_YOU_ID,
    solutionId: SOLUTION_ID,
    message: null,
    createdAt: '2026-11-05T12:00:00.000Z',
    fixDescription: 'Run ESLint from the repo root',
    frictionTitle: 'Lint fails in the pre-commit hook',
    ...fields,
  }
}

/**
 * A `check_thank_yous` reply.
 *
 * @param thankYous - The thank-yous it carries
 * @returns The tool's reply
 */
function reply(thankYous: unknown[]) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ thankYous }) }], isError: false }
}

/**
 * Answers the mod's calls the way the engine would, and records them.
 * `check_thank_yous` answers with `opts.reply`; every other Quotient tool
 * answers as having nothing to do.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param opts.reply - The text `check_thank_yous` replies with
 * @param opts.connect - What `$.mcp.connect("agex")` resolves to
 * @param opts.call - How `check_thank_yous` fails: it rejects, Claude Code denies it, or it never answers
 * @param opts.isHeadless - Whether the session draws on no surface, as a `claude -p` run
 * @param opts.wait - How long `check_thank_yous` takes to answer, on the test's clock
 * @returns What the mod called, showed and logged
 */
function engine(
  on: On,
  opts: {
    reply?: string
    connect?: Connect
    call?: 'rejects' | 'denied' | 'hangs'
    isHeadless?: boolean
    wait?: { clock: ReturnType<typeof mock.clock>; ms: number }
  } = {},
) {
  const seen = {
    reply: opts.reply ?? JSON.stringify({ thankYous: [] }),
    checks: [] as { server: string; args: Record<string, unknown> }[],
    toasts: [] as { text: string; timeoutMs?: number }[],
    status: [] as (string | undefined)[],
    logs: [] as { text: string; to: unknown }[],
  }
  mock.env(on, { HOME: '/home/op' })
  on('mcp.connect', () => ({ value: opts.connect ?? { isConnected: true, server: SERVER } }))
  on('mcp.call', async (_, e) => {
    if (e.tool !== 'check_thank_yous') {
      const text = e.tool === 'list_my_frictions' ? '{"frictions":[],"nextCursor":null}' : '{"due":false}'
      return { value: { content: [{ type: 'text', text }], isError: false } }
    }
    seen.checks.push({ server: e.server, args: e.args })
    if (opts.wait !== undefined) await opts.wait.clock.sleep(opts.wait.ms)
    if (opts.call === 'rejects') throw new Error('call failed')
    if (opts.call === 'denied') return { deny: denial(e.server, e.tool) }
    if (opts.call === 'hangs') return new Promise<never>(() => {})
    return { value: { content: [{ type: 'text', text: seen.reply }], isError: false } }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push({ text: e.text, timeoutMs: e.timeoutMs })
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    seen.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: opts.isHeadless ? [] : ['terminal'] }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quotient__${e.name}` } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.run', () => ({ text: '' }))
  return seen
}

test('a reply is read oldest first, keeping only what a toast shows', () => {
  const read = readThankYous(reply([thankYou(), thankYou({ message: 'That saved my afternoon' })]))
  expect(read).toEqual([
    { message: null, fixDescription: 'Run ESLint from the repo root', frictionTitle: 'Lint fails in the pre-commit hook' },
    {
      message: 'That saved my afternoon',
      fixDescription: 'Run ESLint from the repo root',
      frictionTitle: 'Lint fails in the pre-commit hook',
    },
  ])
})

test('a reply with no thank-yous, or with each text field null, is read', () => {
  expect(readThankYous(reply([]))).toEqual([])
  expect(readThankYous(reply([thankYou({ fixDescription: null, frictionTitle: null })]))).toEqual([
    { message: null, fixDescription: null, frictionTitle: null },
  ])
})

test('the read thank-yous keep no id', () => {
  expect(JSON.stringify(readThankYous(reply([thankYou()])))).not.toContain(THANK_YOU_ID)
  expect(JSON.stringify(readThankYous(reply([thankYou()])))).not.toContain(SOLUTION_ID)
})

test('a reply that failed or is not the expected shape reads as nothing', () => {
  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: false })
  const missingMessage = { ...thankYou() } as Record<string, unknown>
  delete missingMessage.message
  const cases = [
    { ...reply([thankYou()]), isError: true },
    text('not json'),
    text('null'),
    text(JSON.stringify({})),
    text(JSON.stringify({ thankYous: 'none' })),
    reply([null]),
    reply([missingMessage]),
    reply([thankYou({ message: 5 as unknown as string })]),
    reply([thankYou({ fixDescription: {} as unknown as string })]),
    reply([thankYou({ frictionTitle: false as unknown as string })]),
    { content: [], isError: false },
  ]
  for (const result of cases) expect(readThankYous(result)).toBeNull()
})

test('a high-five names the fix and never the sender', () => {
  expect(thankYouText({ message: null, fixDescription: 'Run ESLint from the repo root', frictionTitle: 'Lint fails' })).toBe(
    'High-five from a teammate · for your fix: Run ESLint from the repo root',
  )
})

test("a note shows in quotes, as the teammate wrote it, with the fix it's for", () => {
  expect(
    thankYouText({ message: 'That saved my afternoon, thanks! — sam@example.com', fixDescription: 'Use the setup script', frictionTitle: null }),
  ).toBe('Note from a teammate: "That saved my afternoon, thanks! — sam@example.com" · for your fix: Use the setup script')
})

test("a fix with no description is named by the friction it's for", () => {
  expect(thankYouText({ message: null, fixDescription: null, frictionTitle: 'Lint fails in CI' })).toBe(
    'High-five from a teammate · for your fix to: Lint fails in CI',
  )
})

test('with neither a fix description nor a friction title, only the thanks shows', () => {
  expect(thankYouText({ message: null, fixDescription: null, frictionTitle: null })).toBe('High-five from a teammate')
  expect(thankYouText({ message: 'Thanks!', fixDescription: null, frictionTitle: null })).toBe(
    'Note from a teammate: "Thanks!"',
  )
})

test('a fix description or friction title holding an id or email is left off', () => {
  expect(
    thankYouText({ message: null, fixDescription: 'Ask ops@example.com for access', frictionTitle: 'Lint fails in CI' }),
  ).toBe('High-five from a teammate · for your fix to: Lint fails in CI')
  expect(thankYouText({ message: null, fixDescription: null, frictionTitle: 'See fr-20261105-3' })).toBe(
    'High-five from a teammate',
  )
})

test('a note over 120 characters is cut to 120 with an ellipsis', () => {
  const text = thankYouText({ message: 'a'.repeat(121), fixDescription: null, frictionTitle: null })
  expect(text).toBe(`Note from a teammate: "${'a'.repeat(119)}…"`)
  expect(thankYouText({ message: 'a'.repeat(120), fixDescription: null, frictionTitle: null })).toBe(
    `Note from a teammate: "${'a'.repeat(120)}"`,
  )
})

test('a fix description over 200 characters is cut to 200 with an ellipsis', () => {
  expect(thankYouText({ message: null, fixDescription: 'b'.repeat(201), frictionTitle: null })).toBe(
    `High-five from a teammate · for your fix: ${'b'.repeat(199)}…`,
  )
})

test('cutting a note never splits an emoji in two', () => {
  const text = thankYouText({ message: '🎉'.repeat(130), fixDescription: null, frictionTitle: null })
  expect(text).toBe(`Note from a teammate: "${'🎉'.repeat(119)}…"`)
})

test('control characters, escape sequences and direction overrides never reach the toast', () => {
  const text = thankYouText({
    message: 'Thanks\x1b[31m red\x1b[0m \x1b]8;;https://evil.test\x07link\x1b]8;;\x07 \u202eevil\nnext\tline\x00',
    fixDescription: 'Use\r\nthe \x9bsetup\x7f script',
    frictionTitle: null,
  })
  expect(text).toBe('Note from a teammate: "Thanks red link evil next line" · for your fix: Use the setup script')
})

test('a note that is only control characters or spaces shows as a high-five', () => {
  expect(thankYouText({ message: ' \x1b[0m\n ', fixDescription: 'Use the setup script', frictionTitle: null })).toBe(
    'High-five from a teammate · for your fix: Use the setup script',
  )
})

test('an interactive session start checks for thank-yous once and shows one as a toast for 8 seconds', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { reply: JSON.stringify({ thankYous: [thankYou()] }) })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.checks).toEqual([{ server: SERVER, args: {} }])
  expect(seen.toasts).toEqual([
    { text: 'High-five from a teammate · for your fix: Run ESLint from the repo root', timeoutMs: 8000 },
  ])
  expect(seen.status).toEqual([])
})

test('no thank-yous shows nothing', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.checks.length).toBe(1)
  expect(seen.toasts).toEqual([])
})

test('a headless session never checks, so no thank-you is used up unseen', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { reply: JSON.stringify({ thankYous: [thankYou()] }), isHeadless: true })

  await $.session.start(HEADLESS)
  await clock.settle()

  expect(seen.checks).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('not signed in checks nothing and shows nothing', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    reply: JSON.stringify({ thankYous: [thankYou()] }),
    connect: { isConnected: false, reason: 'auth', message: 'sign in' },
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.checks).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('where the host runs the plugin servers itself, it checks through the Quotient connector', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    reply: JSON.stringify({ thankYous: [thankYou()] }),
    connect: { isConnected: false, reason: 'unlisted', message: 'run by the host' },
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.checks.map(check => check.server)).toEqual([CONNECTOR])
  expect(seen.toasts.length).toBe(1)
})

test('a malformed reply shows nothing and only logs to the debug log, without the reply', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { reply: 'NOTE-MARKER not json' })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.toasts).toEqual([])
  expect(seen.logs.map(log => log.to)).toEqual(['debug'])
  expect(seen.logs.some(log => log.text.includes('MARKER'))).toBe(false)
})

const FAILED_CALLS: ['rejects' | 'denied', RegExp][] = [
  ['rejects', /^quotient thank-yous: check_thank_yous failed: HooksError: /],
  ['denied', /^quotient thank-yous: check_thank_yous denied: HooksError: /],
]
for (const [call, logged] of FAILED_CALLS) {
  test(`a call that ${call === 'denied' ? 'Claude Code denies' : 'rejects'} shows nothing and logs why to the debug log only`, async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, { call })

    await $.session.start(INTERACTIVE)
    await clock.settle()

    expect(seen.toasts).toEqual([])
    expect(seen.logs.map(log => log.to)).toEqual(['debug'])
    expect(seen.logs[0]?.text).toMatch(logged)
  })
}

test('a call that never answers gives up after 5 seconds and shows nothing', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { call: 'hangs' })

  // The session's start waits 3 seconds for the first check, then goes on.
  const starting = $.session.start(INTERACTIVE)
  await clock.advance(3_000)
  await starting
  await clock.advance(2_000)

  expect(seen.toasts).toEqual([])
  expect(seen.logs.map(log => log.to)).toEqual(['debug'])
})

test('several thank-yous show one at a time, oldest first, each 8 seconds after the one before', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    reply: JSON.stringify({
      thankYous: [
        thankYou({ fixDescription: 'First fix' }),
        thankYou({ fixDescription: 'Second fix' }),
        thankYou({ fixDescription: 'Third fix' }),
        thankYou({ fixDescription: 'Fourth fix' }),
      ],
    }),
  })
  const shown = () => seen.toasts.map(toast => toast.text.replace('High-five from a teammate · for your fix: ', ''))

  await $.session.start(INTERACTIVE)
  await clock.settle()
  expect(shown()).toEqual(['First fix'])

  await clock.advance(7_999)
  expect(shown()).toEqual(['First fix'])
  await clock.advance(1)
  expect(shown()).toEqual(['First fix', 'Second fix'])
  await clock.advance(16_000)
  expect(shown()).toEqual(['First fix', 'Second fix', 'Third fix', 'Fourth fix'])
  expect(seen.toasts.every(toast => toast.timeoutMs === 8000)).toBe(true)
  expect(seen.checks.length).toBe(1)
})

test('a thank-you sent mid-session shows at the next check, 15 minutes on', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()
  seen.reply = JSON.stringify({ thankYous: [thankYou()] })
  await clock.advance(FIFTEEN_MINUTES)

  expect(seen.checks.length).toBe(2)
  expect(seen.toasts.length).toBe(1)
})

test('the end of a main-loop turn checks; a subagent turn does not', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()
  seen.reply = JSON.stringify({ thankYous: [thankYou()] })
  await $.turn.complete({ ...ANSWERED, agentId: 'a1' })
  await clock.settle()
  expect(seen.checks.length).toBe(1)

  await $.turn.complete(ANSWERED)
  await clock.settle()
  expect(seen.checks.length).toBe(2)
  expect(seen.toasts.length).toBe(1)
})

test('a turn in a session with no surface to draw on does not check', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { isHeadless: true })

  await $.session.start(HEADLESS)
  await $.turn.complete(ANSWERED)
  await clock.advance(FIFTEEN_MINUTES)

  expect(seen.checks).toEqual([])
})

test('running /quotient:list-fixes checks again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()
  seen.reply = JSON.stringify({ thankYous: [thankYou()] })
  await $.command.run({
    command: 'quotient:list-fixes',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.settle()

  expect(seen.checks.length).toBe(2)
  expect(seen.toasts.length).toBe(1)
})

test('a check does not start while one is still running', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { call: 'hangs' })

  const starting = $.session.start(INTERACTIVE)
  await clock.advance(3_000)
  await starting
  await $.turn.complete(ANSWERED)
  await clock.settle()
  expect(seen.checks.length).toBe(1)

  await clock.advance(2_000)
  await $.turn.complete(ANSWERED)
  await clock.settle()
  expect(seen.checks.length).toBe(2)
})

test('a reply that comes after the 5-second wait is still shown, since the check already marked it delivered', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { reply: JSON.stringify({ thankYous: [thankYou()] }), wait: { clock, ms: 6_000 } })

  const starting = $.session.start(INTERACTIVE)
  await clock.advance(3_000)
  await starting
  await clock.advance(2_000)
  expect(seen.toasts).toEqual([])

  await clock.advance(1_000)
  expect(seen.toasts.length).toBe(1)
  expect(seen.logs.map(log => log.to)).toEqual(['debug'])
})
