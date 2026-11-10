import { expect, test } from 'claude-code/testing'

import { usageRows } from '../hooks/usageRows'
import type { UsageRow } from '../hooks/usageRows'
import { TRANSCRIPTS } from './fixtures/transcripts'

const DAY0 = '2026-10-01'
const DAY1 = '2026-10-02'
const NOW = Date.parse(`${DAY1}T12:00:00.000Z`)

const FILES = Object.entries(TRANSCRIPTS).map(([path, text]) => ({
  path,
  text: text.replaceAll('__DAY0__', DAY0).replaceAll('__DAY1__', DAY1),
}))

const FIELDS = [
  'cacheCreationTokens',
  'cacheReadTokens',
  'inputTokens',
  'invocationId',
  'isSubagent',
  'model',
  'occurredAt',
  'outputTokens',
  'requestId',
  'sessionId',
  'skill',
]

/**
 * Builds an expected row, filling in the fields most rows share.
 *
 * @param fields - The row's own fields
 * @returns The row
 */
function row(fields: Partial<UsageRow>): UsageRow {
  return { sessionId: 's1', invocationId: null, isSubagent: false, ...fields } as UsageRow
}

// `origin` and `pluginVersion` are left out: the mod sets those itself.
const EXPECTED: UsageRow[] = [
  row({
    requestId: 'req-a',
    invocationId: 'inv-slash',
    occurredAt: `${DAY0}T10:00:05.000Z`,
    skill: 'quotient:list-frictions',
    model: 'claude-haiku-5-5',
    inputTokens: 2,
    cacheCreationTokens: 100,
    cacheReadTokens: 1000,
    outputTokens: 10,
  }),
  row({
    requestId: 'req-f',
    invocationId: 'inv-slash',
    occurredAt: `${DAY0}T10:00:30.000Z`,
    skill: 'quotient:list-frictions',
    model: 'claude-haiku-5-5',
    isSubagent: true,
    inputTokens: 4,
    cacheCreationTokens: 40,
    cacheReadTokens: 400,
    outputTokens: 4,
  }),
  row({
    requestId: 'req-d',
    invocationId: 'inv-tool',
    occurredAt: `${DAY0}T11:00:10.000Z`,
    skill: 'quotient:setup',
    model: 'claude-opus-5-5',
    inputTokens: 3,
    cacheCreationTokens: 200,
    cacheReadTokens: 2000,
    outputTokens: 20,
  }),
  row({
    requestId: 'req-e',
    occurredAt: `${DAY0}T12:00:00.000Z`,
    skill: 'quotient:fix-friction',
    model: 'claude-opus-5-5',
    inputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 5,
  }),
  row({
    requestId: 'req-h',
    sessionId: 's3',
    invocationId: 'inv-bg',
    occurredAt: `${DAY0}T13:00:05.000Z`,
    skill: 'quotient:find-solutions',
    model: 'claude-haiku-5-5',
    inputTokens: 6,
    cacheCreationTokens: 60,
    cacheReadTokens: 600,
    outputTokens: 60,
  }),
  row({
    requestId: 'req-g',
    sessionId: 's2',
    invocationId: 'inv-mid',
    occurredAt: `${DAY1}T00:01:00.000Z`,
    skill: 'quotient:setup',
    model: 'claude-opus-5-5',
    inputTokens: 5,
    cacheCreationTokens: 50,
    cacheReadTokens: 500,
    outputTokens: 50,
  }),
]

test('keeps each quotient request once, with its invocation, subagents included', () => {
  expect(usageRows(FILES, NOW)).toEqual(EXPECTED)
})

test('a row carries only the request fields, never text, a path or file contents', () => {
  const rows = usageRows(FILES, NOW)
  for (const r of rows) expect(Object.keys(r).sort()).toEqual(FIELDS)
  const sent = JSON.stringify(rows)
  expect(sent.includes('Some response text')).toBe(false)
  expect(sent.includes('/Users/op')).toBe(false)
  expect(sent.includes('.jsonl')).toBe(false)
})

test('leaves out requests made more than 7 days before now', () => {
  const later = Date.parse(`${DAY1}T00:00:00.000Z`) + 7 * 86_400_000
  expect(usageRows(FILES, later).map((r) => r.requestId)).toEqual(['req-g'])
})
