import { expect, test } from 'claude-code/testing'

import { callFailure, errorText, readTrialEnded } from '../hooks/state'

/**
 * An error shaped as Claude Code 2.1.296 and 2.1.317 reject `$.mcp.call`
 * with: a plain Error named HooksError, its message the only detail.
 *
 * @param message - The rejection's message
 * @returns The error
 */
function hooksError(message: string): Error {
  const error = new Error(message)
  error.name = 'HooksError'
  return error
}

const SERVER = 'plugin:quotient:agex'

test('a call auto mode refused is denied', () => {
  const error = hooksError(
    `quotient: $.mcp.call(${SERVER}, list_my_frictions) refused: The server-side auto mode classifier gave no verdict for mcp__plugin_quotient_agex__list_my_frictions: the request that produced this action did not ask for one.`,
  )
  expect(callFailure(error)).toBe('denied')
})

test('a call nobody could approve is denied', () => {
  const error = hooksError(
    `quotient: $.mcp.call(${SERVER}, record_usage) refused: Claude requested permissions to use mcp__plugin_quotient_agex__record_usage, but you haven't granted it yet.`,
  )
  expect(callFailure(error)).toBe('denied')
})

test("a call another plugin's hook refused is denied", () => {
  const error = hooksError(
    `quotient: $.mcp.call(quotient-local, claim_daily_run) refused: Permission to use mcp__quotient-local__claim_daily_run denied by plugins sec: no`,
  )
  expect(callFailure(error)).toBe('denied')
})

test('a call to a tool or server that is not connected failed', () => {
  const error = hooksError(`quotient: $.mcp.call: no connected MCP tool "list_my_frictions" on a server named "${SERVER}"`)
  expect(callFailure(error)).toBe('failed')
})

test('"refused" anywhere but the engine\'s own wording is not a denial', () => {
  expect(callFailure(new Error('Quotient refused: rate limited'))).toBe('failed')
  expect(callFailure(new Error('fetch failed (refused: ECONNREFUSED)'))).toBe('failed')
})

test('a thrown value that is not an Error failed', () => {
  expect(callFailure('refused')).toBe('failed')
  expect(callFailure(undefined)).toBe('failed')
  expect(callFailure({ message: 7 })).toBe('failed')
})

test("errorText keeps an Error's name and message on one line", () => {
  expect(errorText(hooksError('quotient: $.mcp.call: no connected\nMCP tool'))).toBe(
    'HooksError: quotient: $.mcp.call: no connected MCP tool',
  )
})

for (const [what, message, expected] of [
  ['an authorization header with a bearer token', 'HTTP 401: Authorization: Bearer abc.def-ghi', 'HooksError: HTTP 401: Authorization: [redacted]'],
  ['an authorization header with another scheme', 'HTTP 401: Authorization: Token opaque value', 'HooksError: HTTP 401: Authorization: [redacted]'],
  ['a Digest authorization header', 'HTTP 401: Authorization: Digest username="bob", realm="q", nc=00000001, response="6629fae4"', 'HooksError: HTTP 401: Authorization: [redacted]'],
  ['an authorization header without a scheme', 'sent authorization: s3cr3t', 'HooksError: sent authorization: [redacted]'],
  ['a quoted authorization value', 'headers {"authorization": "Token opaque"}', 'HooksError: headers {"authorization": "[redacted]"}'],
  ['a bearer token on its own', 'sent Bearer abc.def-ghi twice', 'HooksError: sent Bearer [redacted] twice'],
  ['a bare JWT', 'refused eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln for this call', 'HooksError: refused [redacted] for this call'],
  ['an access token field', 'bad grant access_token=s3cr3t; retry', 'HooksError: bad grant access_token=[redacted]; retry'],
  ['a quoted access token field', 'body {"access_token":"opaque","expires":3600}', 'HooksError: body {"access_token":"[redacted]","expires":3600}'],
  ['a quoted password of several words', 'body {"password":"correct horse battery staple"}', 'HooksError: body {"password":"[redacted]"}'],
  ['a single-quoted secret of several words', "sent secret='two words' then", "HooksError: sent secret='[redacted]' then"],
  ['a quoted password with an escaped quote', 'body {"password":"abc\\"secret","next":1}', 'HooksError: body {"password":"[redacted]","next":1}'],
  ['a single-quoted secret with an escaped quote', "sent secret='it\\'s hidden' then", "HooksError: sent secret='[redacted]' then"],
  ['a client secret field', 'bad client client_secret=opaque&grant=x', 'HooksError: bad client client_secret=[redacted]&grant=x'],
  ['an API key field', 'x-api-key: k-123', 'HooksError: x-api-key: [redacted]'],
  ['an email with an accented letter', 'no Quotient user for josé@example.com here', 'HooksError: no Quotient user for [email] here'],
  ['an email', 'no Quotient user for op.name+dev@example.co.uk here', 'HooksError: no Quotient user for [email] here'],
] as const) {
  test(`errorText never puts ${what} in the debug log`, () => {
    expect(errorText(hooksError(message))).toBe(expected)
  })
}

