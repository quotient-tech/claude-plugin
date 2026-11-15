// Keeps teammates' fix text away from the model, except while
// /quotient:fix-friction or /quotient:list-fixes shows it to the operator,
// and keeps teammates' thank-you notes away from it always: the operator
// reads those in quotient's own toasts.
// review-frictions and setup can send new frictions, which every teammate
// reads, so they must never hold text a teammate's agent wrote. Outside
// those two commands, each teammate's fix in the model's `list_my_frictions`
// replies is cut down to whether and when it was put in place, and a reply
// this can't read is withheld whole; guard.ts refuses reading a transcript
// that holds such text. A daily run is always held this way. Setup's
// teammate check reads teammates' frictions in a subagent, so its report
// reaches setup's session only as fixed text: what it sent is shown from the
// calls themselves.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { TeammateTextMode } from '../types'
import { isQuotientSkill } from './sandbox'

// The commands that show teammates' fixes, and those that must never see them.
const SHOWS_FIXES = ['fix-friction', 'list-fixes']
export const HIDES_FIXES = ['review-frictions', 'setup']
// Filtering stops new teammate text, but can't take back what the
// conversation already holds.
export const SHOWN_ALREADY =
  "This session already showed teammates' fixes, which review-frictions and setup must never see. Run /clear or start a new session, then run it again."
const LIST_TOOLS = /^mcp__(plugin_quotient_agex|claude_ai_Quotient)__list_my_frictions$/
const THANK_YOU_TOOLS = /^mcp__(plugin_quotient_agex|claude_ai_Quotient)__(list|check)_thank_yous$/
const WITHHELD = "quotient withheld this reply: it couldn't be read, so it might hold a teammate's fix"
const WITHHELD_NOTES = "quotient withheld this reply: it couldn't be read, so it might hold a teammate's note"
const CHECK_AGENT = 'teammate-check'
const CHECK_DONE =
  "The teammate check finished. quotient showed each answer it sent, and builds the summary's cards from them: don't read its output."

// Which kind of quotient command last started in this session: one that
// shows teammates' fixes, one that must never see them, or none. It stays
// until another starts, so a flow that spans turns stays held. Only a
// command the operator or quotient's own pane starts can show them: a Skill
// call the model makes, which planted text could steer, only ever hides.
const mode = atom({ plugin: 'quotient', key: 'teammateTextMode' } as const, null as TeammateTextMode)
// The id of the session the model last read a teammate's fix in, uncut. A
// /clear goes on under a new id, without the conversation that held it.
// Shared with guard.ts.
const shownIn = atom({ plugin: 'quotient', key: 'teammateTextShownIn' } as const, null as string | null)
// The tool_use_ids of the main session's Agent calls that started a teammate
// check, which its report carries back. Shared with guard.ts.
const checkCalls = atom({ plugin: 'quotient', key: 'teammateCheckCalls' } as const, [] as string[], { shape: 'calls-1' })

/**
 * Rewrites a teammate check's notification to fixed text, keeping the ids
 * that tie it to its task and dropping everything else in the row: its
 * report, its output file, and any other block. The notification can come
 * as a prompt of its own or, mid-turn, as an attachment, and it's found in
 * the row's text as a whole, so a tag split across blocks is still caught.
 *
 * @param content - The row's blocks
 * @param calls - The teammate checks' tool_use_ids
 * @returns The one block to keep, or null when the row names no teammate check
 */
export function checkNotice(
  content: readonly { type: string; text?: string }[],
  calls: readonly string[],
): { type: 'text'; text: string }[] | null {
  const text = content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')
  const call = calls.find(id => text.includes(`<tool-use-id>${id}</tool-use-id>`))
  if (call === undefined) return null
  const task = /<task-id>([^<]*)<\/task-id>/.exec(text)?.[1]
  const ids = `${task === undefined ? '' : `<task-id>${task}</task-id>\n`}<tool-use-id>${call}</tool-use-id>`
  return [{ type: 'text', text: `<task-notification>\n${ids}\n<status>completed</status>\n<result>${CHECK_DONE}</result>\n</task-notification>` }]
}

