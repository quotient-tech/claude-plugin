// What the plugin does once a company's trial has ended. Quotient then
// refuses every call with the same opening words, so the plugin learns of it
// from the calls it already makes, never from a call of its own. The first
// such refusal in a session is kept for the rest of that session, and the
// status line reads "trial ended" until it ends; a session that starts after
// the trial is lifted works again. Until then, every /quotient command opens
// a pane that says so and runs nothing. The pane's words are the plugin's
// own: the only part of a refusal it shows is the Billing page's address.
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { StatusParts, TrialEndedRecord } from '../types'
import { errorText, readTrialEnded, statusLine } from './state'
import type { TrialEnded } from './state'

type On = Parameters<Register>[0]
// The elements the drawing uses, which the terminal and the desktop app share.
type Els = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Link'>
type Ended = Exclude<TrialEndedRecord, null>

const COMMANDS = ['setup', 'list-fixes', 'fix-friction', 'find-solutions', 'review-frictions'].map(name => `quotient:${name}`)
// Quotient's tools under the plugin's own server and the connector a cloud
// session reaches the same server through.
const QUOTIENT_TOOLS = /^mcp__(plugin_quotient_agex|claude_ai_Quotient)__/
const PANE = 'trial-ended'
const TITLE = 'Quotient'
// Asks for the widest dock; Claude Code caps a docked pane at 45% of the
// terminal, and an inline pane takes the full width anyway.
const DOCK_COLUMNS = 200
const PANE_ROWS = 24
const OPTION_INDENT = 3

const STATUS = 'trial ended'
const OPENED = 'Opened Quotient in a side pane'
const LABEL = 'TRIAL ENDED'
const HEADING = "Your company's Quotient trial has ended"
const STOPPED = 'Quotient has stopped for everyone at your company.'
const KEPT = 'Frictions and fixes from the trial are kept, and come back when your company upgrades.'
const ADMIN_NEXT = 'Upgrade on the Billing page to turn it back on.'
const MEMBER_NEXT = 'Ask a company admin to upgrade to turn it back on.'
const MEMBER_NOTE = "Only a company admin can upgrade. Quotient doesn't contact them for you."
const OPEN_BILLING = 'Open Billing'
const CLOSE = 'Close'
const CLOSE_NOTE = 'any /quotient command shows this again'
const COPIED = 'Copied the Billing link'
const NOT_COPIED = "Couldn't copy. Click the link instead"
const ADMIN_HINTS = '↑↓ choose · Enter select · Esc close'
const MEMBER_HINTS = 'Enter select · Esc close'

// Shared with fix-status.ts, setup.tsx and fix.tsx, which declare it with the
// same key.
const statusParts = atom(
  { plugin: 'quotient', key: 'statusParts' } as const,
  { setup: null, frictionsToFix: null, fixes: null } as StatusParts,
)
const trialEnded = atom({ plugin: 'quotient', key: 'trialEnded' } as const, null as TrialEndedRecord)
// Whether the last Enter on Open Billing reached the clipboard; null before one.
const copied = atom({ plugin: 'quotient', key: 'trialEndedCopied' } as const, null as boolean | null)

/**
 * Reads the trial end this session kept. The session's id is asked for only
 * when something was kept, so a session whose trial never ended never asks.
 *
 * @param $ - The engine
 * @returns The trial end, or null when this session hasn't seen one
 */
async function endedThisSession($: EngineInterface): Promise<Ended | null> {
  const kept = await read($, trialEnded)
  if (kept === null || kept.sessionId !== (await $.session.id())) return null
  return kept
}

/**
 * Says the same as the pane, for a session where no pane can open.
 *
 * @param ended - The kept trial end
 * @returns The lines, joined
 */
function endedText(ended: Ended): string {
  const next = !ended.isAdmin ? [MEMBER_NEXT, MEMBER_NOTE] : [ended.billingUrl === null ? ADMIN_NEXT : `${ADMIN_NEXT} ${ended.billingUrl}`]
  return [`${HEADING}.`, STOPPED, KEPT, ...next].join(' ')
}

