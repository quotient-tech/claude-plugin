// Shows the thank-yous teammates sent the operator for their fixes, each as a
// toast, then marks them delivered. Listing marks nothing, so a thank-you is
// marked only once its toast has shown; the ids shown are kept in the
// plugin's store, so one whose mark failed or was denied isn't shown again in
// this install. A check runs only right after the operator acts at this
// terminal, typing a prompt or running /quotient:list-fixes, so its toast
// shows where they're looking: never in a headless run, a subagent, or a
// session another tool started or drives. The toast never names the sender.
import type { EngineInterface, McpToolResult, Register } from 'claude-code'

import { callFailure, errorText, SERVER_KEY, serverFor } from './state'
import { cleanText, FORBIDDEN, MAX_TEXT } from './text'

type On = Parameters<Register>[0]

const COMMAND = 'quotient:list-fixes'
const TOAST_MS = 8_000
// About three lines of the toast, which wraps at about 40 columns.
const MAX_NOTE = 120
// How long a list or mark call may take before the check counts as failed,
// so a hung call can't hold the next check back forever.
const CALL_TIMEOUT_MS = 5_000
// The most ids `mark_thank_yous_delivered` takes in one call; any more wait
// for the next check.
const MAX_MARK = 200
// Where the store keeps the ids already shown, and how many it keeps: enough
// that one whose mark keeps failing ages out long after it stops being listed.
const SHOWN_KEY = 'shownThankYous'
const MAX_SHOWN = 1000

// Whether a check is running. A reload starting over at false costs at most
// one extra check, which returns nothing already shown.
let isChecking = false

/** One thank-you, keeping its id and the fields its toast shows. */
export type ThankYou = { id: string; message: string | null; fixDescription: string | null; frictionTitle: string | null }

/**
 * Reads a `list_thank_yous` reply.
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
    const { id, message, fixDescription, frictionTitle } = entry as Record<string, unknown>
    const isText = (value: unknown) => value === null || typeof value === 'string'
    if (typeof id !== 'string' || id === '') return null
    if (!isText(message) || !isText(fixDescription) || !isText(frictionTitle)) return null
    read.push({
      id,
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
export function thankYouText(thankYou: Omit<ThankYou, 'id'>): string {
  const note = cleanText(thankYou.message)
  const thanks = note === null ? 'High-five from a teammate' : `Note from a teammate: "${cut(note, MAX_NOTE)}"`
  const fix = shownText(thankYou.fixDescription)
  const friction = shownText(thankYou.frictionTitle)
  if (fix !== null) return `${thanks} · for your fix: ${fix}`
  if (friction !== null) return `${thanks} · for your fix to: ${friction}`
  return thanks
}

/**
 * Waits for a call, at most CALL_TIMEOUT_MS. A call that answers later is
 * dropped, failure and all.
 *
 * @param $ - The engine
 * @param call - The call
 * @returns The call's reply, or null when it took too long
 * @throws When the call rejects in time
 */
async function within($: EngineInterface, call: Promise<McpToolResult>): Promise<McpToolResult | null> {
  call.catch(() => {})
  return Promise.race([call, $.clock.sleep(CALL_TIMEOUT_MS).then(() => null)])
}

/**
 * Reads the ids already shown in this install.
 *
 * @param $ - The engine
 * @returns The ids, oldest first; none when the store holds anything else
 */
async function shownIds($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get(SHOWN_KEY)
  return Array.isArray(stored) && stored.every(id => typeof id === 'string') ? stored : []
}

/**
 * Logs a failed call to the debug log, with why.
 *
 * @param $ - The engine
 * @param tool - The tool called
 * @param error - What the call rejected with
 */
function logFailure($: EngineInterface, tool: string, error: unknown): void {
  $.ui.log(`quotient thank-yous: ${tool} ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
}

/**
 * Lists the thank-yous, shows each one not shown before in this install,
 * then marks those delivered. A reply that is late or isn't the expected
 * shape shows and marks nothing, so the next check lists the same ones.
 *
 * @param $ - The engine
 * @throws When the list call rejects
 */
async function showThankYous($: EngineInterface): Promise<void> {
  const server = serverFor(await $.mcp.connect(SERVER_KEY))
  if (server === null) return
  const result = await within($, $.mcp.call(server, 'list_thank_yous', {}))
  if (result === null) {
    $.ui.log('quotient thank-yous: list_thank_yous is slow; the next check lists its thank-yous again', { to: 'debug' })
    return
  }
  const thankYous = readThankYous(result)
  if (thankYous === null) {
    $.ui.log('quotient thank-yous: list_thank_yous gave no usable reply', { to: 'debug' })
    return
  }
  if (thankYous.length === 0) return
  const shown = await shownIds($)
  const fresh = thankYous.filter(thankYou => !shown.includes(thankYou.id)).slice(0, MAX_MARK)
  if (fresh.length === 0) return
  // One at a time, each as the one before times out; a hovered toast that
  // stays longer may share the screen with the next. Each id is stored as its
  // toast shows, so a session that ends partway never shows one twice.
  const ids: string[] = []
  for (const thankYou of fresh) {
    if (ids.length > 0) await $.clock.sleep(TOAST_MS)
    $.ui.toast(thankYouText(thankYou), { timeoutMs: TOAST_MS })
    ids.push(thankYou.id)
    await $.store.set(SHOWN_KEY, [...shown, ...ids].slice(-MAX_SHOWN))
  }
  await markDelivered($, server, ids)
}

/**
 * Marks shown thank-yous delivered in one call. A failure goes to the debug
 * log only: the store already keeps them from showing again here.
 *
 * @param $ - The engine
 * @param server - The server to call
 * @param ids - The ids shown
 */
async function markDelivered($: EngineInterface, server: string, ids: string[]): Promise<void> {
  const tool = 'mark_thank_yous_delivered'
  try {
    const result = await within($, $.mcp.call(server, tool, { ids }))
    if (result === null) $.ui.log(`quotient thank-yous: ${tool} is slow`, { to: 'debug' })
    else if (result.isError) $.ui.log(`quotient thank-yous: ${tool} answered with an error`, { to: 'debug' })
  } catch (error) {
    logFailure($, tool, error)
  }
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
      logFailure($, 'list_thank_yous', error)
    }
  } catch {
    // The engine went away mid-check, as when the session ends.
  } finally {
    isChecking = false
  }
}

/**
 * Adds the hooks that check for thank-yous: after each prompt the operator
 * types at this terminal, and after they run /quotient:list-fixes from it.
 * Neither waits for the check. The engine stamps a prompt's origin, so one
 * another session, a schedule, a notification or a plugin sent never counts.
 *
 * @param on - Adds the module's hooks
 */
export function registerThankYous(on: On): void {
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    const entered = await next(e)
    void checkThankYous($)
    return entered
  }).catch(($, e, next) => next(e))

  // Registered before the list-fixes pane's hook, so it runs outside it: the
  // pane answers the command without calling next.
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const ran = await next(e)
    if (e.origin.kind === 'composer') void checkThankYous($)
    return ran
  }).catch(($, e, next) => next(e))
}
