// Shows the thank-yous teammates sent the operator for their fixes, each as a
// toast. `check_thank_yous` marks every thank-you it returns as delivered, so
// a check runs only where a toast can be seen: a headless run or a subagent
// would use them up unseen. The toast never names the sender.
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import { callFailure, errorText, SERVER_KEY, serverFor } from './state'
import { cleanText, FORBIDDEN, MAX_TEXT } from './text'

type On = Parameters<Register>[0]

const COMMAND = 'quotient:list-fixes'
const CHECK_MS = 15 * 60 * 1000
const TOAST_MS = 8_000
// About three lines of the toast, which wraps at about 40 columns.
const MAX_NOTE = 120
// How long a `check_thank_yous` call may take before the check counts as
// failed, so a hung call can't hold the next check back forever.
const CALL_TIMEOUT_MS = 5_000
// How long the session's start waits for the first check. Claude Code decides
// a call's permission as it's sent, so a check still in flight after this
// finishes on its own; the wait counts toward the hook's 10-second budget.
const FIRST_CHECK_WAIT_MS = 3_000

// Whether a check is running. A reload starting over at false costs at most
// one extra check, which returns nothing already shown.
let isChecking = false

/** One thank-you, keeping only the fields its toast shows. */
export type ThankYou = { message: string | null; fixDescription: string | null; frictionTitle: string | null }

/**
 * Reads a `check_thank_yous` reply.
 *
 * @param result - The tool's reply
 * @returns The thank-yous oldest first, or null when the tool failed or any
 *   part of the reply isn't the expected shape
 */
export function readThankYous(result: McpToolResult): ThankYou[] | null {
  const text = result.content.find(block => block.type === 'text')
  if (result.isError || text?.type !== 'text' || typeof text.text !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { thankYous } = parsed as Record<string, unknown>
  if (!Array.isArray(thankYous)) return null
  const read: ThankYou[] = []
  for (const entry of thankYous) {
    if (typeof entry !== 'object' || entry === null) return null
    const { message, fixDescription, frictionTitle } = entry as Record<string, unknown>
    const isText = (value: unknown) => value === null || typeof value === 'string'
    if (!isText(message) || !isText(fixDescription) || !isText(frictionTitle)) return null
    read.push({
      message: message as string | null,
      fixDescription: fixDescription as string | null,
      frictionTitle: frictionTitle as string | null,
    })
  }
  return read
}

/**
 * Cuts text to a length in characters, never splitting one in two.
 *
 * @param text - The text
 * @param max - The longest it may be, the ellipsis included
 * @returns The text, or its start and an ellipsis when it's longer
 */
function cut(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * A fix description or friction title as the toast shows it.
 *
 * @param value - The text, or null
 * @returns The cleaned, cut text, or null when there's none or it holds an
 *   id or email
 */
function shownText(value: string | null): string | null {
  const text = cleanText(value)
  if (text === null || FORBIDDEN.some(pattern => pattern.test(text))) return null
  return cut(text, MAX_TEXT)
}

/**
 * The text of one thank-you's toast. Claude Code draws the plugin's name
 * above it and draws a newline as a stray glyph, so the parts share a line.
 * The note shows as the teammate wrote it, cleaned and cut; the fix is named
 * by its description, else by its friction's title.
 *
 * @param thankYou - The thank-you
 * @returns The toast's text
 */
export function thankYouText(thankYou: ThankYou): string {
  const note = cleanText(thankYou.message)
  const thanks = note === null ? 'High-five from a teammate' : `Note from a teammate: "${cut(note, MAX_NOTE)}"`
  const fix = shownText(thankYou.fixDescription)
  const friction = shownText(thankYou.frictionTitle)
  if (fix !== null) return `${thanks} · for your fix: ${fix}`
  if (friction !== null) return `${thanks} · for your fix to: ${friction}`
  return thanks
}

/**
 * Checks for thank-yous and shows each one.
 *
 * @param $ - The engine
 * @throws When the tool call rejects
 */
async function showThankYous($: EngineInterface): Promise<void> {
  const server = serverFor(await $.mcp.connect(SERVER_KEY))
  if (server === null) return
  const call = $.mcp.call(server, 'check_thank_yous', {})
  const result = await Promise.race([call, $.clock.sleep(CALL_TIMEOUT_MS).then(() => null)])
  if (result !== null) {
    showReply($, result)
    return
  }
  // The server marks what it returns as delivered, so a slow reply is still
  // shown when it comes; only the next check stops waiting for it.
  $.ui.log('quotient thank-yous: check_thank_yous is slow; its reply shows when it comes', { to: 'debug' })
  call
    .then(
      late => showReply($, late),
      error => logFailure($, error),
    )
    .catch(() => {
      // The engine went away before the reply came, as when the session ends.
    })
}

/**
 * Logs a failed check to the debug log, with why.
 *
 * @param $ - The engine
 * @param error - What the call rejected with
 */
function logFailure($: EngineInterface, error: unknown): void {
  $.ui.log(`quotient thank-yous: check_thank_yous ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
}

/**
 * Shows each thank-you a reply holds, or logs a reply that isn't the expected
 * shape to the debug log, without its text.
 *
 * @param $ - The engine
 * @param result - The tool's reply
 */
function showReply($: EngineInterface, result: McpToolResult): void {
  const thankYous = readThankYous(result)
  if (thankYous === null) {
    $.ui.log('quotient thank-yous: check_thank_yous gave no usable reply', { to: 'debug' })
    return
  }
  // One at a time, each as the one before times out; a hovered toast that
  // stays longer may share the screen with the next.
  thankYous.forEach((thankYou, at) => {
    const show = () => $.ui.toast(thankYouText(thankYou), { timeoutMs: TOAST_MS })
    if (at === 0) show()
    else $.clock.after(at * TOAST_MS, show)
  })
}

/**
 * Checks for thank-yous unless a check is already running. Never rejects: a
 * failed check goes to the debug log only.
 *
 * @param $ - The engine
 */
async function checkThankYous($: EngineInterface): Promise<void> {
  if (isChecking) return
  isChecking = true
  try {
    try {
      await showThankYous($)
    } catch (error) {
      logFailure($, error)
    }
  } catch {
    // The engine went away mid-check, as when the session ends.
  } finally {
    isChecking = false
  }
}

/**
 * Adds the hooks that check for thank-yous in an interactive session, at the
 * times the fix-status part reads its count: once at the start, every 15
 * minutes, after each answered main-loop turn, and after
 * /quotient:list-fixes. Only the start waits for the check, and briefly.
 *
 * @param on - Adds the module's hooks
 */
export function registerThankYous(on: On): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    // Claude Code asks quotient's tool.check about its own calls only while
    // one of its hooks is running, so the first check is sent before this
    // returns. It holds the first prompt for at most FIRST_CHECK_WAIT_MS.
    await Promise.race([checkThankYous($), $.clock.sleep(FIRST_CHECK_WAIT_MS)])
    $.clock.every(CHECK_MS, () => void checkThankYous($))
    return started
  }).catch(($, e, next) => next(e))

  // Registered before the list-fixes pane's hook, so it runs outside it: the
  // pane answers the command without calling next.
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const ran = await next(e)
    void checkThankYous($)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    if (e.agentId === undefined && (await $.session.surfaces()).length > 0) void checkThankYous($)
    return next(e)
  }).catch(($, e, next) => next(e))
}