/**
 * Cuts each teammate's fix in a `list_my_frictions` reply down to `isOwn`
 * and `implementedAt`, leaving the operator's own frictions and fixes whole.
 *
 * @param text - The reply as the model would read it
 * @returns The reply without teammates' text, or null when it isn't a page of frictions
 */
export function withoutTeammateText(text: string): string | null {
  let page: unknown
  try {
    page = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof page !== 'object' || page === null || !Array.isArray((page as Record<string, unknown>).frictions)) return null
  const frictions = (page as { frictions: unknown[] }).frictions
  if (!frictions.every(friction => typeof friction === 'object' && friction !== null)) return null
  const cut = frictions.map(friction => {
    const { solutions } = friction as Record<string, unknown>
    if (solutions === undefined) return friction
    if (!Array.isArray(solutions)) return null
    return {
      ...(friction as Record<string, unknown>),
      solutions: solutions.map(solution => {
        if (typeof solution !== 'object' || solution === null) return null
        const { isOwn, implementedAt } = solution as Record<string, unknown>
        return isOwn === true ? solution : { isOwn: false, implementedAt: implementedAt ?? null }
      }),
    }
  })
  if (cut.some(friction => friction === null || (friction as { solutions?: unknown[] }).solutions?.includes(null))) return null
  return JSON.stringify({ ...(page as Record<string, unknown>), frictions: cut })
}

/**
 * Drops each teammate's note from a thank-you reply, leaving the rest: the
 * fix and friction a thank-you names are the operator's own.
 *
 * @param text - The reply as the model would read it
 * @returns The reply with every `message` null, or null when it isn't a list of thank-yous
 */
export function withoutNotes(text: string): string | null {
  let reply: unknown
  try {
    reply = JSON.parse(text)
  } catch {
    return null
  }
  const thankYous = (reply as { thankYous?: unknown } | null)?.thankYous
  if (!Array.isArray(thankYous) || !thankYous.every(one => typeof one === 'object' && one !== null && !Array.isArray(one))) {
    return null
  }
  return JSON.stringify({ ...(reply as Record<string, unknown>), thankYous: thankYous.map(one => ({ ...one, message: null })) })
}

/**
 * Tells whether a `list_my_frictions` reply holds a teammate's fix. A reply
 * that isn't a page of frictions is taken to hold one.
 *
 * @param text - The reply as the model reads it
 * @returns Whether it holds a solution that isn't the operator's own
 */
function holdsTeammateFix(text: string): boolean {
  let page: unknown
  try {
    page = JSON.parse(text)
  } catch {
    return true
  }
  const frictions = (page as { frictions?: unknown } | null)?.frictions
  if (!Array.isArray(frictions)) return true
  return frictions.some(friction => {
    const solutions = (friction as { solutions?: unknown } | null)?.solutions
    return Array.isArray(solutions) && solutions.some(solution => (solution as { isOwn?: unknown } | null)?.isOwn !== true)
  })
}

/**
 * Tells whether teammates' fix text must be kept from the model: always in
 * a daily run, and in an operator's session unless fix-friction or
 * list-fixes is the command running.
 *
 * @param $ - The engine
 * @returns Whether it must be kept out
 */
async function hidesTeammateText($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('QUOTIENT_DAILY_RUN_KIND')) !== undefined) return true
  return (await read($, mode)) !== 'shows'
}

/**
 * Notes which kind of quotient command is starting.
 *
 * @param $ - The engine
 * @param name - The command or skill, however it's spelled
 * @param canShow - Whether this start may show teammates' fixes: a command, not the model's Skill call
 */
