// A status line entry that counts the operator's frictions with a teammate's
// fix they haven't seen yet, and names the command that shows them. It reads
// `list_my_frictions` as `json` only: the `rows` and `table` formats record
// the fixes they list as seen, which would clear the very markers this counts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { StatusParts } from '../types'
import { callFailure, errorText, SERVER_KEY, serverFor, statusLine } from './state'

type On = Parameters<Register>[0]

const COMMAND = 'quotient:list-fixes'
const REFRESH_MS = 15 * 60 * 1000
// How long a `list_my_frictions` call may take before the read counts as
// failed, so a hung call can't hold the next refresh back forever.
const CALL_TIMEOUT_MS = 5_000
// How long the session's start waits for the first read. Claude Code decides
// a call's permission as it's sent, so a read still in flight after this
// finishes on its own; the wait counts toward the hook's 10-second budget.
const FIRST_READ_WAIT_MS = 3_000

// Shared with setup.tsx and fix.tsx, which declare it with the same key.
const statusParts = atom(
  { plugin: 'quotient', key: 'statusParts' } as const,
  { setup: null, frictionsToFix: null, fixes: null } as StatusParts,
)

// Whether a refresh is running. A reload starting over at false costs at most
// one extra read.
let isRefreshing = false

/** One fix, keeping only the fields the count reads; its text is never kept. */
type FixState = { isOwn: boolean; implementedAt: string | null; viewedAt: string | null }

/** One friction, reduced to its fixes' states. */
export type FixFriction = { solutions: FixState[] }

/**
 * The status line part for a count of frictions with new teammate fixes.
 *
 * @param count - Frictions with at least one new teammate fix, or null when
 *   the count couldn't be read
 * @returns The part's text, or null when it has none
 */
export function fixStatusText(count: number | null): string | null {
  if (count === null || count === 0) return null
  return `${count} ${count === 1 ? 'friction' : 'frictions'} to fix · run /list-fixes`
}

/**
 * Counts the frictions with a teammate's fix the operator has neither seen
 * nor implemented, leaving out any friction they've already fixed some way.
 *
 * @param frictions - The operator's frictions
 * @returns How many frictions have a new fix, each counted once
 */
export function countNewFixFrictions(frictions: FixFriction[]): number {
  return frictions.filter(
    friction =>
      friction.solutions.every(fix => fix.implementedAt === null) &&
      friction.solutions.some(fix => !fix.isOwn && fix.viewedAt === null),
  ).length
}

/**
 * Reads one fix's state, rejecting a fix missing any of the fields.
 *
 * @param value - One entry of a friction's `solutions`
 * @returns The fix's state, or null when it isn't the expected shape
 */
function readFix(value: unknown): FixState | null {
  if (typeof value !== 'object' || value === null) return null
  const { isOwn, implementedAt, viewedAt } = value as Record<string, unknown>
  const isTime = (time: unknown) => time === null || typeof time === 'string'
  if (typeof isOwn !== 'boolean' || !isTime(implementedAt) || !isTime(viewedAt)) return null
  return { isOwn, implementedAt: implementedAt as string | null, viewedAt: viewedAt as string | null }
}

/**
 * Reads one page of `list_my_frictions` with `format: "json"`.
 *
 * @param result - The tool's reply
 * @returns The page's frictions and the next page's cursor, or null when the
 *   tool failed or any part of the reply isn't the expected shape
 */
