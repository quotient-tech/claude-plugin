// Pure helpers for the plugin's shared state. Claude Code reads a hooks
// module's state and `$` calls file by file: each file declares the atoms it
// reads or writes, with the same key and shape tag as every other file, and
// keeps its own calls that take `$`. Only values and pure functions are
// shared across files.
import type { EngineInterface, McpToolResult } from 'claude-code'

import type { FrictionRow, SolutionRow, StatusParts } from '../types'

type Connected = Awaited<ReturnType<EngineInterface['mcp']['connect']>>

// The server's key in the plugin's .mcp.json, and the connector a cloud
// session reaches the same server through.
export const SERVER_KEY = 'agex'
const CONNECTOR = 'claude.ai Quotient'

// Claude Code rejects a `$.mcp.call` it denied with a plain HooksError whose
// message alone says so, as `$.mcp.call(<server>, <tool>) refused: <reason>`.
// A missing tool or server reads `$.mcp.call: no connected MCP tool`. Should
// the wording change, a denial reads as a plain failure, never the reverse.
const DENIED = /\$\.mcp\.call\([^)]*\) refused: /
// What an error's text may echo from a failed request that the debug log must
// never hold: a sign-in token, sent as a bearer token or a bare JWT, and an
// email address, such as the operator's.
// An authorization header's whole value goes, whatever its scheme, including
// a Digest header's comma-separated parameters. A field
// whose name ends in token, secret, password, key or credential, such as
// `client_secret` or `"access_token"`, loses its value, quoted or not; a
// quoted value goes up to its closing quote, spaces and escaped quotes all.
const SECRET_NAME = String.raw`\b(\w*(?:token|secret|password|passwd|api[_-]?key|apikey|credentials?))`
/** An email address, in any script. */
export const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+/u
const SECRETS: [RegExp, string][] = [
  [/\b((?:proxy-)?authorization)("?\s*[:=]\s*"?)(?:[^"\n,;}=]|=\s*"[^"]*"|=|,\s*\w+(?==))+/gi, '$1$2[redacted]'],
  [/\b(bearer|basic)\s+[^\s,;"'}]+/gi, '$1 [redacted]'],
  [new RegExp(String.raw`${SECRET_NAME}("?\s*[:=]\s*")(?:[^"\\]|\\.)*"`, 'gi'), '$1$2[redacted]"'],
  [new RegExp(String.raw`${SECRET_NAME}('?\s*[:=]\s*')(?:[^'\\]|\\.)*'`, 'gi'), "$1$2[redacted]'"],
  [new RegExp(String.raw`${SECRET_NAME}("?\s*[:=]\s*"?)[^\s,;"'&}]+`, 'gi'), '$1$2[redacted]'],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[redacted]'],
  [new RegExp(EMAIL.source, 'gu'), '[email]'],
]

/**
 * Tells a call Claude Code denied apart from any other failure.
 *
 * @param error - What `$.mcp.call` rejected with
 * @returns `denied` when Claude Code refused the call, else `failed`
 */
export function callFailure(error: unknown): 'denied' | 'failed' {
  return error instanceof Error && DENIED.test(error.message) ? 'denied' : 'failed'
}

/**
 * Reads a rejection as one line for the debug log, with any sign-in token or
 * email address in it replaced.
 *
 * @param error - Whatever was thrown
 * @returns The error's name and message, or the value as text
 */
export function errorText(error: unknown): string {
  try {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return SECRETS.reduce((line, [pattern, replacement]) => line.replace(pattern, replacement), text.replace(/\s+/g, ' '))
  } catch {
    return 'an unreadable error'
  }
}

/** One page of `list_my_frictions` with `format: "rows"`. */
export interface RowsPage {
  frictions: FrictionRow[]
  nextCursor: string | null
}

/**
 * Picks the server to call from how connecting to the plugin's own went: that
 * server, or the Quotient connector where the session's host runs the
 * plugin's servers itself, as a cloud session does. Any other refusal, such
 * as a needed sign-in, picks none.
 *
 * @param connected - What `$.mcp.connect(SERVER_KEY)` resolved to
 * @returns The server's name as `$.mcp.call` takes it, or null
 */
export function serverFor(connected: Connected): string | null {
  if (connected.isConnected) return connected.server
  return connected.reason === 'unlisted' ? CONNECTOR : null
}

/**
 * Tells whether a parsed value is a list of solutions as `list_my_frictions`
 * returns them in its rows.
 *
 * @param value - The parsed field
 * @returns Whether every entry has the fields the pane draws
 */
function isSolutions(value: unknown): value is SolutionRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      solution =>
        typeof solution === 'object' &&
        solution !== null &&
        typeof solution.id === 'string' &&
        typeof solution.found === 'string' &&
        typeof solution.isImplemented === 'boolean',
    )
  )
}

/**
 * Tells whether a parsed value is a row's own fix: null, or its description
 * (null for a prompt only) and its day.
 *
 * @param value - The parsed field
 * @returns Whether the pane can draw it
 */
function isOwnFix(value: unknown): value is FrictionRow['ownFix'] {
  if (value === null) return true
  if (typeof value !== 'object') return false
  const { description, day } = value as Record<string, unknown>
  return (typeof description === 'string' || description === null) && typeof day === 'string'
}

/**
 * Tells whether a parsed value is a list of rows as `list_my_frictions`
 * returns them with `format: "rows"`.
 *
 * @param value - The parsed page's frictions
 * @returns Whether every entry has the fields the pane draws
 */
function isRows(value: unknown): value is FrictionRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      row =>
        typeof row === 'object' &&
        row !== null &&
        ['id', 'title', 'symbol', 'severity', 'status', 'description', 'identified', 'frequency', 'impact'].every(
          field => typeof row[field] === 'string',
        ) &&
        typeof row.isFixable === 'boolean' &&
        [row.affectedSessionCount, row.reviewedSessionCount].every(
          count => count === null || (typeof count === 'number' && Number.isInteger(count) && count > 0),
        ) &&
        isSolutions(row.solutions) &&
        isOwnFix(row.ownFix),
    )
  )
}

/**
 * Reads one page of `list_my_frictions` with `format: "rows"` from its reply.
 *
 * @param result - The tool's reply
 * @returns The page's rows and the next page's cursor, or null when the tool
 *   failed or replied with anything else
 */
export function readPage(result: McpToolResult): RowsPage | null {
  const text = result.content.find(block => block.type === 'text')
  if (result.isError || text?.type !== 'text' || typeof text.text !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(text.text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { frictions, nextCursor } = parsed as Record<string, unknown>
    if (!isRows(frictions) || (nextCursor !== null && typeof nextCursor !== 'string')) return null
    return { frictions, nextCursor }
  } catch {
    return null
  }
}

/**
 * The plugin's one status line: Claude Code keeps one per plugin, so a
 * running setup's progress shows over the count of frictions with new
 * teammate fixes, which shows over the count of fixes implemented.
 * Claude Code puts "quotient:" in front of it, so no part names the plugin.
 *
 * @param parts - Each feature's part, null when it has none
 * @returns The line, or undefined to clear it
 */
export function statusLine(parts: StatusParts): string | undefined {
  return parts.setup ?? parts.frictionsToFix ?? parts.fixes ?? undefined
}
