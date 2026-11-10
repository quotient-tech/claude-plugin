// The main-thread half of fixing a friction with a teammate's fix. The
// fix-friction skill calls fix_card to show the fix before asking whether
// to apply it, fix_outcome once the operator applied or skipped it, and
// fix_thanks once an applied fix is recorded. The mod draws their rows,
// records an applied fix in Quotient, offers a thank-you for it, and keeps
// the pane's rows and the status line current.
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { FixCard, FixDrawn, FixInProgress, FrictionRow, StatusParts, ThanksDue } from '../types'
import { callFailure, errorText, readPage, SERVER_KEY, serverFor, statusLine } from './state'
import { plural, textError } from './text'

// The elements the drawings use, which the terminal and the desktop app share.
type Els = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text'>
type Checked<T> = { value: T; error?: undefined } | { error: string; value?: undefined }
type Answer = { deny: string } | { result: string }

const FIX_COMMAND = 'quotient:fix-friction'
const CARD_TOOL = 'mcp__quotient__fix_card'
const OUTCOME_TOOL = 'mcp__quotient__fix_outcome'
const THANKS_TOOL = 'mcp__quotient__fix_thanks'
// The tools' names aren't in the generated tool types until a session has
// registered them, so the hooks match them by pattern.
const FIX_TOOLS = /^mcp__quotient__fix_(card|outcome|thanks)$/
const OUTCOMES = ['applied', 'skipped'] as const
// The model records a fix with these itself where the fix tools draw nothing,
// as in a cloud session.
const MARK_TOOLS = /^mcp__(plugin_quotient_agex|claude_ai_Quotient)__mark_solution_implemented$/
// A solution id holds only these characters, as Quotient's ids do.
const PLAIN_ID = /^[A-Za-z0-9_-]+$/
const MAX_LINES = 20
const MAX_LINE = 500
// The longest friction or fix the card draws. Quotient stores longer
// descriptions, so the skill shortens one that doesn't fit.
const MAX_CARD_TEXT = 1_000
const CARD_TEXT_LIMIT = `At most ${MAX_CARD_TEXT} characters, counting an emoji as 2 or more. Shorten a longer one, keeping its meaning`
// The divider runs this long and is cut at the card's edge, since the card
// takes the transcript's width, which a docked pane narrows.
const DIVIDER_LENGTH = 500
const CARD_SHOWN =
  'The card is shown to the operator. Now ask "Apply this fix?" with the AskUserQuestion tool, as the fix-friction skill says, and write nothing before it.'
const SKIPPED_SHOWN = 'The operator sees that the fix was skipped. End your turn without writing anything else.'
const RECORDED_SHOWN =
  'The operator sees "Fix implemented" under your "✓ Applied." line. Now call fix_thanks with the same solutionId, and write nothing before it.'
const THANKS_OVER = 'The operator has answered. End your turn now: write nothing else.'
const THANKS_QUESTION = 'Send a thank-you?'
const HIGH_FIVE = 'Send a high-five (Recommended)'
const WRITE_NOTE = 'Write a note'
const SKIP = 'Skip'
const NOTE_PANE = 'thanks-note'
// The most a thank-you toast shows after its "Note from a teammate:" prefix,
// less room for the toast's word wrap, so the teammate sees the whole note.
// Counted as JavaScript counts them, which counts an emoji as the two
// columns it takes.
const NOTE_LIMIT = 80
const EMPTY_NOTE = 'Write a few words, or press Esc to skip.'
const LONG_NOTE = 'Keep it under 80 characters, or press Esc to skip.'
// The /quotient:list-fixes pane's id, which list-fixes.tsx opens it with.
const LIST_PANE = 'frictions'
const CLOSING_IN_PANE = 'Your other fixes are still in the side pane. Run /list-fixes to open it again anytime.'
const CLOSING = 'You have other fixes waiting. Run /list-fixes to see them.'

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    friction: {
      type: 'string',
      maxLength: MAX_CARD_TEXT,
      description: `The operator's friction, as its description reads. ${CARD_TEXT_LIMIT}`,
    },
    fix: {
      type: 'string',
      maxLength: MAX_CARD_TEXT,
      description: `The teammate's fix, as its description reads. ${CARD_TEXT_LIMIT}`,
    },
    file: { type: 'string', description: 'The file the fix changes, relative to the repository, when it changes one file' },
    removed: { type: 'array', items: { type: 'string' }, description: 'The lines the fix removes, if any' },
    added: { type: 'array', items: { type: 'string' }, description: 'The lines the fix adds, if any' },
  },
  required: ['friction', 'fix'],
}

