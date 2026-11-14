import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { denial } from './fixtures/denial'
import { TRANSCRIPTS } from './fixtures/transcripts'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const HOME = '/home/op'
const ROOT = '/Users/op/work'
const PROJECT = `${HOME}/.claude/projects/-Users-op-work`
const MAIN = `${PROJECT}/s1.jsonl`
const SUBAGENT = `${PROJECT}/s1/subagents/agent-x.jsonl`
const SERVER = 'plugin:quotient:agex'
const VERSION = '9.9.9'
const MAX_READ_BYTES = 4 * 1024 * 1024

// The fixtures' days are placeholders, so their requests fall inside the
// 7 days the mod sends: __DAY0__ is yesterday and __DAY1__ today, both UTC.
const DAY0 = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const DAY1 = new Date().toISOString().slice(0, 10)

const FIELDS = [
  'cacheCreationTokens',
  'cacheReadTokens',
  'inputTokens',
  'invocationId',
  'isSubagent',
  'model',
  'occurredAt',
  'origin',
  'outputTokens',
  'pluginVersion',
  'requestId',
  'sessionId',
  'skill',
]

/**
 * A fixture transcript with its days filled in.
 *
 * @param name - The fixture's path
 * @returns Its text
 */
function fixture(name: string): string {
  return TRANSCRIPTS[name]!.replaceAll('__DAY0__', DAY0).replaceAll('__DAY1__', DAY1)
}

/**
 * One transcript line for a request a quotient skill made.
 *
 * @param requestId - The request's id
 * @returns The line, ending in a newline
 */
function requestLine(requestId: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: `u-${requestId}`,
      sessionId: 's1',
      timestamp: `${DAY1}T00:30:00.000Z`,
      requestId,
      attributionPlugin: 'quotient',
      attributionSkill: 'quotient:setup',
      message: { model: 'claude-opus-5-5', content: [], usage: { output_tokens: 1 } },
    }) + '\n'
  )
}

type Reply = 'ok' | 'error' | 'rejects' | 'denied' | 'hangs' | 'no counts'

/**
 * Answers the mod's calls the way the engine would, from files held in
 * memory, and records what it sends.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param opts.files - Each file's text by its path
 * @param opts.sizes - A file's size, where it differs from its text's length
 * @param opts.env - The environment variables that are set
 * @param opts.replies - How each `record_usage` call is answered in turn; the last repeats
 * @param opts.isHeadless - Whether the session draws on no surface, as a `claude -p` run doesn't
 * @param opts.unreadable - Files listed and sized as usual that a read refuses
 * @param opts.timesOut - Whether the mod's wait on a call ends at once; otherwise it never does
 * @param opts.root - The session's root, where it isn't ROOT
 * @returns The files, which a test may change, what the mod read, sent and logged, and
 *   how many reads of frictions the fix-status part made
 */
