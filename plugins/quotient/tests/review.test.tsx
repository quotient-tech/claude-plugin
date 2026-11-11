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
 * @returns The tools registered and the commands run
 */
function engine(
  on: On,
  opts: { transcripts?: string[]; teammateFiles?: string[]; teammateGrepFails?: boolean; env?: Record<string, string> } = {},
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
  expect(find).toEqual(['find', PROJECTS, '-mindepth', '2', '-maxdepth', '2', '-type', 'f', '-name', '*.jsonl', '-mtime', '-14', '-newermt', SINCE])
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
