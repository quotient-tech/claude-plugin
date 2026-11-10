import { expect, test } from 'claude-code/testing'

import { callFailure, errorText } from '../hooks/state'

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
