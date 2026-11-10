// /quotient:list-fixes as a pane beside the transcript: the operator's
// frictions that have a teammate's fix, in a list they can read, open for
// details, and pick a fix from to start /quotient:fix-friction in the main
// thread. Anything that stops the pane from opening hands the command to the
// list-fixes skill, which lists the same rows as text.
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { FixInProgress, FrictionRow, FrictionView, SolutionRow, TeammateTextMode } from '../types'
import { callFailure, errorText, readPage, SERVER_KEY, serverFor } from './state'
import { DENIED_HELP, plural } from './text'
import { impactLabel } from './impact'

// The elements the drawings use, which the terminal and the desktop app share.
type Els = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text' | 'Button'>

const COMMAND = 'quotient:list-fixes'
const FIX_COMMAND = 'quotient:fix-friction'
const PANE = 'frictions'
const TITLE = 'Quotient'
const MAX_ROWS_OPEN = 10
// Asks for the widest dock; Claude Code caps a docked pane at 45% of the
// terminal, and an inline pane takes the full width anyway.
const DOCK_COLUMNS = 200
const SYMBOL_WIDTH = 2
const STATUS_GAP = 2
const FIX_NUMBER_WIDTH = 4
// The most rows the details ask for inline; the layout may spare fewer.
const MAX_DETAIL_ROWS = 40
// The lines above the first row in the list: the header band, a blank line
// and the label.
const LIST_TOP_LINES = 3
// The details' lines besides the title, the meta line, the description and
// the fixes: the band and a blank line, the label, the found date and a blank
// line, a blank line and the fixes' label, and the footer's three lines.
const DETAIL_FIXED_LINES = 10

const OPENED = 'Opened your frictions in a side pane'
const NO_FIXES = "No fixes from teammates yet. They'll show up in the status line when they arrive."
const ALL_APPLIED = "You've applied every teammate fix so far. New ones will show up in the status line when they arrive."
const DENIED = `The Quotient pane couldn't read your frictions because Claude Code denied its call to Quotient. Why: ${DENIED_HELP}`
const CLOSED = 'Closed. Your fixes will be here when you come back.'
const NOTE = 'Only frictions with a teammate fix left to apply are listed.'
const EMPTY = 'All teammate fixes applied. New ones will show up in the status line.'
const LIST_HINTS = '↑↓ move · Enter open · Esc close'
const EMPTY_HINTS = 'Esc close'
const WORKING_HINTS = 'working on 1 in the main thread'
const DETAIL_HINTS = '↑↓ choose · Enter use this fix · Esc back'

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload. fix.tsx declares rows and working
// too, with the same keys and tags.
const rows = atom({ plugin: 'quotient', key: 'rows' } as const, [], { shape: 'rows-5' })
const view = atom({ plugin: 'quotient', key: 'view' } as const, null as FrictionView)
const working = atom({ plugin: 'quotient', key: 'working' } as const, null as FixInProgress)
// Shared with teammate-text.ts and guard.ts: a fix picked here shows its
// teammate's text to fix-friction, the only flow that applies it.
const textMode = atom({ plugin: 'quotient', key: 'teammateTextMode' } as const, null as TeammateTextMode)

// The row holding the focus ring, as the last ui.focus left it, and the
// pane's scroll offset and width, as last drawn. Nothing is drawn from them,
// so a reload losing them costs one arrow press.
let focusedId: string | undefined
let drawnOffset = 0
let drawnColumns = DOCK_COLUMNS

/**
 * Finds the server to read from: the plugin's own, or the Quotient connector
 * where the session's host runs the plugin's servers itself, as a cloud
 * session does. Any other refusal, such as a needed sign-in, finds none, so
 * the skill can say how to sign in.
 *
 * @param $ - The engine
 * @returns The server's name as `$.mcp.call` takes it, or null
 */
async function findServer($: EngineInterface): Promise<string | null> {
  return serverFor(await $.mcp.connect(SERVER_KEY))
}

/**
 * Reads every page of the operator's frictions from Quotient's MCP server.
 *
 * @param $ - The engine
 * @returns The rows, or null when there's no server to read from or any page
 *   isn't rows
 * @throws When the tool call rejects
 */