const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    solutionId: { type: 'string', description: "The solution's id, from list_my_frictions" },
    outcome: { enum: OUTCOMES, description: 'applied once the edit is in place, or skipped' },
  },
  required: ['solutionId', 'outcome'],
}

const THANKS_SCHEMA = {
  type: 'object',
  properties: {
    solutionId: { type: 'string', description: 'The id of the solution fix_outcome just recorded' },
  },
  required: ['solutionId'],
}

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const drawn = atom({ plugin: 'quotient', key: 'fixDrawn' } as const, {} as FixDrawn, { shape: 'fix-drawn-3' })
const implemented = atom({ plugin: 'quotient', key: 'fixesImplemented' } as const, 0)
// Set only when a fix is recorded, and cleared once the operator answers, so
// a thank-you is offered once and only for a fix Quotient has recorded.
const thanksDue = atom({ plugin: 'quotient', key: 'thanksDue' } as const, null as ThanksDue, { shape: 'thanks-due-1' })
const noteError = atom({ plugin: 'quotient', key: 'noteError' } as const, null as string | null)

// Settles the fix_thanks call waiting on the note pane: with the note, or
// null when the operator leaves it. A function can't be kept in state, so it
// lives here, in the plugin's own environment.
let settleNote: ((note: string | null) => void) | null = null
// Whether the dialog answered the thank-you question itself while the
// operator was away. `$.ui.ask` returns only the label, so a hook on the
// question's own call reads it.
let answeredWhileAway = false
// Shared with list-fixes.tsx (rows, working) and setup.tsx (statusParts),
// which declare them with the same keys and tags.
const rows = atom({ plugin: 'quotient', key: 'rows' } as const, [], { shape: 'rows-5' })
const working = atom({ plugin: 'quotient', key: 'working' } as const, null as FixInProgress)
const statusParts = atom(
  { plugin: 'quotient', key: 'statusParts' } as const,
  { setup: null, fixes: null } as StatusParts,
)

/**
 * Checks the lines of one side of the card's diff.
 *
 * @param field - The field's name, for the refusal
 * @param value - The value
 * @returns The lines, or the first refusal
 */
function checkLines(field: string, value: unknown): Checked<string[]> {
  if (value === undefined) return { value: [] }
  if (!Array.isArray(value)) return { error: `${field}: must be a list of lines` }
  if (value.length > MAX_LINES) return { error: `${field}: must hold at most ${MAX_LINES} lines` }
  for (const [i, line] of value.entries()) {
    if (typeof line !== 'string' || line.includes('\n')) return { error: `${field}[${i}]: must be one line` }
    if (line.length > MAX_LINE) return { error: `${field}[${i}]: must be at most ${MAX_LINE} characters` }
  }
  return { value: value as string[] }
}

/**
 * Checks a `fix_card` call against the rules its drawing relies on.
 *
 * @param input - The call's input
 * @returns The card, or the first refusal as one line naming the field
 */
export function checkCard(input: Record<string, unknown>): Checked<FixCard> {
  const { friction, fix, file, removed, added } = input
  for (const [field, value] of Object.entries({ friction, fix })) {
    const error = textError(field, value, [], MAX_CARD_TEXT)
    if (error !== undefined) return { error }
  }
  if (file !== undefined) {
    const error = textError('file', file)
    if (error !== undefined) return { error }
    if ((file as string).includes('\n')) return { error: 'file: must be one path' }
  }
  const removedLines = checkLines('removed', removed)
  if (removedLines.error !== undefined) return { error: removedLines.error }
  const addedLines = checkLines('added', added)
  if (addedLines.error !== undefined) return { error: addedLines.error }
  return {
    value: {
      friction: friction as string,
      fix: fix as string,
      file: file === undefined ? null : (file as string),
      removed: removedLines.value,
      added: addedLines.value,
    },
  }
}

