// review-frictions' run: quotient lists the sessions a review reads, so the
// skill never lists or reads the transcripts itself. A run starts with the
// typed command, the model's Skill call, or a daily review-frictions run,
// and ends with the main agent's turn.
import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { ReviewRun } from '../types'
import { isQuotientSkill, isSkippedProject, TEAMMATE_TOOL_USE } from './sandbox'
import { QUOTIENT_STARTED, transcriptFindArgs } from './sessions'
import { plural } from './text'

type Api = Parameters<Hook<'tool.call'>>[0]
type Dirs = { config: string; home: string; runs: string }

const REVIEW_COMMAND = 'quotient:review-frictions'
const SESSIONS_TOOL = 'mcp__quotient__review_sessions'
const REVIEW_TOOLS = /^mcp__quotient__review_sessions$/
const DAILY_KIND = 'review-frictions'
const TURN_ENDS = ['answer', 'aborted', 'refusal', 'error'] as const
// How far back a review looks, and how many sessions one listing holds.
const WINDOW_DAYS = 14
const MAX_SESSIONS = 40
const NOT_RUNNING = 'review_sessions works only while /quotient:review-frictions is running'
const BAD_SINCE = 'since: must be a time, such as 2026-11-05T10:00:00Z'
const UNCHECKED = "quotient couldn't check the sessions for teammates' fixes, so it lists none: review no sessions this run"

const SESSIONS_SCHEMA = {
  type: 'object',
  properties: {
    since: {
      type: 'string',
      description: 'List the sessions modified after this time, as an ISO time; quotient never lists any older than 14 days',
    },
  },
  required: ['since'],
}

/** review-frictions' tools, which the skill calls; the session registers them. */
export const REVIEW_TOOLS_SPECS = [
  {
    name: 'review_sessions',
    description:
      'Lists the sessions /quotient:review-frictions reviews: those modified after `since` and within the last 14 days, newest first, by project folder, leaving out the ones the review skips.',
    inputSchema: SESSIONS_SCHEMA,
    isDeferred: false,
  },
] as const

const NO_RUN: ReviewRun = { isRunning: false, listed: {} }
const run = atom({ plugin: 'quotient', key: 'reviewRun' } as const, NO_RUN, { shape: 'review-1' })

/**
 * Tells whether a review-frictions run is going: one the operator or the
 * model started, or a daily one, which runs for its whole process.
 *
 * @param $ - The engine
 * @returns Whether the review tools may answer
 */
async function isReviewing($: Api): Promise<boolean> {
  return (await read($, run)).isRunning || (await $.env.get('QUOTIENT_DAILY_RUN_KIND')) === DAILY_KIND
}

/**
 * Runs a command and splits its output into lines.
 *
 * @param $ - The engine
 * @param argv - The command and its arguments
 * @param okCodes - The exit codes that mean it ran
 * @returns Its output's lines, without empty ones
 * @throws When it exits with another code
 */
async function outputOf($: Api, argv: string[], okCodes: readonly number[] = [0]): Promise<string[]> {
  const ran = await $.process.run(argv, { timeoutMs: 30_000 })
  if (!okCodes.includes(ran.exitCode)) throw new Error(`${argv[0]} exited ${ran.exitCode}`)
  return ran.stdout.split('\n').filter(line => line !== '')
}

/**
 * Looks up the config folder the transcripts live in, and the folders a
 * skipped project folder is told apart by.
 *
 * @param $ - The engine
 * @returns The folders
 * @throws When they can't be found
 */
async function lookUpDirs($: Api): Promise<Dirs> {
  const [config, home, runs] = await outputOf($, [
    'sh',
    '-c',
    'printf "%s\\n%s\\n%s\\n" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$HOME" "${XDG_DATA_HOME:-$HOME/.local/share}/quotient"',
  ])
  if (!config?.startsWith('/') || !home?.startsWith('/') || !runs?.startsWith('/')) throw new Error('no folders')
  return { config, home, runs }
}

/**
 * Lists the sessions a review reads, newest first: the window's transcripts,
 * leaving out temporary and daily-run folders, this session, the sessions
 * quotient's own skills started, and the ones that hold teammates' fixes.
 *
 * @param $ - The engine
 * @param since - The time the listed sessions were modified after
 * @returns The listed transcripts, and how many were left out for teammates' fixes or age
 * @throws When the transcripts can't be listed or checked
 */