async function noteCommand($: EngineInterface, name: unknown, canShow: boolean): Promise<void> {
  if (canShow && isQuotientSkill(name, SHOWS_FIXES)) await update($, mode, () => 'shows' as const)
  else if (isQuotientSkill(name, HIDES_FIXES, true)) await update($, mode, () => 'hides' as const)
}

/**
 * Adds the hooks that keep teammates' fix text from the model.
 *
 * @param on - Adds the module's hooks
 */
export function registerTeammateText(on: On): void {
  on('command.run', { command: [...SHOWS_FIXES, ...HIDES_FIXES].map(name => `quotient:${name}`) }, async ($, e, next) => {
    const shown = await read($, shownIn)
    if (shown !== null && isQuotientSkill(e.command, HIDES_FIXES, true) && shown === (await $.session.id())) {
      return { text: SHOWN_ALREADY }
    }
    await noteCommand($, e.command, true)
    return next(e)
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (next.origin.plugin === 'engine') await noteCommand($, (e as unknown as Record<string, unknown>).skill, false)
    return next(e)
  })

  // Setup's teammate check: its report never reaches setup's session as the
  // subagent wrote it. Run in the foreground, the Agent call's result is
  // replaced; run in the background, its notification is.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    if (next.origin.plugin !== 'engine' || e.agentId !== undefined || !isQuotientSkill(input.subagent_type, [CHECK_AGENT], true)) {
      return next(e)
    }
    const id = e.tool_use_id
    if (id !== undefined) await update($, checkCalls, ids => (ids.includes(id) ? ids : [...ids, id]))
    const called = await next(e)
    const result = called.result as Record<string, unknown> | undefined
    if (called.deny !== undefined || called.isError === true || result?.status !== 'completed') return called
    // Only the fields the Agent tool's shape needs, none of them the check's
    // own text: its ids, counts and usage, and the prompt setup itself wrote.
    const { agentId, prompt, totalToolUseCount, totalDurationMs, totalTokens, usage } = result
    const kept = { status: 'completed', agentId, prompt, totalToolUseCount, totalDurationMs, totalTokens, usage }
    return { result: { ...kept, content: [{ type: 'text', text: CHECK_DONE }] } } as unknown as typeof called
  })

  // By content, whichever door it comes in by: a prompt of its own, or an
  // attachment when the check finishes mid-turn.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const calls = await read($, checkCalls)
    if (calls.length === 0) return next(e)
    const notice = checkNotice(e.message.content as { type: string; text?: string }[], calls)
    return notice === null ? next(e) : next({ ...e, message: { ...e.message, content: notice as typeof e.message.content } })
  })

  // No .catch: running the call again after it ran would send it twice, and
  // a reply that slipped through uncut is what this exists to stop.
  on('tool.call', { tool: LIST_TOOLS }, async ($, e, next) => {
    // When it can't tell, it cuts.
    if (next.origin.plugin !== 'engine') return next(e)
    if (!(await hidesTeammateText($).catch(() => true))) {
      const shown = await next(e)
      if (shown.deny === undefined && shown.isError !== true && holdsTeammateFix(shown.text ?? '')) {
        const id = await $.session.id()
        await update($, shownIn, () => id)
      }
      return shown
    }
    const called = await next(e)
    if (called.deny !== undefined || called.isError === true) return called
    const cut = withoutTeammateText(called.text ?? '')
    if (cut === null) return { deny: WITHHELD }
    return { result: [{ type: 'text', text: cut }] } as unknown as typeof called
  })

  // quotient's own check calls through `$.mcp.call`, which raises no
  // tool.call, so its toasts keep the notes. No .catch, as above.
  on('tool.call', { tool: THANK_YOU_TOOLS }, async ($, e, next) => {
    if (next.origin.plugin !== 'engine') return next(e)
    const called = await next(e)
    if (called.deny !== undefined || called.isError === true) return called
    const cut = withoutNotes(called.text ?? '')
    if (cut === null) return { deny: WITHHELD_NOTES }
    return { result: [{ type: 'text', text: cut }] } as unknown as typeof called
  })
}