/**
 * Checks a `fix_outcome` call.
 *
 * @param input - The call's input
 * @returns The solution id and outcome, or the first refusal
 */
export function checkOutcome(
  input: Record<string, unknown>,
): Checked<{ solutionId: string; outcome: (typeof OUTCOMES)[number] }> {
  const { solutionId, outcome } = input
  if (typeof solutionId !== 'string' || !PLAIN_ID.test(solutionId)) {
    return { error: 'solutionId: must be a solution id from frictions mine' }
  }
  if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) return { error: 'outcome: must be applied or skipped' }
  return { value: { solutionId, outcome: outcome as (typeof OUTCOMES)[number] } }
}

/**
 * Finds the server to write to: the plugin's own, or the Quotient connector
 * where the session's host runs the plugin's servers itself.
 *
 * @param $ - The engine
 * @returns The server's name as `$.mcp.call` takes it, or null when the
 *   operator isn't signed in
 */
async function findServer($: EngineInterface): Promise<string | null> {
  return serverFor(await $.mcp.connect(SERVER_KEY))
}

/**
 * Calls one of Quotient's tools about a fix.
 *
 * @param $ - The engine
 * @param tool - The tool's name
 * @param args - The tool's arguments
 * @param solutionId - The fix's id, which a reason shown to the operator must not hold
 * @returns The reply's text, or why the call failed, in words the operator
 *   can read. A failed call may still have taken effect, as when it times out
 *   after Quotient stored it.
 */
async function callQuotient(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
  solutionId: string,
): Promise<{ text: string | undefined } | { error: string }> {
  try {
    const server = await findServer($)
    if (server === null) return { error: "you aren't signed in to Quotient" }
    const result = await $.mcp.call(server, tool, args)
    const text = result.content.find(block => block.type === 'text')
    const reply = text?.type === 'text' ? text.text : undefined
    if (!result.isError) return { text: reply }
    // The reply is shown to the operator, who never sees an id.
    return { error: textError('reply', reply, [solutionId]) === undefined ? (reply as string) : 'Quotient refused it' }
  } catch (error) {
    const failure = callFailure(error)
    $.ui.log(`quotient fix: ${tool} ${failure}: ${errorText(error)}`, { to: 'debug' })
    return { error: failure === 'denied' ? 'Claude Code denied the call to Quotient' : "Quotient couldn't be reached" }
  }
}

/**
 * Records a fix as implemented in Quotient.
 *
 * @param $ - The engine
 * @param solutionId - The solution's id
 * @returns `recorded`, or why the call failed
 */
async function record($: EngineInterface, solutionId: string): Promise<'recorded' | { error: string }> {
  const reply = await callQuotient($, 'mark_solution_implemented', { solutionId }, solutionId)
  return 'error' in reply ? reply : 'recorded'
}

/**
 * Tells whether `send_thank_you`'s reply says Quotient has the thank-you.
 *
 * @param text - The reply's text
 * @returns Whether its status is `recorded` or `alreadyRecorded`
 */
function isThanked(text: string | undefined): boolean {
  try {
    const { status } = JSON.parse(text ?? '') as { status?: unknown }
    return status === 'recorded' || status === 'alreadyRecorded'
  } catch {
    return false
  }
}

/**
 * Sends a thank-you to the teammate whose fix this is. Quotient keeps one
 * per fix, so sending again after a failure can't send two.
 *
 * @param $ - The engine
 * @param solutionId - The solution's id
 * @param message - The operator's note as typed, or null for a high-five
 * @returns `sent`, or why it wasn't
 */
async function sendThanks(
  $: EngineInterface,
  solutionId: string,
  message: string | null,
): Promise<'sent' | { error: string }> {
  const args = message === null ? { solutionId } : { solutionId, message }
  const reply = await callQuotient($, 'send_thank_you', args, solutionId)
  if ('error' in reply) return reply
  return isThanked(reply.text) ? 'sent' : { error: "Quotient's reply couldn't be read" }
}