async function listSessions($: Api, since: string): Promise<{ files: string[]; held: number; older: number }> {
  const dirs = await lookUpDirs($)
  const own = `${await $.session.id()}.jsonl`
  const found = await outputOf($, transcriptFindArgs(`${dirs.config}/projects`, { days: WINDOW_DAYS, since }))
  const kept = found.filter(file => !isSkippedProject(file.split('/').at(-2) ?? '', dirs) && !file.endsWith(`/${own}`))
  if (kept.length === 0) return { files: [], held: 0, older: 0 }
  const started = new Set(await outputOf($, ['awk', QUOTIENT_STARTED, ...kept]))
  const typed = kept.filter(file => !started.has(file))
  if (typed.length === 0) return { files: [], held: 0, older: 0 }
  const held = new Set(await outputOf($, ['grep', '-l', '-E', '--', TEAMMATE_TOOL_USE, ...typed], [0, 1]))
  const clean = typed.filter(file => !held.has(file))
  if (clean.length === 0) return { files: [], held: held.size, older: 0 }
  const newest = (await outputOf($, ['ls', '-t', '--', ...clean])).filter(file => clean.includes(file))
  return { files: newest.slice(0, MAX_SESSIONS), held: held.size, older: Math.max(0, newest.length - MAX_SESSIONS) }
}

/**
 * Writes a listing for the model: each project folder's sessions by name,
 * newest first, and what was left out.
 *
 * @param files - The listed transcripts, newest first
 * @param held - How many were left out for holding teammates' fixes
 * @param older - How many older ones were left out past the limit
 * @returns The listing
 */
function listingText(files: readonly string[], held: number, older: number): string {
  const byFolder = new Map<string, string[]>()
  for (const file of files) {
    const [folder = '', name = ''] = file.split('/').slice(-2)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), name.replace(/\.jsonl$/, '')])
  }
  return [
    `${plural(files.length, 'session')} to review, newest first, by project folder:`,
    ...[...byFolder].map(([folder, names]) => `${folder}: ${names.join(', ')}`),
    held === 0 ? '' : `${plural(held, 'session')} left out because ${held === 1 ? 'it holds' : 'they hold'} teammates' fixes.`,
    older === 0 ? '' : `${plural(older, 'older session')} left out: only the ${MAX_SESSIONS} newest are listed.`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Answers a `review_sessions` call with the sessions to review, and keeps
 * them as the ones this run may read.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @returns The refusal, or the listing
 */
async function answerSessions($: Api, input: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
  if (!(await isReviewing($))) return { deny: NOT_RUNNING }
  const since = input.since
  if (typeof since !== 'string' || Number.isNaN(Date.parse(since))) return { deny: BAD_SINCE }
  try {
    const { files, held, older } = await listSessions($, since)
    const listed = Object.fromEntries(files.map(file => [file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, ''), file]))
    await update($, run, current => ({ ...current, listed }))
    return { result: listingText(files, held, older) }
  } catch {
    return { deny: UNCHECKED }
  }
}

/**
 * Starts a review-frictions run.
 *
 * @param $ - The engine
 */
async function startRun($: Api): Promise<void> {
  await update($, run, () => ({ ...NO_RUN, isRunning: true }))
}

/**
 * Tracks a review-frictions run and answers its tools.
 *
 * @param on - Adds the module's hooks
 */
export const registerReview: Register = on => {
  on('command.run', { command: REVIEW_COMMAND }, async ($, e, next) => {
    await startRun($ as unknown as Api)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A review the model starts with the Skill tool runs the same as typed.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const skill = (e as unknown as Record<string, unknown>).skill
    if (e.agentId === undefined && isQuotientSkill(skill, [DAILY_KIND], true)) await startRun($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // No .catch: falling back to next(e) would hand the call to a tool that isn't there.
  on('tool.call', { tool: REVIEW_TOOLS }, async ($, e) => {
    if ((e.tool as string) === SESSIONS_TOOL) return answerSessions($, e as unknown as Record<string, unknown>)
    return { deny: NOT_RUNNING }
  })

  // Every way the main agent's turn ends ends the run. The reasons are listed
  // because the module's one unmatched turn.complete hook is setup's.
  on('turn.complete', { reason: TURN_ENDS }, async ($, e, next) => {
    if (e.agentId === undefined) await update($, run, () => NO_RUN)
    return next(e)
  }).catch(($, e, next) => next(e))
}