function engine(
  on: On,
  opts: {
    files?: Record<string, string>
    sizes?: Record<string, number>
    env?: Record<string, string>
    replies?: Reply[]
    isHeadless?: boolean
    unreadable?: string[]
    timesOut?: boolean
    root?: string
  } = {},
) {
  const files: Record<string, string> = opts.files ?? { [MAIN]: fixture('-Users-op-work/s1.jsonl'), [SUBAGENT]: fixture('-Users-op-work/s1/subagents/agent-x.jsonl') }
  const seen = {
    files,
    reads: [] as string[],
    connected: [] as string[],
    fixReads: 0,
    thankYouChecks: 0,
    batches: [] as Record<string, unknown>[][],
    logs: [] as { text: string; to: unknown }[],
  }
  on('ui.log', (_, e) => {
    seen.logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'quotient', version: VERSION }) }
    seen.reads.push(e.path)
    if (opts.unreadable?.includes(e.path)) throw new Error(`EACCES: ${e.path}`)
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: opts.sizes?.[e.path] ?? text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    const prefix = `${e.path}/`
    const names = Object.keys(files)
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(path => path.slice(prefix.length))
    if (names.length === 0) throw new Error(`ENOENT: ${e.path}`)
    return {
      value: names.map(name => ({
        name,
        kind: 'file' as const,
        size: opts.sizes?.[prefix + name] ?? files[prefix + name]!.length,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('clock.sleep', () => (opts.timesOut ? { value: undefined } : new Promise(() => {})))
  on('session.surfaces', () => ({ value: opts.isHeadless ? [] : ['terminal'] }))
  on('session.root', () => ({ value: opts.root ?? ROOT }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_, e) => ({ value: { HOME, ...opts.env }[e.name] }))
  on('mcp.connect', (_, e) => {
    seen.connected.push(e.server)
    return { value: { isConnected: true, server: SERVER } }
  })
  on('mcp.call', (_, e) => {
    // The fix-status part reads the operator's frictions, and the thank-yous
    // check runs, on their own; both are counted apart, so these tests see
    // only the usage sends.
    if (e.tool === 'list_my_frictions') {
      seen.fixReads += 1
      return { value: { content: [{ type: 'text', text: '{"frictions":[],"nextCursor":null}' }], isError: false } }
    }
    if (e.tool === 'list_thank_yous') {
      seen.thankYouChecks += 1
      return { value: { content: [{ type: 'text', text: '{"thankYous":[]}' }], isError: false } }
    }
    if (e.server !== SERVER || e.tool !== 'record_usage') throw new Error(`unexpected call: ${e.server} ${e.tool}`)
    const requests = (e.args as { requests: Record<string, unknown>[] }).requests
    seen.batches.push(requests)
    const replies = opts.replies ?? ['ok']
    const reply = replies[Math.min(seen.batches.length, replies.length) - 1]
    if (reply === 'rejects') throw new Error('call failed')
    if (reply === 'denied') return { deny: denial(e.server, e.tool) }
    if (reply === 'hangs') return new Promise(() => {})
    const text =
      reply === 'no counts'
        ? JSON.stringify({ storedCount: String(requests.length) })
        : JSON.stringify({ storedCount: requests.length, duplicateCount: 0 })
    return { value: { content: [{ type: 'text', text }], isError: reply === 'error' } }
  })
  return seen
}

/**
 * Ends a turn of session s1.
 *
 * @param $ - The engine
 * @param turn.reason - Why the turn ended; answered by default
 * @param turn.agentId - The subagent whose turn it was, if not the main loop's
 */
async function endTurn($: Engine, turn: { reason?: 'answer' | 'aborted'; agentId?: string } = {}): Promise<void> {
  const reason = turn.reason ?? 'answer'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason, agentId: turn.agentId })
}

// How many promise callbacks the waits below let run: far more than one send
// takes, since the test's hooks answer every call at once.
const MAX_TICKS = 10_000

/**
 * Waits until a condition holds, for the work the mod starts and doesn't
 * wait for.
 *
 * @param condition - What to wait for
 * @throws When it still doesn't hold once the pending work has had its turn
 */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < MAX_TICKS && !condition(); i++) await Promise.resolve()
  if (!condition()) throw new Error('timed out')
}

/**
 * Lets the mod's unawaited work run to its end.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < MAX_TICKS; i++) await Promise.resolve()
}

/**
 * The request ids of each batch the mod sent.
 *
 * @param seen - What the mod sent
 * @returns One list of ids per batch
 */
function ids(seen: ReturnType<typeof engine>): string[][] {
  return seen.batches.map(batch => batch.map(row => row.requestId as string))
}

test("a turn sends the session's quotient requests, subagents included, with only the API's fields", async ($, on) => {
  const seen = engine(on)
  await endTurn($)
  await until(() => seen.batches.length === 1)

  expect(ids(seen)).toEqual([['req-a', 'req-f', 'req-d', 'req-e']])
  for (const row of seen.batches[0]!) {
    expect(Object.keys(row).sort()).toEqual(FIELDS)
    expect(row).toMatchObject({ origin: 'interactive', pluginVersion: VERSION })
  }
  expect(seen.batches[0]![1]).toMatchObject({ requestId: 'req-f', isSubagent: true, invocationId: 'inv-slash' })
})

test('a second turn sends only new requests', async ($, on) => {
  const seen = engine(on)
  await endTurn($)
  await until(() => seen.batches.length === 1)
  await settle()

  seen.files[MAIN] += requestLine('req-new')
  await endTurn($)
  await until(() => seen.batches.length === 2)

  expect(ids(seen)[1]).toEqual(['req-new'])
})

for (const [reply, how] of [
  ['error', 'reports an error'],
  ['rejects', 'rejects'],
  ['denied', 'Claude Code denied'],
  ['no counts', 'replies without the counts'],
] as const) {
  test(`a call that ${how} is retried on the next turn`, async ($, on) => {
    const seen = engine(on, { replies: [reply, 'ok'] })
    await endTurn($)
    await until(() => seen.batches.length === 1)
    await settle()

    await endTurn($)
    await until(() => seen.batches.length === 2)

    expect(ids(seen)[1]).toEqual(['req-a', 'req-f', 'req-d', 'req-e'])
  })
}

for (const [reply, how, line] of [
  ['denied', 'Claude Code denied', 'quotient usage: record_usage denied: '],
  ['rejects', 'that rejects otherwise', 'quotient usage: record_usage failed: '],
  ['error', 'that reports an error', 'quotient usage: record_usage gave no usable reply'],
] as const) {
  test(`a send ${how} goes to the debug log only, with why`, async ($, on) => {
    const seen = engine(on, { replies: [reply] })
    await endTurn($)
    await until(() => seen.logs.length > 0)

    expect(seen.logs.map(log => log.to)).toEqual(['debug'])
    expect(seen.logs[0]?.text.startsWith(line)).toBe(true)
  })
}