/**
 * Reads the frictions again so the pane drops a friction with no teammate
 * fix left to apply, keeping the rows it has when Quotient can't say.
 *
 * @param $ - The engine
 */
async function refreshRows($: EngineInterface): Promise<void> {
  const list: FrictionRow[] = []
  try {
    const server = await findServer($)
    if (server === null) return
    let cursor: string | null = null
    do {
      const page = readPage(
        await $.mcp.call(server, 'list_my_frictions', cursor === null ? { format: 'rows' } : { format: 'rows', cursor }),
      )
      if (page === null) {
        $.ui.log('quotient fix: list_my_frictions gave no usable page', { to: 'debug' })
        return
      }
      list.push(...page.frictions)
      cursor = page.nextCursor
    } while (cursor !== null)
  } catch (error) {
    $.ui.log(`quotient fix: list_my_frictions ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
    return
  }
  await update($, rows, () => list.filter(row => row.isFixable))
}

/**
 * Sets the fixes' part of the status line and shows the line.
 *
 * @param $ - The engine
 * @param text - The part's line
 */
async function showFixesStatus($: EngineInterface, text: string): Promise<void> {
  const parts = await update($, statusParts, current => ({ ...current, fixes: text }))
  $.ui.status(statusLine(parts))
}

/**
 * Answers a `fix_card` call: refuses input that breaks a rule, or keeps the
 * card for its row to draw.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @param toolUseId - The call's id, which its row carries
 * @returns The refusal, or the instruction to ask next
 */
async function answerCard($: EngineInterface, input: Record<string, unknown>, toolUseId: string | undefined): Promise<Answer> {
  const checked = checkCard(input)
  if (checked.error !== undefined) return { deny: checked.error }
  const card = checked.value
  if (toolUseId !== undefined) {
    await update($, drawn, (current): FixDrawn => ({ ...current, [toolUseId]: { kind: 'card', card } }))
  }
  return { result: CARD_SHOWN }
}

/**
 * Answers a `fix_outcome` call: records an applied fix in Quotient and shows
 * the outcome, or shows that the fix was skipped. Either way the pane's
 * picked row loses its outline.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @param toolUseId - The call's id, which its row carries
 * @returns The refusal, or what the operator now sees
 */
async function answerOutcome(
  $: EngineInterface,
  input: Record<string, unknown>,
  toolUseId: string | undefined,
): Promise<Answer> {
  const checked = checkOutcome(input)
  if (checked.error !== undefined) return { deny: checked.error }
  const { solutionId, outcome } = checked.value
  // While a fix picked in the pane is in progress, only that fix can be
  // recorded or skipped: a record can't be undone from the plugin.
  const picked = await read($, working)
  if (picked !== null && picked.solutionId !== solutionId) {
    return {
      deny: "solutionId: isn't the fix the operator picked in the pane. Use the solution id /quotient:fix-friction was started with.",
    }
  }
  const show = async (row: FixDrawn[string]) => {
    if (toolUseId !== undefined) await update($, drawn, (current): FixDrawn => ({ ...current, [toolUseId]: row }))
  }

  if (outcome === 'skipped') {
    await show({ kind: 'skipped' })
    await update($, working, () => null)
    return { result: SKIPPED_SHOWN }
  }

  const recorded = await record($, solutionId)
  if (typeof recorded === 'object') {
    await show({ kind: 'notRecorded', error: recorded.error })
    return {
      result: `Quotient may not have recorded the fix: ${recorded.error}. Tell the operator the edit is in place but may not be recorded, so the fix will be offered again if it wasn't, and offer to retry. On yes, call fix_outcome again with the same solution.`,
    }
  }
  await update($, working, () => null)
  await update($, thanksDue, () => ({ solutionId }))
  await show({ kind: 'implemented' })
  const count = await update($, implemented, current => current + 1)
  await showFixesStatus($, `${plural(count, 'fix', 'fixes')} implemented`)
  await refreshRows($)
  return { result: RECORDED_SHOWN }
}

/**
 * Asks which thank-you to send. A dismissed question counts as Skip, and so
 * does one answered for the operator while they were away: a thank-you goes
 * out only when they choose it.
 *
 * @param $ - The engine
 * @returns The option's label
 */
