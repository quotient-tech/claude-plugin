import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const CONFIG = '/home/op/.claude'
const PROJECTS = `${CONFIG}/projects`
const SESSIONS_TOOL = 'mcp__quotient__review_sessions'
const SINCE = '2026-11-05T10:00:00Z'
const THIS_SESSION = 'this-session'
// Ten sessions in two repos, beside ones the review leaves out.
const REPO_A = Array.from({ length: 6 }, (_, i) => `${PROJECTS}/-repo-a/a${i}.jsonl`)
const REPO_B = Array.from({ length: 4 }, (_, i) => `${PROJECTS}/-repo-b/b${i}.jsonl`)
const QUOTIENT_STARTED = [`${PROJECTS}/-repo-a/setup.jsonl`]
const TEMP = `${PROJECTS}/-private-tmp-claude-501-scratchpad-probe/p.jsonl`
const DAILY = `${PROJECTS}/-home-op--local-share-quotient/d.jsonl`
const OWN = `${PROJECTS}/-repo-a/${THIS_SESSION}.jsonl`
const HOLDS_FIXES = `${PROJECTS}/-repo-b/fixes.jsonl`
const TRANSCRIPTS = [...REPO_A, ...REPO_B, ...QUOTIENT_STARTED, TEMP, DAILY, OWN, HOLDS_FIXES]
const TYPED_REVIEW = {
  command: 'quotient:review-frictions',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

/**
 * Stands in for Claude Code around the hooks: the operator's folders, the
 * transcripts `find` lists, and the commands quotient runs on them.
 *
 * @param on - Adds the engine's handlers
 * @param opts - What the engine answers with
 * @param opts.transcripts - What `find` lists, oldest first
 * @param opts.teammateFiles - The transcripts that hold teammates' fixes
 * @param opts.teammateGrepFails - Whether the search for teammates' fixes fails
 * @param opts.env - Extra environment variables
 * @param opts.contents - Each transcript's text, by its path
 * @param opts.laterTeammateFiles - The transcripts that hold teammates' fixes by the time one is read
 * @param opts.modified - When each transcript was last modified, by its path; a day after SINCE when not given
 * @returns The tools registered and the commands run
 */
function engine(
  on: On,
  opts: {
    transcripts?: string[]
    teammateFiles?: string[]
    teammateGrepFails?: boolean
    env?: Record<string, string>
    contents?: Record<string, string>
    laterTeammateFiles?: string[]
    modified?: Record<string, string>
  } = {},
) {
  const seen = { tools: [] as { name: string; isDeferred?: unknown }[], argv: [] as (readonly string[])[] }
  mock.env(on, { HOME: '/home/op', ...opts.env })
  on('session.id', () => ({ value: THIS_SESSION }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('command.run', () => ({ text: 'the review skill ran' }))
  on('tool.register', (_, e) => {
    seen.tools.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__quotient__${e.name}` } }
  })
  on('tool.call', () => ({ result: 'ran' }))
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: 1, isLink: false, realPath: e.path, mtimeMs: Date.parse(opts.modified?.[e.path] ?? '2026-11-06T10:00:00Z') },
  }))
  on('process.run', (_, e) => {
    seen.argv.push(e.argv)
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const files = opts.transcripts ?? TRANSCRIPTS
    if (e.argv[0] === 'find') return answer(files.join('\n') + '\n')
    if (e.argv[0] === 'awk') return answer(QUOTIENT_STARTED.filter(file => e.argv.includes(file)).join('\n') + '\n')
    // Newest first: the reverse of the order find gave.
    if (e.argv[0] === 'ls') return answer([...e.argv.filter(arg => arg.startsWith('/'))].reverse().join('\n') + '\n')
    if (e.argv[0] === 'sed') {
      const [from, to] = (e.argv[2] ?? '').replace('p', '').split(',').map(Number) as [number, number]
      const lines = (opts.contents?.[e.argv[3] ?? ''] ?? '').split('\n').filter(line => line !== '').slice(from - 1, to)
      return answer(lines.map(line => `${line}\n`).join(''))
    }
    if (e.argv[0] === 'grep' && e.argv.includes('-q')) {
      if (opts.teammateGrepFails) return answer('', 2)
      return answer('', (opts.laterTeammateFiles ?? []).includes(e.argv.at(-1) ?? '') ? 0 : 1)
    }
    if (e.argv[0] === 'grep') {
      if (opts.teammateGrepFails) return answer('', 2)
      const held = (opts.teammateFiles ?? [HOLDS_FIXES]).filter(file => e.argv.includes(file))
      return answer(held.length === 0 ? '' : held.join('\n') + '\n', held.length === 0 ? 1 : 0)
    }
    return answer(`${CONFIG}\n/home/op\n/home/op/.local/share/quotient\n`)
  })
  return seen
}

/**
 * Calls one of the plugin's tools as the model would.
 *
 * @param $ - The engine
 * @param tool - The tool's full name
 * @param input - The tool's input
 * @returns What the call resolved to
 */
function callTool($: Engine, tool: string, input: Record<string, unknown>) {
  return $.tool.call({ tool, tool_use_id: 'toolu_1', ...input } as unknown as Parameters<typeof $.tool.call>[0])
}

test('the session registers review_sessions in the tool list', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.tools).toContainEqual({ name: 'review_sessions', isDeferred: false })
})

test('review_sessions refuses outside a review-frictions run', async ($, on) => {
  engine(on)
  const called = await callTool($, SESSIONS_TOOL, { since: SINCE })
  expect(called.deny).toContain('/quotient:review-frictions')
})

test('an operator-started review lists the sessions after its last review, by folder, leaving out what it skips', async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED_REVIEW)

  const called = await callTool($, SESSIONS_TOOL, { since: SINCE })

  expect(called.deny).toBeUndefined()
  const text = String(called.result)
  expect(text).toContain('10 sessions to review')
  expect(text.split('\n').filter(line => line.startsWith('-'))).toEqual(['-repo-b: b3, b2, b1, b0', '-repo-a: a5, a4, a3, a2, a1, a0'])
  expect(text).toContain("1 session left out because it holds teammates' fixes")
  const find = seen.argv.find(argv => argv[0] === 'find')
  expect(find).toEqual(['find', PROJECTS, '-mindepth', '2', '-maxdepth', '2', '-type', 'f', '-name', '*.jsonl', '-mtime', '-14'])
})

test('review_sessions lists only the sessions modified after since, which may carry milliseconds', async ($, on) => {
  const older = REPO_A.slice(0, 2)
  engine(on, { modified: Object.fromEntries(older.map(file => [file, '2026-11-05T09:59:59.999Z'])) })
  await $.command.run(TYPED_REVIEW)

  const text = String((await callTool($, SESSIONS_TOOL, { since: '2026-11-05T10:00:00.000Z' })).result)

  expect(text).toContain('8 sessions to review')
  expect(text).toContain('-repo-a: a5, a4, a3, a2')
})

test('a later listing adds to the sessions review_digest may read, never takes earlier ones away', async ($, on) => {
  engine(on, { modified: Object.fromEntries(REPO_B.map(file => [file, '2026-11-08T10:00:00Z'])), contents: { [REPO_A[0] as string]: '{}' } })
  await $.command.run(TYPED_REVIEW)
  await callTool($, SESSIONS_TOOL, { since: SINCE })

  const later = String((await callTool($, SESSIONS_TOOL, { since: '2026-11-07T00:00:00Z' })).result)
  const called = await callTool($, 'mcp__quotient__review_digest', { source: 'a0' })

  expect(later).toContain('4 sessions to review')
  expect(called.deny).toBeUndefined()
})

test('review_sessions lists at most the 40 newest sessions and says how many it left out', async ($, on) => {
  const many = Array.from({ length: 45 }, (_, i) => `${PROJECTS}/-repo-a/s${String(i).padStart(2, '0')}.jsonl`)
  engine(on, { transcripts: many, teammateFiles: [] })
  await $.command.run(TYPED_REVIEW)

  const text = String((await callTool($, SESSIONS_TOOL, { since: SINCE })).result)

  expect(text).toContain('40 sessions to review')
  expect(text).toContain('s44, s43')
  expect(text).not.toContain('s04')
  expect(text).toContain('5 older sessions left out')
})

test("past the limit, every project folder keeps sessions, so a busy one can't crowd out the rest", async ($, on) => {
  const busy = Array.from({ length: 45 }, (_, i) => `${PROJECTS}/-repo-a/s${String(i).padStart(2, '0')}.jsonl`)
  const quiet = [`${PROJECTS}/-repo-b/q0.jsonl`, `${PROJECTS}/-repo-c/r0.jsonl`, `${PROJECTS}/-repo-c/r1.jsonl`]
  // find lists them oldest first, so the quiet folders' sessions are the oldest of all.
  engine(on, { transcripts: [...quiet, ...busy], teammateFiles: [] })
  await $.command.run(TYPED_REVIEW)

  const text = String((await callTool($, SESSIONS_TOOL, { since: SINCE })).result)

  expect(text).toContain('40 sessions to review')
  expect(text).toContain('-repo-b: q0')
  expect(text).toContain('-repo-c: r1, r0')
  expect(text).toContain('s44, s43')
  expect(text).not.toContain('s07')
  expect(text).toContain('8 older sessions left out')
})

test('review_sessions refuses a since that is not a time', async ($, on) => {
  engine(on)
  await $.command.run(TYPED_REVIEW)
  const called = await callTool($, SESSIONS_TOOL, { since: 'last week' })
  expect(called.deny).toContain('since')
})

test("review_sessions refuses when quotient can't check sessions for teammates' fixes", async ($, on) => {
  engine(on, { teammateGrepFails: true })
  await $.command.run(TYPED_REVIEW)
  const called = await callTool($, SESSIONS_TOOL, { since: SINCE })
  expect(called.deny).toContain("couldn't check")
})

test('a daily review-frictions run lists sessions without a typed command', async ($, on) => {
  engine(on, { env: { QUOTIENT_DAILY_RUN_KIND: 'review-frictions' } })
  const called = await callTool($, SESSIONS_TOOL, { since: SINCE })
  expect(called.deny).toBeUndefined()
  expect(String(called.result)).toContain('10 sessions to review')
})

test("the review run ends with the main agent's turn, not a subagent's", async ($, on) => {
  engine(on)
  await $.command.run(TYPED_REVIEW)

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'a1' } as unknown as Parameters<
    typeof $.turn.complete
  >[0])
  expect((await callTool($, SESSIONS_TOOL, { since: SINCE })).deny).toBeUndefined()

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect((await callTool($, SESSIONS_TOOL, { since: SINCE })).deny).toContain('/quotient:review-frictions')
})

test('a main-agent turn that ends on an API error ends the review run too', async ($, on) => {
  engine(on)
  await $.command.run(TYPED_REVIEW)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'error' })
  expect((await callTool($, SESSIONS_TOOL, { since: SINCE })).deny).toContain('/quotient:review-frictions')
})

test('a review the model starts with the Skill tool runs the same as typed', async ($, on) => {
  engine(on)
  await callTool($, 'Skill', { skill: 'quotient:review-frictions' })
  const called = await callTool($, SESSIONS_TOOL, { since: SINCE })
  expect(called.deny).toBeUndefined()
})

const DIGEST_TOOL = 'mcp__quotient__review_digest'
const A0 = REPO_A[0] as string
// A session of 300 turns: each prompt, a large read and the agent's reply.
const LONG_SESSION = Array.from({ length: 300 }, (_, i) => [
  { type: 'user', timestamp: '2026-11-08T10:00:00Z', cwd: '/repo', message: { role: 'user', content: `Fix test ${i}` } },
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/repo/f${i}.ts` } }] },
  },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(3_000) }] } },
])
  .flat()
  .map(line => JSON.stringify(line))
  .join('\n')