test('a session with no quotient skill sends nothing and connects to no server', async ($, on) => {
  const plain = fixture('-Users-op-work/s1.jsonl')
    .split('\n')
    .filter(line => !line.includes('"attributionPlugin": "quotient"'))
    .join('\n')
  const seen = engine(on, { files: { [MAIN]: plain } })
  await endTurn($)
  await until(() => seen.reads.includes(MAIN))
  await settle()

  // Each connect left was the fix-status part's or the thank-yous check's own.
  expect(seen.connected.length).toBe(seen.fixReads + seen.thankYouChecks)
  expect(seen.batches).toEqual([])
})

for (const [turn, which] of [
  [{ reason: 'aborted' }, 'an interrupted turn'],
  [{ agentId: 'agent-x' }, "a subagent's turn"],
] as const) {
  test(`${which} sends nothing and reads no transcript`, async ($, on) => {
    const seen = engine(on)
    await endTurn($, turn)
    await settle()

    expect(seen.reads).toEqual([])
    expect(seen.batches).toEqual([])
  })
}

test('QUOTIENT_USAGE=off sends nothing and reads no transcript', async ($, on) => {
  const seen = engine(on, { env: { QUOTIENT_USAGE: 'off' } })
  await endTurn($)
  await settle()

  expect(seen.reads).toEqual([])
  expect(seen.batches).toEqual([])
})

test('a daily run sends its requests as background', async ($, on) => {
  const seen = engine(on, { env: { QUOTIENT_DAILY_RUN: '1' } })
  await endTurn($)
  await until(() => seen.batches.length === 1)

  expect(seen.batches[0]!.map(row => row.origin)).toEqual(['background', 'background', 'background', 'background'])
})

test('a transcript over 4 MiB is skipped, and the others are still sent', async ($, on) => {
  const seen = engine(on, { sizes: { [MAIN]: MAX_READ_BYTES + 1 } })
  await endTurn($)
  await until(() => seen.batches.length === 1)

  expect(seen.reads).toEqual([SUBAGENT])
  expect(ids(seen)).toEqual([['req-f']])
})

test("a transcript that can't be read is skipped, and the others are still sent", async ($, on) => {
  const seen = engine(on, { unreadable: [SUBAGENT] })
  await endTurn($)
  await until(() => seen.batches.length === 1)

  expect(ids(seen)).toEqual([['req-a', 'req-d', 'req-e']])
})

test('more than 500 new requests go out in batches of 500', async ($, on) => {
  const many = Array.from({ length: 501 }, (_, i) => requestLine(`req-many-${i}`)).join('')
  const seen = engine(on, { files: { [MAIN]: many } })
  await endTurn($)
  await until(() => seen.batches.length === 2)

  expect(seen.batches.map(batch => batch.length)).toEqual([500, 1])
})

test('a claude -p run ends its turn only once the send is done, before the process exits', async ($, on) => {
  const seen = engine(on, { isHeadless: true })
  await endTurn($)

  expect(ids(seen)).toEqual([['req-a', 'req-f', 'req-d', 'req-e']])
})

test('a call that takes too long counts as failed: a claude -p run still ends, and the next turn retries', async ($, on) => {
  const seen = engine(on, { isHeadless: true, replies: ['hangs', 'ok'], timesOut: true })
  await endTurn($)
  expect(seen.batches.length).toBe(1)

  await endTurn($)
  expect(ids(seen)[1]).toEqual(['req-a', 'req-f', 'req-d', 'req-e'])
})

test("a root with characters other than letters and digits names its project folder with a '-' for each", async ($, on) => {
  const project = `${HOME}/.claude/projects/-Users-op-my-repo-v2`
  const seen = engine(on, {
    root: '/Users/op/my_repo.v2',
    files: { [`${project}/s1.jsonl`]: fixture('-Users-op-work/s1.jsonl'), [`${project}/s1/subagents/agent-x.jsonl`]: fixture('-Users-op-work/s1/subagents/agent-x.jsonl') },
  })
  await endTurn($)
  await until(() => seen.batches.length === 1)

  expect(ids(seen)).toEqual([['req-a', 'req-f', 'req-d', 'req-e']])
})

test('transcripts are read from CLAUDE_CONFIG_DIR when it is set', async ($, on) => {
  const project = '/cfg/projects/-Users-op-work'
  const seen = engine(on, {
    env: { CLAUDE_CONFIG_DIR: '/cfg' },
    files: { [`${project}/s1.jsonl`]: fixture('-Users-op-work/s1.jsonl'), [`${project}/s1/subagents/agent-x.jsonl`]: fixture('-Users-op-work/s1/subagents/agent-x.jsonl') },
  })
  await endTurn($)
  await until(() => seen.batches.length === 1)

  expect(ids(seen)).toEqual([['req-a', 'req-f', 'req-d', 'req-e']])
})

test('an interactive turn ends without waiting for the send', async ($, on) => {
  const seen = engine(on, { replies: ['hangs'] })
  await endTurn($)

  await until(() => seen.batches.length === 1)
})