export function readFixPage(result: McpToolResult): { frictions: FixFriction[]; nextCursor: string | null } | null {
  const text = result.content.find(block => block.type === 'text')
  if (result.isError || text?.type !== 'text' || typeof text.text !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { frictions, nextCursor } = parsed as Record<string, unknown>
  if (!Array.isArray(frictions) || (nextCursor !== null && typeof nextCursor !== 'string')) return null
  const page: FixFriction[] = []
  for (const friction of frictions) {
    const solutions = typeof friction === 'object' && friction !== null ? (friction as Record<string, unknown>).solutions : undefined
    if (!Array.isArray(solutions)) return null
    const fixes = solutions.map(readFix)
    if (fixes.some(fix => fix === null)) return null
    page.push({ solutions: fixes as FixState[] })
  }
  return { frictions: page, nextCursor }
}

/**
 * Reads how many of the operator's frictions have a new teammate fix,
 * across every page.
 *
 * @param $ - The engine
 * @returns The count, or null when there's no server to read from or any page
 *   failed, timed out or wasn't the expected shape
 * @throws When a tool call rejects
 */
async function readCount($: EngineInterface): Promise<number | null> {
  const server = serverFor(await $.mcp.connect(SERVER_KEY))
  if (server === null) return null
  let count = 0
  let cursor: string | null = null
  do {
    const args: Record<string, string> = { format: 'json', status: 'withTeammateFix' }
    if (cursor !== null) args.cursor = cursor
    const result = await Promise.race([
      $.mcp.call(server, 'list_my_frictions', args),
      $.clock.sleep(CALL_TIMEOUT_MS).then(() => null),
    ])
    const page = result === null ? null : readFixPage(result)
    // A server that repeats the cursor it was sent would loop forever.
    if (page === null || (page.nextCursor !== null && page.nextCursor === cursor)) {
      $.ui.log('quotient fix status: list_my_frictions gave no usable page', { to: 'debug' })
      return null
    }
    count += countNewFixFrictions(page.frictions)
    cursor = page.nextCursor
  } while (cursor !== null)
  return count
}

/**
 * Sets the frictions-to-fix part of the status line, and shows the line only
 * when that changed what it reads; setup's progress shows over this part.
 *
 * @param $ - The engine
 * @param text - The part's text, or null to clear it
 */
async function show($: EngineInterface, text: string | null): Promise<void> {
  const before = await read($, statusParts)
  if ((before.frictionsToFix ?? null) === text) return
  const parts = await update($, statusParts, current => ({ ...current, frictionsToFix: text }))
  if (statusLine(parts) !== statusLine(before)) $.ui.status(statusLine(parts))
}

/**
 * Reads the count again and shows it. Does nothing while an earlier refresh
 * is still running, and never rejects: a failed read clears the part and goes
 * to the debug log only.
 *
 * @param $ - The engine
 */
async function refreshFixStatus($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    let count: number | null
    try {
      count = await readCount($)
    } catch (error) {
      $.ui.log(`quotient fix status: list_my_frictions ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
      count = null
    }
    await show($, fixStatusText(count))
  } catch {
    // The engine went away mid-refresh, as when the session ends; the next
    // refresh tries again, and nothing here is worth showing the operator.
  } finally {
    isRefreshing = false
  }
}

/**
 * Adds the hooks that keep the frictions-to-fix part up to date in an
 * interactive session: once at the start, every 15 minutes, after each
 * answered main-loop turn, and after /quotient:list-fixes, whose pane records
 * the fixes it lists as seen. Only the start waits for the read, and briefly.
 *
 * @param on - Adds the module's hooks
 */
export function registerFixStatus(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    // After a reload the line may be gone, but the state that held it stays:
    // draw it again rather than reading the count again.
    // Claude Code asks quotient's tool.check about its own calls only while
    // one of its hooks is running, so the first read is sent before this
    // returns. It holds the first prompt for at most FIRST_READ_WAIT_MS.
    const parts = await read($, statusParts)
    if ((parts.frictionsToFix ?? null) === null) await Promise.race([refreshFixStatus($), $.clock.sleep(FIRST_READ_WAIT_MS)])
    else $.ui.status(statusLine(parts))
    $.clock.every(REFRESH_MS, () => void refreshFixStatus($))
    return started
  }).catch(($, e, next) => next(e))

  // Registered before the pane's hook, so it runs outside it: the pane answers
  // the command without calling next.
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const ran = await next(e)
    void refreshFixStatus($)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    if (e.agentId === undefined && (await $.session.surfaces()).length > 0) void refreshFixStatus($)
    return next(e)
  }).catch(($, e, next) => next(e))
}