async function readRows($: EngineInterface): Promise<FrictionRow[] | null> {
  const server = await findServer($)
  if (server === null) return null
  const list: FrictionRow[] = []
  let cursor: string | null = null
  do {
    const page = readPage(
      await $.mcp.call(server, 'list_my_frictions', cursor === null ? { format: 'rows' } : { format: 'rows', cursor }),
    )
    if (page === null) {
      $.ui.log('quotient list-fixes: list_my_frictions gave no usable page', { to: 'debug' })
      return null
    }
    list.push(...page.frictions)
    cursor = page.nextCursor
  } while (cursor !== null)
  return list
}

/**
 * Opens the pane, or takes the keyboard back and resizes it when the pane is
 * already open.
 *
 * @param $ - The engine
 * @param options.rows - The body rows wanted while inline; a docked pane ignores it
 * @param options.focus - Whether the pane takes the keyboard
 * @returns Whether the pane is drawn
 */
async function openPane($: EngineInterface, options: { rows: number; focus: boolean }): Promise<boolean> {
  const opened = await $.ui.open({
    id: PANE,
    title: TITLE,
    ...(options.focus ? { focus: true, closeOnEscape: true } : {}),
    rows: options.rows,
    columns: DOCK_COLUMNS,
  })
  return opened.isPlaced
}

/**
 * Estimates the lines a text takes at a width.
 *
 * @param text - The text
 * @param width - The columns it wraps in
 * @returns At least one line
 */
function lines(text: string, width: number): number {
  return Math.max(1, Math.ceil(text.length / Math.max(1, width)))
}

/**
 * The width a row's title wraps in: what's left beside the symbol and the
 * status.
 *
 * @param row - The friction
 * @param columns - The pane's body width
 * @returns The columns for the title
 */
function titleWidth(row: FrictionRow, columns: number): number {
  return Math.max(8, columns - SYMBOL_WIDTH - STATUS_GAP - row.status.length)
}

/**
 * The body rows the list wants: a screenful of rows at most, plus the header
 * and the label.
 *
 * @param count - How many frictions it lists
 * @returns The rows to ask for
 */
function listRows(count: number): number {
  return Math.min(count, MAX_ROWS_OPEN) + LIST_TOP_LINES
}

/**
 * Estimates the body rows a friction's details take at a width, so an inline
 * pane can grow to show them whole.
 *
 * @param row - The friction
 * @param columns - The pane's body width
 * @returns The rows to ask for
 */
function detailRows(row: FrictionRow, columns: number): number {
  const fixWidth = columns - FIX_NUMBER_WIDTH
  const total =
    DETAIL_FIXED_LINES +
    lines(row.title, columns) +
    lines(`${row.severity} · ${impactLabel(row.impact)} · ${occurrences(row)}`, columns) +
    lines(row.description, columns) +
    row.solutions.reduce((sum, solution) => sum + lines(solution.description ?? '', fixWidth) + 1, 0)
  return Math.min(total, MAX_DETAIL_ROWS)
}

/**
 * Shows the list again with the friction just left focused. Focus has to be
 * moved by hand: autoFocus applies only as the pane takes the keyboard.
 *
 * @param $ - The engine
 * @param id - The friction whose details were showing
 */
async function backToList($: EngineInterface, id: string): Promise<void> {
  await update($, view, () => ({ id, isDetails: false }))
  await openPane($, { rows: listRows((await read($, rows)).length), focus: true })
  // In a list longer than the pane the row may be out of view, and only a
  // row in view can take the focus.
  await $.ui.scroll({ to: { key: id }, in: PANE })
  await $.ui.focus({ requestId: PANE, key: id })
}

/**
 * Starts the main-thread flow for a teammate's fix: the pane goes back to
 * the list, with the friction's row outlined, and hands the keyboard to the
 * prompt. A pane keeps the keyboard until it closes, so it is closed and
 * opened again without focus.
 *
 * @param $ - The engine
 * @param row - The friction
 * @param solution - The fix the operator picked
 */