/**
 * Names a link the way the pane shows it: its host and path, without the
 * scheme.
 *
 * @param url - The link
 * @returns Its host and path, such as "app.getquotient.com/billing"
 */
function linkLabel(url: string): string {
  const { host, pathname } = new URL(url)
  return `${host}${pathname}`
}

/**
 * Opens the pane with focus, so Enter and Esc reach it.
 *
 * @param $ - The engine
 * @returns Whether the pane opened
 */
async function openPane($: EngineInterface): Promise<boolean> {
  await update($, copied, () => null)
  const opened = await $.ui.open({
    id: PANE,
    title: TITLE,
    focus: true,
    closeOnEscape: true,
    rows: PANE_ROWS,
    columns: DOCK_COLUMNS,
  })
  return opened.isPlaced
}

/**
 * Answers a command once the trial has ended: the pane, or its words as text
 * where no pane can open.
 *
 * @param $ - The engine
 * @param ended - The kept trial end
 * @returns The command's answer
 */
async function answerEnded($: EngineInterface, ended: Ended): Promise<{ text: string }> {
  // A pane that can't open, or throws, still leaves the command answered.
  try {
    if (await openPane($)) return { text: OPENED }
    await $.ui.close({ id: PANE })
  } catch {
    // Falls back to the text.
  }
  return { text: endedText(ended) }
}

/**
 * Draws one numbered option with its note under it.
 *
 * @param els - The surface's elements
 * @param options.key - The option's key
 * @param options.number - Its number
 * @param options.label - What it does
 * @param options.note - The line under it
 * @param options.hasFocus - Whether the ring starts on it
 * @param options.onPress - What Enter or a click does
 * @returns The option
 */
function optionTree(
  { Box, Text, Button }: Els,
  options: {
    key: string
    number: number
    label: string
    note: RenderChildren
    hasFocus: boolean
    onPress: Parameters<typeof Button>[0]['onPress']
  },
) {
  const { key, number, label, note, hasFocus, onPress } = options
  return (
    <Box flexDirection="column">
      <Button key={key} plain autoFocus={hasFocus ? true : undefined} onPress={onPress}>
        <Text>
          <Text color="suggestion">{`${number}.`}</Text>
          {` ${label}`}
        </Text>
      </Button>
      <Box paddingLeft={OPTION_INDENT}>
        <Text dimColor>{note}</Text>
      </Box>
    </Box>
  )
}

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
 * @returns The trial end this session keeps
 */
async function record($: EngineInterface, ended: TrialEnded): Promise<Ended> {
  const sessionId = await $.session.id()
  const kept = await update($, trialEnded, current => (current?.sessionId === sessionId ? current : { sessionId, ...ended }))
  await showStatus($, STATUS)
  return kept ?? { sessionId, ...ended }
}

/**
 * Runs what a hook does once its call has gone out, so a fault there can
 * never send the call again: it goes to the debug log only.
 *
 * @param $ - The engine
 * @param what - What the hook was doing, for the log
 * @param work - The work
 */
async function afterCall($: EngineInterface, what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    try {
      $.ui.log(`quotient trial ended: ${what} failed: ${errorText(error)}`, { to: 'debug' })
    } catch {
      // The engine went away, as when the session ends.
    }
  }
}

/**
 * Adds the hooks that learn of an ended trial from Quotient's replies, keep
 * the status line saying so, and answer every /quotient command with the pane.
 *
 * @param on - Adds the module's hooks
 */
