import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { inviteReminderText, readInviteReminder } from '../hooks/invite-reminder'
import { statusLine } from '../hooks/state'
import { denial } from './fixtures/denial'

const SERVER = 'plugin:quotient:agex'
const INVITE_PAGE = 'https://app.getquotient.com/agent-experience/invite'
const REMINDER = 'invite a teammate · app.getquotient.com/agent-experience/invite'
const INTERACTIVE = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const HEADLESS = { cwd: '/data', surface: null, isInteractive: false } as const
const FIFTEEN_MINUTES = 15 * 60 * 1000

type On = Parameters<TestBody>[1]
type Connect =
  | { isConnected: true; server: string }
  | { isConnected: false; reason: 'unlisted' | 'auth' | 'failed'; message: string }

/**
 * The text of a `get_invite_link` reply.
 *
 * @param fields - The fields that differ from a reply asking for the reminder
 * @returns The reply's text
 */
function invite(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    companyName: 'Acme',
    inviteUrl: 'https://app.getquotient.com/join/JOIN2345',
    emailDomain: 'acme.com',
    memberCount: 1,
    maxSeats: 10,
    invitePageUrl: INVITE_PAGE,
    remindToInvite: true,
    ...fields,
  })
}

/**
 * A tool reply holding one text block.
 *
 * @param text - The text
 * @param isError - Whether the tool reported an error
 * @returns The reply
 */
function reply(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError }
}

test('the reminder names the Invite page by its host and path', () => {
  expect(inviteReminderText(INVITE_PAGE)).toBe(REMINDER)
  expect(inviteReminderText(null)).toBeNull()
})

test('the reminder shows under the frictions to fix and over the fixes implemented', () => {
  const toFix = '2 frictions to fix · run /list-fixes'
  expect(statusLine({ setup: null, frictionsToFix: toFix, inviteReminder: REMINDER, fixes: '1 fix implemented' })).toBe(toFix)
  expect(statusLine({ setup: null, frictionsToFix: null, inviteReminder: REMINDER, fixes: '1 fix implemented' })).toBe(REMINDER)
  expect(statusLine({ trialEnded: 'trial ended', setup: null, inviteReminder: REMINDER, fixes: null })).toBe('trial ended')
  // A value stored before the reminder part existed lacks it.
  expect(statusLine({ setup: null, frictionsToFix: null, fixes: '1 fix implemented' })).toBe('1 fix implemented')
})

test('a reply asking for the reminder gives the Invite page', () => {
  expect(readInviteReminder(reply(invite()))).toBe(INVITE_PAGE)
})

test('a reply not asking for it, from a server without the field, or a refusal means no reminder', () => {
  expect(readInviteReminder(reply(invite({ remindToInvite: false })))).toBeNull()
  expect(readInviteReminder(reply(invite({ remindToInvite: undefined, invitePageUrl: undefined })))).toBeNull()
  expect(readInviteReminder(reply("Your company doesn't have an AgEx invite link.", true))).toBeNull()
})

test('a reply asking for the reminder that is not the expected shape reads as unusable', () => {
  const cases = [
    reply('not json'),
    reply('null'),
    reply(invite({ remindToInvite: 'yes' })),
    reply(invite({ invitePageUrl: undefined })),
    reply(invite({ invitePageUrl: 'javascript:alert(1)' })),
    reply(invite({ invitePageUrl: 'https://app.getquotient.com/\x1b[31minvite' })),
    { content: [], isError: false },
  ]
  for (const result of cases) expect(readInviteReminder(result)).toBeUndefined()
})

/**
 * Answers the mod's calls the way the engine would, and records them.
 * `get_invite_link` answers with `invite`, which a test may change between
 * refreshes; every other Quotient tool answers as having nothing to do.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param opts.invite - The text `get_invite_link` replies with
 * @param opts.connect - What `$.mcp.connect("agex")` resolves to
 * @param opts.callFails - Whether every `get_invite_link` call rejects
 * @param opts.callDenied - The reason Claude Code denies every `get_invite_link` call with
 * @param opts.stored - The reminder part an earlier load of the mod stored
 * @param opts.wait - How long the first `get_invite_link` call takes to answer, on the test's clock
 * @returns What the mod called, showed and logged
 */