async function useFix($: EngineInterface, row: FrictionRow, solution: SolutionRow): Promise<void> {
  await update($, working, () => ({ frictionId: row.id, solutionId: solution.id }))
  await update($, textMode, () => 'shows' as const)
  await update($, view, () => ({ id: row.id, isDetails: false }))
  await $.ui.close({ id: PANE })
  await openPane($, { rows: listRows((await read($, rows)).length), focus: false })
  $.ui.log(`Using a teammate's fix for "${row.title}"`)
  await $.command.run({ command: FIX_COMMAND, args: `${row.id} ${solution.id}` })
}

/**
 * Says how often a friction happened: how many sessions it appeared in and
 * what share of the reviewed sessions that was, or its frequency text when
 * it wasn't counted.
 *
 * @param row - The friction
 * @returns The counts, such as "12 occurrences in last 2 weeks · 14% of sessions"
 */
function occurrences(row: FrictionRow): string {
  const { affectedSessionCount: affected, reviewedSessionCount: reviewed } = row
  if (affected === null) return row.frequency
  const count = `${plural(affected, 'occurrence')} in last 2 weeks`
  if (reviewed === null) return count
  // A friction seen at all shows at least 1%, so a share never reads as none.
  const share = Math.max(1, Math.round((affected / reviewed) * 100))
  return `${count} · ${share}% of sessions`
}

/**
 * Picks the color for a severity symbol, so the shape and the color agree.
 *
 * @param symbol - The symbol from `list_my_frictions` rows
 * @returns The theme color, or undefined to draw it dim
 */
function symbolColor(symbol: string): 'error' | 'warning' | undefined {
  if (symbol === '▲') return 'error'
  if (symbol === '◆') return 'warning'
  return undefined
}

/**
 * Draws the header band, the same in every view. The title is padded to the
 * pane's width, so the band's color runs the full width.
 *
 * @param els - The surface's elements
 * @param columns - The pane's body width
 * @returns The band
 */
function headerTree({ Box, Text }: Els, columns: number) {
  return (
    <Box backgroundColor="subtle" paddingX={1}>
      <Text bold>{TITLE.padEnd(Math.max(TITLE.length, columns - 2))}</Text>
    </Box>
  )
}

/**
 * Draws the footer: a thin rule, then the key hints.
 *
 * @param els - The surface's elements
 * @param hints - The key hints
 * @param columns - The pane's body width
 * @returns The footer
 */
function footerTree({ Box, Text }: Els, hints: string, columns: number) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>
      <Text dimColor>{hints}</Text>
    </Box>
  )
}

/**
 * Draws one friction's row: its severity symbol, its title, which wraps
 * rather than being cut, and its fix count on the right. The row the main
 * thread is working on is outlined.
 *
 * @param els - The surface's elements
 * @param options.row - The friction
 * @param options.isWorking - Whether the main thread is working on one of its fixes
 * @param options.hasFocus - Whether the ring starts on this row
 * @param options.onPress - What Enter or a click does
 * @returns The row
 */
function rowTree(
  { Box, Text, Button }: Els,
  options: { row: FrictionRow; isWorking: boolean; hasFocus: boolean; onPress: () => Promise<void> },
) {
  const { row, isWorking, hasFocus, onPress } = options
  const color = symbolColor(row.symbol)
  return (
    <Box key={`row:${row.id}`} flexDirection="row" {...(isWorking ? { borderStyle: 'round', borderColor: 'success' } : {})}>
      <Box width={SYMBOL_WIDTH} flexShrink={0}>
        <Text color={color} dimColor={color === undefined}>
          {row.symbol}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Button key={row.id} plain autoFocus={hasFocus ? true : undefined} onPress={onPress}>
          {row.title}
        </Button>
      </Box>
      <Box flexShrink={0} marginLeft={STATUS_GAP}>
        <Text color="success">{row.status}</Text>
      </Box>
    </Box>
  )
}

