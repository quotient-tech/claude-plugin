// A status line entry that reminds a trial user to invite a teammate, naming
// the web app's Invite page. Quotient decides when it's due and says so in
// `get_invite_link`'s `remindToInvite`: once the operator's first setup has
// been finished for two days and no one else has joined their company. A
// reply without the field, from a server that predates it, shows nothing.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import type { StatusParts } from '../types'
import { callFailure, errorText, SERVER_KEY, serverFor, statusLine } from './state'
import { isWebLink } from './text'

type On = Parameters<Register>[0]

const INVITE_TOOL = 'get_invite_link'
const REFRESH_MS = 15 * 60 * 1000
// How long a `get_invite_link` call may take before the read counts as
// failed, so a hung call can't hold the next refresh back forever.
const CALL_TIMEOUT_MS = 5_000
// How long the session's start waits for the first read. Claude Code decides
// a call's permission as it's sent, so a read still in flight after this
// finishes on its own; the wait counts toward the hook's 10-second budget,
// which the frictions-to-fix read shares.
const FIRST_READ_WAIT_MS = 2_000

// Shared with fix-status.ts, setup.tsx, fix.tsx and trial-ended.tsx, which
// declare it with the same key.
const statusParts = atom(
  { plugin: 'quotient', key: 'statusParts' } as const,
  { setup: null, frictionsToFix: null, fixes: null } as StatusParts,
)

// Whether a refresh is running. A reload starting over at false costs at most
// one extra read.
let isRefreshing = false

/**
 * The status line part that reminds the operator to invite a teammate.
 *
 * @param invitePageUrl - The web app's Invite page, or null when no reminder is due
 * @returns The part's text, naming the page by its host and path, or null when it has none
 */
export function inviteReminderText(invitePageUrl: string | null): string | null {
  if (invitePageUrl === null) return null
  const { host, pathname } = new URL(invitePageUrl)
  return `invite a teammate · ${host}${pathname}`
}

/**
 * Reads whether a `get_invite_link` reply asks for the reminder. A refusal,
 * such as a company that doesn't invite with a link, and a reply without
 * `remindToInvite`, from a server that predates it, both mean no reminder.
 *
 * @param result - The tool's reply
 * @returns The Invite page's address when the reminder is due, null when it
 *   isn't, or undefined when the reply asks for it but isn't the expected shape
 */
export function readInviteReminder(result: McpToolResult): string | null | undefined {
  if (result.isError) return null
  const text = result.content.find(block => block.type === 'text')
  if (text?.type !== 'text' || typeof text.text !== 'string') return undefined
  let reply: unknown
  try {
    reply = JSON.parse(text.text)
  } catch {
    return undefined
  }
  if (typeof reply !== 'object' || reply === null) return undefined
  const { remindToInvite, invitePageUrl } = reply as Record<string, unknown>
  if (remindToInvite === undefined || remindToInvite === false) return null
  if (remindToInvite !== true || !isWebLink(invitePageUrl)) return undefined
  return invitePageUrl
}

/**
 * Reads whether the reminder is due.
 *
 * @param $ - The engine
 * @returns The Invite page's address when it's due, or null when it isn't,
 *   there's no server to read from, or the read failed or timed out
 * @throws When the tool call rejects
 */
async function readReminder($: EngineInterface): Promise<string | null> {
  const server = serverFor(await $.mcp.connect(SERVER_KEY))
  if (server === null) return null
  const result = await Promise.race([$.mcp.call(server, INVITE_TOOL, {}), $.clock.sleep(CALL_TIMEOUT_MS).then(() => null)])
  const invitePageUrl = result === null ? undefined : readInviteReminder(result)
  if (invitePageUrl === undefined) {
    $.ui.log(`quotient invite reminder: ${INVITE_TOOL} gave no usable reply`, { to: 'debug' })
    return null
  }
  return invitePageUrl
}

/**
 * Sets the invite-reminder part of the status line, and shows the line only
 * when that changed what it reads.
 *
 * @param $ - The engine
 * @param text - The part's text, or null to clear it
 */
async function show($: EngineInterface, text: string | null): Promise<void> {
  const before = await read($, statusParts)
  if ((before.inviteReminder ?? null) === text) return
  const parts = await update($, statusParts, current => ({ ...current, inviteReminder: text }))
  if (statusLine(parts) !== statusLine(before)) $.ui.status(statusLine(parts))
}

/**
 * Reads whether the reminder is due and shows it. Does nothing while an
 * earlier refresh is still running, and never rejects: a failed read clears
 * the part and goes to the debug log only.
 *
 * @param $ - The engine
 */
async function refreshInviteReminder($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    let invitePageUrl: string | null
    try {
      invitePageUrl = await readReminder($)
    } catch (error) {
      $.ui.log(`quotient invite reminder: ${INVITE_TOOL} ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
      invitePageUrl = null
    }
    await show($, inviteReminderText(invitePageUrl))
  } catch {
    // The engine went away mid-refresh, as when the session ends; the next
    // refresh tries again, and nothing here is worth showing the operator.
  } finally {
    isRefreshing = false
  }
}

/**
 * Adds the hooks that keep the invite-reminder part up to date in an
 * interactive session: once at the start and every 15 minutes, so it clears
 * soon after a teammate joins. Only the start waits for the read, and briefly.
 *
 * @param on - Adds the module's hooks
 */
export function registerInviteReminder(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    // After a reload the line may be gone while the stored reminder stays,
    // and a refresh that reads the same reminder doesn't draw it again.
    const parts = await read($, statusParts)
    if ((parts.inviteReminder ?? null) !== null) $.ui.status(statusLine(parts))
    // Claude Code asks quotient's tool.check about its own calls only while
    // one of its hooks is running, so the first read is sent before this
    // returns. It holds the first prompt for at most FIRST_READ_WAIT_MS.
    await Promise.race([refreshInviteReminder($), $.clock.sleep(FIRST_READ_WAIT_MS)])
    $.clock.every(REFRESH_MS, () => void refreshInviteReminder($))
    return started
  }).catch(($, e, next) => next(e))
}