async function askThanks($: EngineInterface): Promise<string> {
  answeredWhileAway = false
  try {
    const choice = await $.ui.ask(THANKS_QUESTION, { header: 'Thanks', options: [HIGH_FIVE, WRITE_NOTE, SKIP] })
    return answeredWhileAway ? SKIP : choice
  } catch {
    return SKIP
  }
}

/**
 * Checks a note before it's sent.
 *
 * @param note - The note as typed
 * @returns The error to show under the field, or null when it can be sent
 */
export function checkNote(note: string): string | null {
  if (note.trim() === '') return EMPTY_NOTE
  if (note.length > NOTE_LIMIT) return LONG_NOTE
  return null
}

/**
 * Opens the note pane with the keyboard and waits for the operator to send
 * a note or leave the pane.
 *
 * @param $ - The engine
 * @returns The note as typed, or null when they left it
 */
async function askNote($: EngineInterface): Promise<string | null> {
  await update($, noteError, () => null)
  const note = new Promise<string | null>(resolve => {
    settleNote = resolve
  })
  const opened = await $.ui.open({ id: NOTE_PANE, title: 'Your note', focus: true, closeOnEscape: true, rows: 3 })
  if (!opened.isPlaced) settleNote?.(null)
  return note
}

/**
 * Settles the call waiting on the note pane, once.
 *
 * @param note - The note, or null when the operator left the pane
 */
function endNote(note: string | null): void {
  const settle = settleNote
  settleNote = null
  settle?.(note)
}

/**
 * Tells whether the /quotient:list-fixes pane is open.
 *
 * @param $ - The engine
 * @returns Whether the pane is placed
 */
async function isListOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === LIST_PANE && pane.isPlaced)
}

/**
 * Says where the operator's other fixes are, when any are left: in the
 * frictions read again after the fix was recorded.
 *
 * @param $ - The engine
 * @returns The closing line, or null when no fix is left to implement
 */
async function closingLine($: EngineInterface): Promise<string | null> {
  if (!(await read($, rows)).some(row => row.isFixable)) return null
  return (await isListOpen($)) ? CLOSING_IN_PANE : CLOSING
}

/**
 * Answers a `fix_thanks` call: offers a thank-you for the fix just recorded,
 * once, and refuses any other fix.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @param toolUseId - The call's id, which its row carries
 * @returns The refusal, or what the model does next
 */
async function answerThanks(
  $: EngineInterface,
  input: Record<string, unknown>,
  toolUseId: string | undefined,
): Promise<Answer> {
  const { solutionId } = input
  if (typeof solutionId !== 'string' || !PLAIN_ID.test(solutionId)) {
    return { deny: 'solutionId: must be a solution id from frictions mine' }
  }
  const due = await read($, thanksDue)
  if (due === null || due.solutionId !== solutionId) {
    return {
      deny: 'solutionId: no thank-you is due for this fix. Call fix_thanks only right after fix_outcome records that fix.',
    }
  }
  // A retry resends the choice the operator already made.
  const isRetry = due.message !== undefined
  const show = async (shown: { error?: string; isNoteSent?: boolean; closing?: string | null } = {}) => {
    if (toolUseId === undefined) return
    const row = {
      kind: 'thanks',
      isRetry,
      error: shown.error ?? null,
      isNoteSent: shown.isNoteSent ?? false,
      closing: shown.closing ?? null,
    } as const
    await update($, drawn, (current): FixDrawn => ({ ...current, [toolUseId]: row }))
  }
  await show()

  let message = due.message
  if (message === undefined) {
    const choice = await askThanks($)
    message = choice === HIGH_FIVE ? null : choice === WRITE_NOTE ? await askNote($) : undefined
    if (message === undefined || (choice === WRITE_NOTE && message === null)) {
      await update($, thanksDue, () => null)
      await show({ closing: await closingLine($) })
      return { result: THANKS_OVER }
    }
  }

  const sent = await sendThanks($, solutionId, message)
  if (sent !== 'sent') {
    await update($, thanksDue, () => ({ solutionId, message }))
    await show({ error: sent.error })
    return {
      result: `The thanks couldn't be sent: ${sent.error}. Tell the operator, and offer to retry. On yes, call fix_thanks again with the same solutionId.`,
    }
  }
  await update($, thanksDue, () => null)
  if (message === null) $.ui.toast('High-five sent')
  await show({ isNoteSent: message !== null, closing: await closingLine($) })
  return { result: THANKS_OVER }
}