test('errorText leaves an error with no secret in it unchanged', () => {
  expect(errorText(hooksError('$.mcp.call(agex, list_my_frictions) refused: the sign-in token expired'))).toBe(
    'HooksError: $.mcp.call(agex, list_my_frictions) refused: the sign-in token expired',
  )
})

test('errorText reads any thrown value without throwing', () => {
  expect(errorText('plain text')).toBe('plain text')
  expect(errorText(undefined)).toBe('undefined')
  expect(errorText({ toString: () => { throw new Error('no') } })).toBe('an unreadable error')
})

const ENDED = "Your company's Quotient free trial has ended, so the plugin has stopped working."

/**
 * A tool reply with one text block.
 *
 * @param text - The block's text
 * @param isError - Whether the server reported the call as failed
 * @returns The reply
 */
function textReply(text: string, isError = true) {
  return { content: [{ type: 'text' as const, text }], isError }
}

test("an admin's trial-ended refusal gives the billing link", () => {
  const result = textReply(`${ENDED} Upgrade your plan to use it again: https://app.getquotient.com/billing`)
  expect(readTrialEnded(result)).toEqual({ isAdmin: true, billingUrl: 'https://app.getquotient.com/billing' })
})

test("a non-admin's trial-ended refusal gives no billing link", () => {
  const result = textReply(`${ENDED} Ask a Quotient admin at your company to upgrade its plan.`)
  expect(readTrialEnded(result)).toEqual({ isAdmin: false, billingUrl: null })
})

test("a billing link over plain http is not taken, and the refusal is still an admin's", () => {
  const result = textReply(`${ENDED} Upgrade your plan to use it again: http://app.getquotient.com/billing`)
  expect(readTrialEnded(result)).toEqual({ isAdmin: true, billingUrl: null })
})

test('a link to any page but billing is not taken', () => {
  const result = textReply(`${ENDED} Upgrade your plan to use it again: https://app.getquotient.com/frictions`)
  expect(readTrialEnded(result)).toEqual({ isAdmin: true, billingUrl: null })
})

test('a malformed link is not taken', () => {
  const result = textReply(`${ENDED} Upgrade your plan to use it again: https://`)
  expect(readTrialEnded(result)).toEqual({ isAdmin: true, billingUrl: null })
})

test('a successful reply that starts with the same words is not a trial end', () => {
  expect(readTrialEnded(textReply(ENDED, false))).toBeNull()
})

test('another refusal is not a trial end', () => {
  expect(readTrialEnded(textReply('Only a manager or engineer on a team in Quotient can share frictions.'))).toBeNull()
})

test('a refusal with no text is not a trial end', () => {
  expect(readTrialEnded({ content: [], isError: true })).toBeNull()
})

test('the trial-ended words anywhere but the start are not a trial end', () => {
  expect(readTrialEnded(textReply(`None of these frictions was recorded. ${ENDED}`))).toBeNull()
})

test("a billing link on Quotient's dev host is taken", () => {
  const result = textReply(`${ENDED} Upgrade your plan to use it again: https://dev.getquotient.com/billing`)
  expect(readTrialEnded(result)).toEqual({ isAdmin: true, billingUrl: 'https://dev.getquotient.com/billing' })
})

test("a billing link on any host outside Quotient's domain is not taken", () => {
  for (const url of [
    'https://evil.example/billing',
    'https://getquotient.com.evil.example/billing',
    'https://evilgetquotient.com/billing',
  ]) {
    expect(readTrialEnded(textReply(`${ENDED} Upgrade your plan to use it again: ${url}`))).toEqual({ isAdmin: true, billingUrl: null })
  }
})

test("a billing link on this machine is taken, so a local Quotient's admin gets one", () => {
  for (const url of ['http://localhost:3000/billing', 'http://127.0.0.1:3000/billing', 'https://localhost/billing']) {
    expect(readTrialEnded(textReply(`${ENDED} Upgrade your plan to use it again: ${url}`))).toEqual({ isAdmin: true, billingUrl: url })
  }
})

test('a host that only starts like this machine is not taken', () => {
  const result = textReply(`${ENDED} Upgrade your plan to use it again: http://localhost.evil.example/billing`)
  expect(readTrialEnded(result)).toEqual({ isAdmin: true, billingUrl: null })
})

test("a trial end that ends in neither way is not an admin's", () => {
  expect(readTrialEnded(textReply(ENDED))).toEqual({ isAdmin: false, billingUrl: null })
})
