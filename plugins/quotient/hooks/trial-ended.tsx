// What the plugin does once a company's trial has ended. Quotient then
// refuses every call with the same opening words, so the plugin learns of it
// from the calls it already makes, never from a call of its own. The first
// such refusal in a session is kept for the rest of that session, and the
// status line reads "trial ended" until it ends; a session that starts after
// the trial is lifted works again.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StatusParts, TrialEndedRecord } from '../types'
import { readTrialEnded, statusLine } from './state'
import type { TrialEnded } from './state'

type On = Parameters<Register>[0]

const STATUS = 'trial ended'

// Shared with fix-status.ts, setup.tsx and fix.tsx, which declare it with the
// same key.
const statusParts = atom(
  { plugin: 'quotient', key: 'statusParts' } as const,
  { setup: null, frictionsToFix: null, fixes: null } as StatusParts,
)
const trialEnded = atom({ plugin: 'quotient', key: 'trialEnded' } as const, null as TrialEndedRecord)

/**
 * Sets the trial-ended part of the status line, and shows the line when that
 * changed what it reads.
 *
 * @param $ - The engine
 * @param text - The part's text, or null to clear it
 */
async function showStatus($: EngineInterface, text: string | null): Promise<void> {
  const before = await read($, statusParts)
  if ((before.trialEnded ?? null) === text) return
  const parts = await update($, statusParts, current => ({ ...current, trialEnded: text }))
  if (statusLine(parts) !== statusLine(before)) $.ui.status(statusLine(parts))
}

/**
 * Keeps the first trial end this session sees, and shows it in the status line.
 *
 * @param $ - The engine
 * @param ended - The ended trial, as a refusal told it
 */
async function record($: EngineInterface, ended: TrialEnded): Promise<void> {
  const sessionId = await $.session.id()
  await update($, trialEnded, kept => (kept?.sessionId === sessionId ? kept : { sessionId, ...ended }))
  await showStatus($, STATUS)
}

/**
 * Adds the hooks that learn of an ended trial from Quotient's replies to the
 * plugin's own calls, and that clear a trial end an earlier session kept.
 *
 * @param on - Adds the module's hooks
 */
export function registerTrialEnded(on: On): void {
  // Only an interactive session draws the status line; elsewhere a kept trial
  // end from another session is told apart by its id when it's read. The
  // session's id is asked for only when something was kept.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const kept = await read($, trialEnded)
    if (kept !== null && kept.sessionId !== (await $.session.id())) {
      await update($, trialEnded, () => null)
      await showStatus($, null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('mcp.call', async ($, e, next) => {
    const called = await next(e)
    if (called.deny !== undefined) return called
    const ended = readTrialEnded(called.value)
    if (ended !== null) await record($, ended)
    return called
  }).catch(($, e, next) => next(e))
}