/**
 * Starts a review and lists its sessions, so review_digest knows which it may read.
 *
 * @param $ - The engine
 */
async function startListed($: Engine) {
  await $.command.run(TYPED_REVIEW)
  await callTool($, SESSIONS_TOOL, { since: SINCE })
}

test('the session registers review_digest in the tool list', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.tools).toContainEqual({ name: 'review_digest', isDeferred: false })
})

test('review_digest answers with the digest of a listed session, within 6,000 characters', async ($, on) => {
  engine(on, { contents: { [A0]: LONG_SESSION } })
  await startListed($)

  const called = await callTool($, DIGEST_TOOL, { source: 'a0' })

  expect(called.deny).toBeUndefined()
  const text = String(called.result)
  expect(text).toContain('Session a0: 900 lines, /repo')
  expect(text).toContain('operator: Fix test 0')
  expect(text.length).toBeLessThanOrEqual(6_000)
})

test("review_digest refuses a session review_sessions didn't list", async ($, on) => {
  engine(on, { contents: { [A0]: LONG_SESSION } })
  await startListed($)
  for (const source of ['fixes', THIS_SESSION, 'setup', '../a0', 'nope']) {
    expect((await callTool($, DIGEST_TOOL, { source })).deny).toContain('review_sessions')
  }
})

test("review_digest refuses a listed session that has since come to hold teammates' fixes, and never reads it", async ($, on) => {
  const seen = engine(on, { contents: { [A0]: LONG_SESSION }, laterTeammateFiles: [A0] })
  await startListed($)

  const called = await callTool($, DIGEST_TOOL, { source: 'a0' })

  expect(called.deny).toContain("teammates' fixes")
  expect(seen.argv.some(argv => argv[0] === 'sed')).toBe(false)
})

test('review_digest refuses outside a review-frictions run', async ($, on) => {
  engine(on, { contents: { [A0]: LONG_SESSION } })
  await startListed($)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await callTool($, DIGEST_TOOL, { source: 'a0' })).deny).toContain('/quotient:review-frictions')
})