function engine(
  on: On,
  opts: {
    invite?: string
    connect?: Connect
    callFails?: boolean
    callDenied?: string
    stored?: string
    wait?: { clock: ReturnType<typeof mock.clock>; ms: number }
  } = {},
) {
  const seen = {
    invite: opts.invite ?? invite(),
    calls: [] as { server: string; args: Record<string, unknown> }[],
    status: [] as (string | undefined)[],
    logs: [] as { text: string; to: unknown }[],
  }
  mock.env(on, { HOME: '/home/op' })
  on('mcp.connect', () => ({ value: opts.connect ?? { isConnected: true, server: SERVER } }))
  on('mcp.call', async (_, e) => {
    if (e.tool === 'list_thank_yous') {
      return { value: { content: [{ type: 'text', text: '{"thankYous":[]}' }], isError: false } }
    }
    if (e.tool === 'list_my_frictions') {
      return { value: { content: [{ type: 'text', text: '{"frictions":[],"nextCursor":null}' }], isError: false } }
    }
    if (e.tool !== 'get_invite_link') {
      return { value: { content: [{ type: 'text', text: '{"due":false}' }], isError: false } }
    }
    seen.calls.push({ server: e.server, args: e.args })
    if (opts.wait !== undefined && seen.calls.length === 1) await opts.wait.clock.sleep(opts.wait.ms)
    if (opts.callFails) throw new Error('call failed')
    if (opts.callDenied !== undefined) return { deny: opts.callDenied }
    return { value: { content: [{ type: 'text', text: seen.invite }], isError: false } }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    seen.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  if (opts.stored !== undefined) {
    // What the earlier load stored outlives the reload; this stands for the
    // engine's store of that one value, versions included.
    let stored = { value: { setup: null, inviteReminder: opts.stored, fixes: null } as unknown, version: 1 }
    on('state.get', (_, e, next) => (e.key === 'statusParts' ? { value: stored } : next(e)))
    on('state.set', (_, e, next) => {
      if (e.key !== 'statusParts') return next(e)
      if (e.ifVersion !== undefined && e.ifVersion !== stored.version) {
        return { value: { isSet: false, version: stored.version } }
      }
      stored = { value: e.value, version: stored.version + 1 }
      return { value: { isSet: true, version: stored.version } }
    })
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quotient__${e.name}` } }))
  return seen
}

test('an interactive session shows the reminder when Quotient says it is due', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.calls).toEqual([{ server: SERVER, args: {} }])
  expect(seen.status).toEqual([REMINDER])
})

test('no reminder due leaves the entry cleared, without a status call', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { invite: invite({ remindToInvite: false }) })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.status).toEqual([])
  expect(seen.logs.filter(log => log.text.includes('invite reminder'))).toEqual([])
})

test('a server without the field shows nothing and logs nothing', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { invite: invite({ remindToInvite: undefined, invitePageUrl: undefined }) })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.status).toEqual([])
  expect(seen.logs.filter(log => log.text.includes('invite reminder'))).toEqual([])
})

const FAILED_READS: [string, { callFails?: boolean; invite?: string; callDenied?: string }][] = [
  ['the call rejects', { callFails: true }],
  ['the reply is malformed', { invite: 'not json' }],
  ['the Invite page is not a web address', { invite: invite({ invitePageUrl: 'file:///etc/passwd' }) }],
  ['Claude Code denied the call', { callDenied: denial(SERVER, 'get_invite_link') }],
]
for (const [why, opts] of FAILED_READS) {
  test(`a failed read shows nothing and only logs to the debug log: ${why}`, async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, opts)

    await $.session.start(INTERACTIVE)
    await clock.settle()

    expect(seen.status).toEqual([])
    const logs = seen.logs.filter(log => log.text.includes('invite reminder'))
    expect(logs).not.toEqual([])
    expect(logs.every(log => log.to === 'debug')).toBe(true)
  })
}

test('the reminder clears at the next refresh once someone joins', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()
  seen.invite = invite({ remindToInvite: false, memberCount: 2 })
  await clock.advance(FIFTEEN_MINUTES)

  expect(seen.status).toEqual([REMINDER, undefined])
})

test('a reminder that stays due does not set the entry again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()
  await clock.advance(FIFTEEN_MINUTES)

  expect(seen.calls.length).toBe(2)
  expect(seen.status).toEqual([REMINDER])
})

test('not signed in never reads the invite link', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { connect: { isConnected: false, reason: 'auth', message: 'sign in' } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.calls).toEqual([])
  expect(seen.status).toEqual([])
})

test('a headless session never reads the invite link', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(HEADLESS)
  await clock.advance(FIFTEEN_MINUTES)

  expect(seen.calls).toEqual([])
  expect(seen.status).toEqual([])
})

test('after a reload, the stored reminder is drawn again even when the read finds the same one', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { stored: REMINDER })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.status).toEqual([REMINDER])
})

test('a read that hangs neither holds the start past 2 seconds nor stops the next refresh showing the reminder', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { wait: { clock, ms: 60_000 } })
  let isStarted = false

  const starting = $.session.start(INTERACTIVE).then(started => {
    isStarted = true
    return started
  })
  await clock.advance(2_000)
  expect(await starting).toEqual({ cwd: '/repo' })
  expect(isStarted).toBe(true)

  await clock.advance(2_999)
  expect(seen.logs.filter(log => log.text.includes('invite reminder'))).toEqual([])
  await clock.advance(1)
  expect(seen.status).toEqual([])
  expect(seen.logs.filter(log => log.text.includes('invite reminder'))).toEqual([
    { text: 'quotient invite reminder: get_invite_link gave no usable reply', to: 'debug' },
  ])

  await clock.advance(FIFTEEN_MINUTES)
  expect(seen.calls.length).toBe(2)
  expect(seen.status).toEqual([REMINDER])
})