export function registerTrialEnded(on: On): void {
  // Only an interactive session draws the status line; elsewhere a kept trial
  // end from another session is told apart by its id when it's read. The
  // session's id is asked for only when something was kept. A reload starts
  // the same session again, and the line it drew may be gone.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const kept = await read($, trialEnded)
    if (kept !== null && kept.sessionId !== (await $.session.id())) {
      await update($, trialEnded, () => null)
      await showStatus($, null)
    } else if (kept !== null) {
      $.ui.status(statusLine(await read($, statusParts)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // No .catch here or on the next two hooks: running the call or command again
  // after it ran would send it twice. What runs after it can't throw.
  on('mcp.call', async ($, e, next) => {
    const called = await next(e)
    if (called.deny !== undefined) return called
    const ended = readTrialEnded(called.value)
    if (ended !== null) await afterCall($, 'recording a refusal', async () => void (await record($, ended)))
    return called
  })

  // Claude's own calls, as when it runs a quotient skill: the plugin's calls
  // through `$.mcp.call` raise no tool.call. Each refusal opens the pane, or
  // brings it back to the front, while the skill stops on its own words.
  on('tool.call', { tool: QUOTIENT_TOOLS }, async ($, e, next) => {
    const called = await next(e)
    if (next.origin.plugin !== 'engine' || called.deny !== undefined || called.isError !== true) return called
    const ended = readTrialEnded({ content: [{ type: 'text', text: called.text ?? '' }], isError: true })
    if (ended === null) return called
    await afterCall($, "showing Claude's refusal", async () => void (await answerEnded($, await record($, ended))))
    return called
  })

  // Added before every command's own hook, so it runs outside them. A trial
  // end the command's own calls find replaces what the command printed;
  // Claude Code keeps a skill the command opened, so a command that calls
  // Quotient answers a trial end itself rather than open its skill. A fault
  // before the command runs lets it run as usual.
  on('command.run', { command: COMMANDS }, async ($, e, next) => {
    try {
      const ended = await endedThisSession($)
      if (ended !== null) return await answerEnded($, ended)
    } catch {
      // Falls through to the command.
    }
    const ran = await next(e)
    let answered: { text: string } | null = null
    await afterCall($, 'checking after a command', async () => {
      const endedNow = await endedThisSession($)
      if (endedNow !== null) answered = await answerEnded($, endedNow)
    })
    return answered ?? ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Link } = els
    const columns = e.props.bodyColumns
    const ended = await read($, trialEnded)
    const isAdmin = ended?.isAdmin ?? false
    const billingUrl = ended?.billingUrl ?? null
    const wasCopied = await read($, copied)
    const close = async () => {
      await $.ui.close({ id: PANE })
    }
    const closeOption = (number: number, hasFocus: boolean) =>
      optionTree(els, { key: 'close', number, label: CLOSE, note: CLOSE_NOTE, hasFocus, onPress: close })

    return (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows}>
        <Box backgroundColor="subtle" paddingX={1}>
          <Text bold>{TITLE.padEnd(Math.max(TITLE.length, columns - 2))}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="warning">
            {LABEL}
          </Text>
          <Text bold>{HEADING}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text>{STOPPED}</Text>
          <Text dimColor>{KEPT}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text>{isAdmin ? ADMIN_NEXT : MEMBER_NEXT}</Text>
          {!isAdmin && <Text dimColor>{MEMBER_NOTE}</Text>}
        </Box>
        <Box flexDirection="column" marginTop={1} flexGrow={1}>
          {billingUrl !== null &&
            optionTree(els, {
              key: 'billing',
              number: 1,
              label: OPEN_BILLING,
              note:
                wasCopied === null ? (
                  <Link href={billingUrl} label={linkLabel(billingUrl)} />
                ) : wasCopied ? (
                  COPIED
                ) : (
                  [`${NOT_COPIED}: `, <Link key="link" href={billingUrl} label={linkLabel(billingUrl)} />]
                ),
              hasFocus: true,
              onPress: async press => {
                const result = await $.ui.copy({ text: billingUrl, surface: press.surface })
                await update($, copied, () => result.isCopied)
              },
            })}
          {closeOption(billingUrl === null ? 1 : 2, billingUrl === null)}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>
          <Text dimColor>{billingUrl === null ? MEMBER_HINTS : ADMIN_HINTS}</Text>
        </Box>
      </Box>
    )
  })
}