/**
 * Draws the offer of a thank-you, where the fix came from but never who, and
 * a failed send. A retry's row leaves out the offer, already shown above it.
 *
 * @param els - The surface's elements
 * @param shown - What the row keeps
 * @returns The row
 */
function thanksTree({ Box, Text }: Els, shown: Extract<FixDrawn[string], { kind: 'thanks' }>) {
  return (
    <Box flexDirection="column">
      {!shown.isRetry && (
        <Text>
          <Text color="success">●</Text> <Text bold>This fix came from a teammate's setup. Want to say thanks?</Text>
        </Text>
      )}
      {!shown.isRetry && <Text dimColor>  They'll see it at the start of their next session.</Text>}
      {shown.error !== null && <Text color="warning">{`  The thanks couldn't be sent: ${shown.error}`}</Text>}
      {shown.isNoteSent && (
        <Text>
          {'  '}
          <Text color="success">✓</Text> Note sent.
        </Text>
      )}
      {shown.closing !== null && (
        <Box marginTop={1}>
          <Text dimColor>{`  ${shown.closing}`}</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Draws the note pane: the field, and why the last note wasn't sent.
 *
 * @param $ - The engine
 * @param els - The pane's elements
 * @returns The pane's body
 */
async function noteTree($: EngineInterface, { Box, Text, Input }: Pick<Elements['terminal'], 'Box' | 'Text' | 'Input'>) {
  const error = await read($, noteError)
  return (
    <Box flexDirection="column">
      <Input
        key="note"
        label="Your note:"
        placeholder="Thanks, this fixed my CI failures!"
        submitLabel="send"
        autoFocus
        onSubmit={value => {
          const problem = checkNote(value)
          if (problem !== null) {
            void update($, noteError, () => problem)
            return
          }
          endNote(value)
          void $.ui.close({ id: NOTE_PANE })
        }}
      />
      {error !== null && <Text color="error">{error}</Text>}
    </Box>
  )
}

/**
 * Draws the fix card: the friction, a divider, the suggested fix, and the
 * file and lines it changes.
 *
 * @param els - The surface's elements
 * @param card - The checked card
 * @returns The card
 */
function cardTree({ Box, Text }: Els, card: FixCard) {
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width="100%">
      <Text bold color="error">
        YOUR FRICTION
      </Text>
      <Text>{card.friction}</Text>
      <Box height={1} overflow="hidden">
        <Text dimColor>{'╌'.repeat(DIVIDER_LENGTH)}</Text>
      </Box>
      <Text>
        <Text bold color="success">
          SUGGESTED FIX
        </Text>{' '}
        <Text dimColor>· from a teammate's setup</Text>
      </Text>
      <Text>{card.fix}</Text>
      {(card.file !== null || card.removed.length > 0 || card.added.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          {card.file !== null && <Text dimColor>{card.file}</Text>}
          {card.removed.map(line => (
            <Text color="error">{`- ${line}`}</Text>
          ))}
          {card.added.map(line => (
            <Text color="success">{`+ ${line}`}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

/**
 * Draws what a `fix_outcome` call came to.
 *
 * @param els - The surface's elements
 * @param shown - The outcome its row keeps
 * @returns The row
 */
function outcomeTree({ Box, Text }: Els, shown: Exclude<FixDrawn[string], { kind: 'card' }>) {
  if (shown.kind === 'thanks') return thanksTree({ Box, Text }, shown)
  if (shown.kind === 'skipped') return <Text dimColor>Skipped. It stays in /list-fixes.</Text>
  if (shown.kind === 'notRecorded') {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="warning">●</Text> <Text bold>Fix applied, may not be recorded</Text>
        </Text>
        <Text dimColor>{`  ${shown.error}`}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="success">●</Text> <Text bold>Fix implemented</Text>
      </Text>
      <Text dimColor>  Recorded in Quotient, so it isn't offered again on any of your machines.</Text>
    </Box>
  )
}

/** The fix tools, which the fix-friction skill calls; the session registers them. */
export const FIX_TOOLS_SPECS = [
  {
    name: 'fix_card',
    description:
      "Shows the operator a teammate's fix for one of their frictions as a card, before asking whether to apply it. Call it once per fix, with the fields the fix-friction skill lists.",
    inputSchema: CARD_SCHEMA,
    isDeferred: false,
  },
  {
    name: 'fix_outcome',
    description:
      "Records in Quotient that the operator applied a teammate's fix, or shows that they skipped it. Call it once the edit is in place, or once they choose Skip, as the fix-friction skill says.",
    inputSchema: OUTCOME_SCHEMA,
    isDeferred: false,
  },
  {
    name: 'fix_thanks',
    description:
      "Offers the operator a thank-you to the teammate whose fix they just implemented, and sends it if they choose. Call it right after fix_outcome records the fix, as the fix-friction skill says.",
    inputSchema: THANKS_SCHEMA,
    isDeferred: false,
  },
] as const

/**
 * Answers the fix tools' calls and draws their rows.
 *
 * @param on - Adds the module's hooks
 */
export const registerFix: Register = on => {
  // fix-friction needs the ids /list-fixes starts it with, so the typeahead
  // leaves it out. Hidden this way, unlike with `user-invocable: false`, it
  // still runs from $.command.run and typed in full.
  on('command.describe', { command: FIX_COMMAND }, ($, e, next) => next({ ...e, isHidden: true }))

  // The operator typing /quotient:fix-friction starts a flow of their own, so
  // a fix picked in the pane earlier and never finished is left behind. The
  // pane starts its own flow from a plugin, which doesn't count.
  on('command.run', { command: FIX_COMMAND }, async ($, e, next) => {
    if (e.origin.kind === 'composer') await update($, working, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  // No .catch: falling back to next(e) after a call ran would run it again.
  on('tool.call', { tool: FIX_TOOLS }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if ((e.tool as string) === CARD_TOOL) return answerCard($, input, e.tool_use_id)
    if ((e.tool as string) === THANKS_TOOL) return answerThanks($, input, e.tool_use_id)
    return answerOutcome($, input, e.tool_use_id)
  })

  // No .catch: falling back to next(e) after a call ran would record it
  // twice. refreshRows never throws. A rows read marks the fixes it lists as
  // seen, so it runs only while the pane is there to show them.
  on('tool.call', { tool: MARK_TOOLS }, async ($, e, next) => {
    const marked = await next(e)
    if (marked.deny !== undefined || marked.isError === true) return marked
    const solutionId = (e as unknown as { solutionId?: unknown }).solutionId
    await update($, working, current => (current?.solutionId === solutionId ? null : current))
    if (await isListOpen($)) await refreshRows($)
    return marked
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const asked = await next(e)
    const isThanks = e.questions.some(one => one.question === THANKS_QUESTION)
    const reply = asked.result as { afkTimeoutMs?: number } | undefined
    if (isThanks && reply?.afkTimeoutMs !== undefined) answeredWhileAway = true
    return asked
  })

  on('ui.render', { component: 'Pane', requestId: NOTE_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    // A surface with no text field can't take a note; Esc still leaves it.
    if (!('Input' in els)) return <els.Box />
    return noteTree($, els)
  }).catch(($, e, next) => next(e))

  // Esc, the close mark, or the pane going away leaves the note unsent.
  on('ui.close', { id: NOTE_PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'plugin') endNote(null)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A fix tool's own row draws what the call came to, and its result row,
  // which would only repeat the instruction to the model, is hidden.
  on('ui.render', { component: 'ToolUse', props: { tool: FIX_TOOLS } }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const shown = (await read($, drawn))[e.props.tool_use_id]
    if (shown?.kind === 'card') return cardTree($.ui.resolve(e), shown.card)
    if (shown !== undefined) return outcomeTree($.ui.resolve(e), shown)
    // Until the call is checked, its row would show the raw input.
    if (!e.props.isRunning) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult', props: { tool: FIX_TOOLS } }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, drawn))[e.props.tool_use_id] === undefined) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))
}