/**
 * Draws one teammate's fix in the details: a numbered option the operator
 * can pick while the fix is still to implement, else a plain line.
 *
 * @param els - The surface's elements
 * @param options.solution - The fix
 * @param options.number - Its number, from 1
 * @param options.isPickable - Whether the operator can pick it
 * @param options.isRecommended - Whether it's marked recommended
 * @param options.hasFocus - Whether the ring starts on it
 * @param options.onPress - What Enter or a click does
 * @returns The option
 */
function fixTree(
  { Box, Text, Button }: Els,
  options: {
    solution: SolutionRow
    number: number
    isPickable: boolean
    isRecommended: boolean
    hasFocus: boolean
    onPress: () => Promise<void>
  },
) {
  const { solution, number, isPickable, isRecommended, hasFocus, onPress } = options
  const summary = solution.description ?? 'A prompt only'
  const note = solution.isImplemented ? `implemented · found ${solution.found}` : `found ${solution.found}`
  return (
    <Box flexDirection="column">
      {!isPickable ? (
        <Text dimColor>{`${number}. ${summary}`}</Text>
      ) : (
        <Button key={`fix:${solution.id}`} plain autoFocus={hasFocus ? true : undefined} onPress={onPress}>
          <Text color="success">{`${number}.`}</Text> {summary}
        </Button>
      )}
      <Box paddingLeft={FIX_NUMBER_WIDTH}>
        <Text dimColor>
          {isRecommended && <Text color="success">recommended · </Text>}
          {note}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * Opens the pane when the operator types /quotient:list-fixes, draws its
 * list and details views, and turns Esc in the details into a way back.
 *
 * @param on - Adds the module's hooks
 */
export const registerListFixes: Register = on => {
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    // Listing again ends a fix picked earlier whose flow never ended, even
    // when the list then falls back to text or has nothing to show.
    await update($, working, () => null)
    let list: FrictionRow[] | null
    try {
      list = await readRows($)
    } catch (error) {
      const failure = callFailure(error)
      $.ui.log(`quotient list-fixes: list_my_frictions ${failure}: ${errorText(error)}`, { to: 'debug' })
      if (failure === 'denied') $.ui.log(DENIED)
      // The hook's catch hands the command to the skill.
      throw error
    }
    if (list === null) return next(e)
    if (list.length === 0) return { text: NO_FIXES }
    // The pane lists only work left to do: a friction leaves it once no
    // teammate fix is left to apply.
    const fixable = list.filter(row => row.isFixable)
    if (fixable.length === 0) return { text: ALL_APPLIED }

    await update($, rows, () => fixable)
    await update($, view, () => null)
    if (!(await openPane($, { rows: listRows(fixable.length), focus: true }))) {
      await $.ui.close({ id: PANE })
      return next(e)
    }
    return { text: OPENED }
  }).catch(($, e, next) => next(e))

  // Esc closes the pane from the list, but in the details it goes back to
  // the list. Esc also hands the keyboard to the prompt, so the pane opens
  // again with focus to take it back.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
    const shown = await read($, view)
    if (!shown?.isDetails) {
      $.ui.log(CLOSED)
      return next(e)
    }

    await backToList($, shown.id)
    // Answering without next keeps the pane open.
    return { value: undefined }
  }).catch(($, e, next) => next(e))

  on('ui.focus', async ($, e, next) => {
    const moved = await next(e)
    if (e.requestId === PANE && moved.deny === undefined) focusedId = e.element
    return moved
  }).catch(($, e, next) => next(e))

  // While the list is longer than the pane, Claude Code spends the arrow keys
  // scrolling it, which leaves the selection behind. In the list, an arrow
  // moves the selection one row instead, scrolling only to keep it in view.
  // The wheel (which has a pointer) and the page keys still scroll.
  on('ui.scroll', async ($, e, next) => {
    const isArrow = e.origin.kind === 'person' && e.pointer === undefined && Math.abs(e.by) === 1
    if (e.requestId !== PANE || !isArrow || (await read($, view))?.isDetails) return next(e)
    const list = await read($, rows)
    const index = list.findIndex(one => one.id === focusedId)
    const target = list[index + e.by]
    if (index === -1 || target === undefined) return next(e)

    // The header and the label take the first lines of the body, then each
    // friction takes as many lines as its title wraps to.
    const columns = drawnColumns
    const top = (at: number) =>
      list.slice(0, at).reduce((sum, one) => sum + lines(one.title, titleWidth(one, columns)), LIST_TOP_LINES)
    const first = top(index + e.by)
    const last = first + lines(target.title, titleWidth(target, columns)) - 1
    const offset = drawnOffset
    const shown = first < offset ? first : last >= offset + e.bodyRows ? last - e.bodyRows + 1 : offset
    const scrolled = await next({ ...e, offset: shown })
    await $.ui.focus({ requestId: PANE, key: target.id })
    return scrolled
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    drawnOffset = e.props.scroll.offset
    drawnColumns = e.props.bodyColumns
    const columns = e.props.bodyColumns
    // The body fills the pane, so the footer sits at its foot.
    const bodyRows = e.props.scroll.bodyRows
    const list = await read($, rows)
    const shown = await read($, view)
    const inProgress = await read($, working)
    const row = shown?.isDetails ? list.find(one => one.id === shown.id) : undefined

    // Only a refresh after the last fix is applied empties an open pane: the
    // command never opens it with nothing to list.
    if (list.length === 0) {
      return (
        <Box flexDirection="column" minHeight={bodyRows}>
          {headerTree(els, columns)}
          <Box marginTop={1} flexGrow={1}>
            <Text dimColor>{EMPTY}</Text>
          </Box>
          {footerTree(els, EMPTY_HINTS, columns)}
        </Box>
      )
    }

    if (row === undefined) {
      const focused = list.some(one => one.id === shown?.id) ? shown?.id : list[0]?.id
      return (
        <Box flexDirection="column" minHeight={bodyRows}>
          {headerTree(els, columns)}
          <Box marginTop={1}>
            <Text dimColor>{`FIXES READY · ${list.length}`}</Text>
          </Box>
          {list.map(one =>
            rowTree(els, {
              row: one,
              isWorking: inProgress?.frictionId === one.id,
              hasFocus: one.id === focused,
              onPress: async () => {
                await update($, view, () => ({ id: one.id, isDetails: true }))
                await openPane($, { rows: detailRows(one, columns), focus: true })
                // Selecting the first fix keeps the details scrolled to their start.
                const first = one.solutions.find(solution => !solution.isImplemented)
                if (first !== undefined) {
                  await $.ui.focus({ requestId: PANE, key: `fix:${first.id}` })
                }
              },
            }),
          )}
          <Box marginTop={1} flexGrow={1}>
            <Text dimColor>{NOTE}</Text>
          </Box>
          {footerTree(els, inProgress === null ? LIST_HINTS : WORKING_HINTS, columns)}
        </Box>
      )
    }

    const color = symbolColor(row.symbol)
    const pickable = row.solutions.filter(solution => !solution.isImplemented)
    return (
      <Box flexDirection="column" minHeight={bodyRows}>
        {headerTree(els, columns)}
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="error">
            FRICTION
          </Text>
          <Text bold>{row.title}</Text>
          <Text dimColor>{`Found ${row.identified}`}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={color} dimColor={color === undefined}>
              {`${row.symbol} ${row.severity}`}
            </Text>
            <Text dimColor>{` · ${impactLabel(row.impact)} · ${occurrences(row)}`}</Text>
          </Text>
          {row.description !== row.title && <Text dimColor>{row.description}</Text>}
        </Box>
        <Box flexDirection="column" marginTop={1} flexGrow={1}>
          <Text bold color="success">
            FIXES FROM TEAMMATES
          </Text>
          {row.solutions.map((solution, i) =>
            fixTree(els, {
              solution,
              number: i + 1,
              isPickable: pickable.includes(solution),
              isRecommended: pickable.length > 1 && solution.id === pickable[0]?.id,
              hasFocus: solution.id === pickable[0]?.id,
              onPress: () => useFix($, row, solution),
            }),
          )}
        </Box>
        {footerTree(els, DETAIL_HINTS, columns)}
      </Box>
    )
  })
}
