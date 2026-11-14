import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { FrictionRow } from '../types'
import { denial } from './fixtures/denial'
import { runTool } from './fixtures/run-tool'

type Api = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CARD_TOOL = 'mcp__quotient__fix_card'
const OUTCOME_TOOL = 'mcp__quotient__fix_outcome'
const THANKS_TOOL = 'mcp__quotient__fix_thanks'
const THANKS_QUESTION = 'Send a thank-you, or type a note below?'
const RECORDED_SHOWN =
  'The operator sees "Fix implemented" under your "✓ Applied." line. Now call fix_thanks with the same solutionId, and write nothing before it.'
const THANKS_OVER = 'The operator has answered. End your turn now: write nothing else.'
const SENT_REPLY = '{"id":"n-1","solutionId":"s-1","createdAt":"2026-11-05T21:00:00.000Z","status":"recorded"}'
const LIST = 'quotient:list-fixes'
const CARD_SHOWN =
  'The card is shown to the operator. Now ask "Apply this fix?" with the AskUserQuestion tool, as the fix-friction skill says, and write nothing before it.'
const CARD = {
  friction: 'Lint passes on commit but fails in CI',
  fix: 'Run ESLint from the repo root in the pre-commit hook',
  file: '.husky/pre-commit',
  removed: ['npx eslint --cache $FILES'],
  added: ['cd "$(git rev-parse --show-toplevel)" && npx eslint --cache $FILES'],
}

const ROW: FrictionRow = {
  id: 'fr-1',
  title: 'Lint passes on commit but fails in CI',
  symbol: '▲',
  severity: 'High',
  status: '2 fixes',
  description: 'Lint passes on commit but fails in CI',
  identified: '2026-10-17',
  frequency: 'Most commits',
  impact: 'A CI round trip each time',
  affectedSessionCount: 12,
  reviewedSessionCount: 86,
  isFixable: true,
  solutions: [
    { id: 's-1', description: 'Run ESLint from the repo root', found: '2026-10-28', isImplemented: false },
    { id: 's-2', description: 'Turn on the shadcn rules', found: '2026-10-29', isImplemented: false },
  ],
  ownFix: null,
}
// Set by a test to make `list_my_frictions` fail.
let rowsFail = false
// Set by a test to sign the operator out after a fix is recorded.
let signedOut = false

const DONE_ROW: FrictionRow = {
  ...ROW,
  status: '1 of 2 done',
  solutions: [{ ...ROW.solutions[0]!, isImplemented: true }, ROW.solutions[1]!],
}

const ALL_DONE_ROW: FrictionRow = {
  ...ROW,
  status: '2 of 2 done',
  isFixable: false,
  solutions: ROW.solutions.map(solution => ({ ...solution, isImplemented: true })),
}

/**
 * Answers the plugin's calls the way the engine would, and records them.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param opts.recorded - How `mark_solution_implemented` replies, call by call: its text and whether it failed
 * @param opts.markRejects - How `mark_solution_implemented` rejects: denied by Claude Code, or failed otherwise
 * @param opts.rowsDenied - Whether Claude Code denies every `list_my_frictions` read after the pane's first
 * @param opts.isAllDoneAfter - Whether every read after the first finds each fix implemented, so nothing is left to fix
 * @returns The tools registered, the Quotient tools called (with a solution's
 *   id after a mark), the status lines set and the debug log's lines
 */
function engine(
  on: On,
  opts: {
    recorded?: { text: string; isError: boolean }[]
    markRejects?: 'denied' | 'failed'
    rowsDenied?: boolean
    // One answer per time the thanks question is asked; null dismisses it.
    thanks?: string | null | (string | null)[]
    isAway?: boolean
    sent?: ({ text: string; isError: boolean } | 'throw')[]
    openPanes?: string[]
    isNoneLeft?: boolean
    isAllDoneAfter?: boolean
  } = {},
) {
  rowsFail = false
  signedOut = false
  const seen = {
    tools: [] as { name: string; isDeferred?: unknown }[],
    asked: [] as string[],
    status: [] as (string | undefined)[],
    questions: [] as unknown[],
    thanks: [] as Record<string, unknown>[],
    toasts: [] as string[],
    opened: [] as Record<string, unknown>[],
    closed: [] as string[],
    debugged: [] as string[],
  }
  const sends = [...(opts.sent ?? [])]
  const records = [...(opts.recorded ?? [])]
  const answers = Array.isArray(opts.thanks) ? [...opts.thanks] : [opts.thanks ?? null]
  on('ui.panes', () => ({
    value: (opts.openPanes ?? []).map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.toast', (_, e) => {
    seen.toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    seen.questions.push((e as unknown as { questions: unknown }).questions)
    const asked = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    const answer = answers.length > 1 ? (answers.shift() ?? null) : (answers[0] ?? null)
    if (answer === null) return { deny: 'dismissed' }
    const away = opts.isAway === true ? { afkTimeoutMs: 60_000 } : {}
    return { result: { questions: [], answers: { [asked]: answer }, ...away } } as never
  })
  let rowReads = 0
  on('tool.register', (_, e) => {
    seen.tools.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__quotient__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    seen.opened.push(e as unknown as Record<string, unknown>)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    if (e.to === 'debug') seen.debugged.push(e.text)
    return { value: undefined }
  })
  on('command.run', () => ({ text: '' }))
  on('mcp.connect', () =>
    signedOut
      ? ({ value: { isConnected: false, reason: 'failed' } } as never)
      : { value: { isConnected: true, server: 'plugin:quotient:agex' } },
  )
  on('mcp.call', (_, e) => {
    if (e.tool === 'send_thank_you') {
      seen.thanks.push(e.args)
      const reply = sends.shift() ?? { text: SENT_REPLY, isError: false }
      if (reply === 'throw') throw new Error('socket hang up')
      return { value: { content: [{ type: 'text', text: reply.text }], isError: reply.isError } }
    }
    // The fix-status part reads the same tool as json on its own, and the
    // thank-yous check runs on its own; both are answered apart, so these
    // tests see only the fix flow's calls.
    if (e.tool === 'list_thank_yous') {
      return { value: { content: [{ type: 'text', text: '{"thankYous":[]}' }], isError: false } }
    }
    if (e.args.format === 'json') {
      return { value: { content: [{ type: 'text', text: '{"frictions":[],"nextCursor":null}' }], isError: false } }
    }
    if (e.tool === 'mark_solution_implemented') {
      seen.asked.push(`${e.tool} ${String(e.args.solutionId)}`)
      if (opts.markRejects === 'denied') return { deny: denial(e.server, e.tool) }
      if (opts.markRejects === 'failed') throw new Error('call failed')
      const reply = records.shift() ?? { text: '{"implementedAt":"2026-11-04T20:00:00.000Z"}', isError: false }
      return { value: { content: [{ type: 'text', text: reply.text }], isError: reply.isError } }
    }
    seen.asked.push(e.tool)
    if (opts.rowsDenied && rowReads > 0) return { deny: denial(e.server, e.tool) }
    if (rowsFail) {
      return { value: { content: [{ type: 'text', text: "Quotient couldn't complete this request" }], isError: true } }
    }
    const isFirst = rowReads++ === 0
    const read = isFirst ? ROW : opts.isAllDoneAfter === true ? ALL_DONE_ROW : DONE_ROW
    const text = JSON.stringify({ frictions: [opts.isNoneLeft === true ? { ...read, isFixable: false } : read], nextCursor: null })
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  return seen
}

/**
 * Calls one of the plugin's tools as the model would. Their names aren't in
 * the generated tool types, which list built-in and connected tools only.
 *
 * @param $ - The engine
 * @param tool - The tool's full name
 * @param toolUseId - The call's id
 * @param input - The tool's input
 * @returns What the call resolved to
 */
function callTool($: Api, tool: string, toolUseId: string, input: Record<string, unknown>) {
  return runTool($, { tool, tool_use_id: toolUseId, ...input })
}

/**
 * Draws a tool's row and returns its joined text.
 *
 * @param $ - The engine
 * @param component - The row's component
 * @param tool - The tool's full name
 * @param toolUseId - The call's id
 * @returns The row's joined text: empty when hidden
 */
async function drawRow($: Api, component: 'ToolUse' | 'ToolResult', tool: string, toolUseId: string) {
  const props =
    component === 'ToolUse'
      ? { tool_use_id: toolUseId, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: '' }
      : { tool_use_id: toolUseId, tool, output: '', isErrored: false }
  const ui = await $.ui.mount({ plugin: 'quotient', surface: 'terminal', component, requestId: toolUseId, props } as Parameters<
    typeof $.ui.mount
  >[0])
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(text => text.text).join('\n')
}

/**
 * Opens the pane and picks the first fix of the friction, as the operator
 * would, so the pane outlines its row.
 *
 * @param $ - The engine
 * @returns The mounted pane
 */
async function pickFix($: Api) {
  await $.command.run({
    command: LIST,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const ui = await $.ui.mount({
    plugin: 'quotient',
    component: 'Pane',
    requestId: 'frictions',
    surface: 'terminal',
    props: {
      title: 'Quotient',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })
  // Opening the details ends by moving the focus ring, which the test kit
  // doesn't hand to a test's hooks.
  await expect(ui.press({ key: 'fr-1' })).rejects.toThrow(/no implementation for ui\.focus/)
  await ui.press({ key: 'fix:s-1' })
  return ui
}

test('the session registers fix_card and fix_outcome in the tool list, not behind ToolSearch', async ($, on) => {
  const seen = engine(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(seen.tools).toContainEqual({ name: 'fix_card', isDeferred: false })
  expect(seen.tools).toContainEqual({ name: 'fix_outcome', isDeferred: false })
  expect(seen.tools).toContainEqual({ name: 'fix_thanks', isDeferred: false })
  expect(seen.tools).toContainEqual({ name: 'setup_start', isDeferred: false })
})

test('fix_card draws the friction, the suggested fix and its file and lines, then asks for the question', async ($, on) => {
  engine(on)

  const called = await callTool($, CARD_TOOL, 'toolu_card', CARD)
  const shown = await drawRow($, 'ToolUse', CARD_TOOL, 'toolu_card')

  expect(called.deny).toBeUndefined()
  expect(called.result).toBe(CARD_SHOWN)
  const parts = [
    'YOUR FRICTION',
    CARD.friction,
    '╌',
    'SUGGESTED FIX',
    "· from a teammate's setup",
    CARD.fix,
    CARD.file,
    `- ${CARD.removed[0]}`,
    `+ ${CARD.added[0]}`,
  ]
  let from = 0
  for (const part of parts) {
    const at = shown.indexOf(part, from)
    expect(at).toBeGreaterThanOrEqual(from)
    from = at + part.length
  }
})

test('a card for a fix that removes nothing draws no - line, and one with no file draws no path', async ($, on) => {
  engine(on)

  await callTool($, CARD_TOOL, 'toolu_add', { friction: CARD.friction, fix: CARD.fix, file: 'CLAUDE.md', added: ['- Sign in as the test user.'] })
  await callTool($, CARD_TOOL, 'toolu_bare', { friction: CARD.friction, fix: CARD.fix })
  const added = await drawRow($, 'ToolUse', CARD_TOOL, 'toolu_add')
  const bare = await drawRow($, 'ToolUse', CARD_TOOL, 'toolu_bare')

  expect(added.split('\n').filter(line => line.startsWith('- '))).toEqual([])
  expect(added).toContain('+ - Sign in as the test user.')
  expect(bare).not.toContain('+ ')
  expect(bare).toContain(CARD.fix)
})

test('fix_card draws a friction and a fix longer than 200 characters whole', async ($, on) => {
  engine(on)
  const friction = `${CARD.friction}, because the hook runs ESLint from the package directory. `.repeat(4)
  const fix = `${CARD.fix}, so the hook and CI read the same config. `.repeat(4)

  const called = await callTool($, CARD_TOOL, 'toolu_long', { friction, fix })
  const shown = await drawRow($, 'ToolUse', CARD_TOOL, 'toolu_long')

  expect(friction.length).toBeGreaterThan(200)
  expect(fix.length).toBeGreaterThan(200)
  expect(called.deny).toBeUndefined()
  expect(shown).toContain(friction)
  expect(shown).toContain(fix)
})

const BAD_CARDS: { name: string; input: Record<string, unknown>; error: RegExp }[] = [
  { name: 'no friction', input: { fix: CARD.fix }, error: /^friction: must be text/ },
  { name: "a teammate's email", input: { ...CARD, fix: 'Ask ron@example.com' }, error: /^fix: must not hold an id or email/ },
  { name: 'a friction id', input: { ...CARD, friction: 'See fr-20261017-3' }, error: /^friction: must not hold an id or email/ },
  { name: 'a line holding a newline', input: { ...CARD, added: ['a\nb'] }, error: /^added\[0\]: must be one line/ },
  { name: 'lines that are not a list', input: { ...CARD, removed: 'old' }, error: /^removed: must be a list of lines/ },
  { name: 'a friction over 1,000 characters', input: { ...CARD, friction: 'x'.repeat(1_001) }, error: /^friction: must be at most 1000 characters/ },
  { name: 'a fix over 1,000 characters', input: { ...CARD, fix: 'x'.repeat(1_001) }, error: /^fix: must be at most 1000 characters/ },
]

for (const { name, input, error } of BAD_CARDS) {
  test(`fix_card refuses ${name}`, async ($, on) => {
    engine(on)

    const called = await callTool($, CARD_TOOL, 'toolu_bad', input)

    expect(called.deny).toMatch(error)
  })
}

test('applying records the fix, says so, updates the pane row and the status line, and clears the outline', async ($, on) => {
  const seen = engine(on)
  const pane = await pickFix($)
  expect((await pane.find({ type: 'Box', key: 'row:fr-1' }))?.props.borderStyle).toBe('round')

  const called = await callTool($, OUTCOME_TOOL, 'toolu_done', { solutionId: 's-1', outcome: 'applied' })
  const shown = await drawRow($, 'ToolUse', OUTCOME_TOOL, 'toolu_done')
  const paneText = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  const outline = (await pane.find({ type: 'Box', key: 'row:fr-1' }))?.props.borderStyle
  await pane.unmount()

  expect(called.result).toBe(RECORDED_SHOWN)
  expect(seen.asked).toEqual(['list_my_frictions', 'mark_solution_implemented s-1', 'list_my_frictions'])
  expect(shown).toContain('Fix implemented')
  expect(shown).toContain("Recorded in Quotient, so it isn't offered again on any of your machines.")
  expect(seen.status).toEqual(['1 fix implemented'])
  expect(paneText).toContain('1 of 2 done')
  expect(paneText).toContain('↑↓ move · Enter open · Esc close')
  expect(outline).toBeUndefined()
})

test('applying the last fix left drops its row, and the open pane says every fix is applied', async ($, on) => {
  engine(on, { isAllDoneAfter: true })
  const pane = await pickFix($)

  await callTool($, OUTCOME_TOOL, 'toolu_done', { solutionId: 's-1', outcome: 'applied' })
  const buttons = await pane.findAll({ type: 'Button' })
  const paneText = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  await pane.unmount()

  expect(buttons.map(button => button.key)).not.toContain('fr-1')
  expect(paneText).not.toContain('2 of 2 done')
  expect(paneText).toContain('All teammate fixes applied. New ones will show up in the status line.')
  expect(paneText).toContain('Esc close')
  expect(paneText).not.toContain('FIXES READY')
  expect(paneText).not.toContain('are listed')
})

const MARK_PREFIXES = ['mcp__plugin_quotient_agex__', 'mcp__claude_ai_Quotient__'] as const

/**
 * Answers the model's own `mark_solution_implemented` call, as the fix-friction
 * skill makes it where quotient's fix tools draw nothing. Register it before
 * the test first calls `$`.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param tool - The tool's full name
 * @param reply - How Quotient answers the call
 * @returns A way to make the call as the model would, and how many calls reached Quotient
 */
function markAsModel(on: On, tool: string, reply: 'recorded' | 'error' | 'denied') {
  let sent = 0
  mock.env(on, {})
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', { tool: tool as 'AskUserQuestion' }, () => {
    sent += 1
    if (reply === 'denied') return { deny: 'denied by a test' }
    if (reply === 'error') return { result: 'failed', text: "Quotient couldn't complete this request", isError: true as const }
    return { result: 'ran', text: '{"implementedAt":"2026-11-04T20:00:00.000Z"}' } as never
  })
  return { call: ($: Api) => callTool($, tool, 'toolu_mark', { solutionId: 's-1' }), sends: () => sent }
}

for (const prefix of MARK_PREFIXES) {
  test(`a fix the model records through ${prefix}mark_solution_implemented drops its row from the open pane`, async ($, on) => {
    engine(on, { isAllDoneAfter: true, openPanes: ['frictions'] })
    const { call, sends } = markAsModel(on, `${prefix}mark_solution_implemented`, 'recorded')
    const pane = await pickFix($)

    const result = await call($)
    const paneText = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
    await pane.unmount()

    expect(result.text).toBe('{"implementedAt":"2026-11-04T20:00:00.000Z"}')
    expect(sends()).toBe(1)
    expect(paneText).toContain('All teammate fixes applied.')
  })
}

test('with the list pane closed, a fix the model records reads no rows, since a rows read marks fixes seen, but still ends the pick', async ($, on) => {
  const seen = engine(on)
  const { call } = markAsModel(on, 'mcp__plugin_quotient_agex__mark_solution_implemented', 'recorded')
  const pane = await pickFix($)

  await call($)
  const other = await callTool($, OUTCOME_TOOL, 'toolu_other', { solutionId: 's-2', outcome: 'skipped' })
  await pane.unmount()

  expect(seen.asked).toEqual(['list_my_frictions'])
  expect(other.deny).toBeUndefined()
})

for (const reply of ['error', 'denied'] as const) {
  test(`a mark_solution_implemented call that is ${reply === 'error' ? 'an error' : 'denied'} leaves the pane's rows unread`, async ($, on) => {
    const seen = engine(on, { isAllDoneAfter: true, openPanes: ['frictions'] })
    const { call, sends } = markAsModel(on, 'mcp__plugin_quotient_agex__mark_solution_implemented', reply)
    const pane = await pickFix($)

    await call($)
    const buttons = await pane.findAll({ type: 'Button' })
    await pane.unmount()

    expect(sends()).toBe(1)
    expect(seen.asked).toEqual(['list_my_frictions'])
    expect(buttons.map(button => button.key)).toContain('fr-1')
  })
}

test('while a fix picked in the pane is in progress, another fix is refused and nothing is recorded', async ($, on) => {
  const seen = engine(on)
  const pane = await pickFix($)

  const called = await callTool($, OUTCOME_TOOL, 'toolu_other', { solutionId: 's-2', outcome: 'applied' })
  const outline = (await pane.find({ type: 'Box', key: 'row:fr-1' }))?.props.borderStyle
  await pane.unmount()

  expect(called.deny).toMatch(/^solutionId: isn't the fix the operator picked in the pane/)
  expect(seen.asked).toEqual(['list_my_frictions'])
  expect(seen.status).toEqual([])
  expect(outline).toBe('round')
})

test('typing /quotient:fix-friction leaves an unfinished pane pick behind, so another fix can be recorded', async ($, on) => {
  const seen = engine(on)
  const pane = await pickFix($)

  await $.command.run({
    command: 'quotient:fix-friction',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const called = await callTool($, OUTCOME_TOOL, 'toolu_other', { solutionId: 's-2', outcome: 'applied' })
  const outline = (await pane.find({ type: 'Box', key: 'row:fr-1' }))?.props.borderStyle
  await pane.unmount()

  expect(called.deny).toBeUndefined()
  expect(seen.asked).toContain('mark_solution_implemented s-2')
  expect(outline).toBeUndefined()
})

/**
 * Describes a quotient command for the typeahead, as the engine would.
 *
 * @param $ - The engine
 * @param command - The command's name, without its slash
 * @returns What the menu would show for it
 */
function describeCommand($: Parameters<TestBody>[0], command: string) {
  return $.command.describe({
    command,
    description: 'A quotient command.',
    isHidden: false,
    immediate: false,
    provider: { plugin: 'quotient', tier: 'user' },
  } as Parameters<typeof $.command.describe>[0])
}

test('the typeahead leaves out /quotient:fix-friction, which /list-fixes starts with the ids it needs', async ($, on) => {
  engine(on)
  on('command.describe', (_, e) => ({ description: e.description, isHidden: e.isHidden }))

  const fix = await describeCommand($, 'quotient:fix-friction')
  const list = await describeCommand($, LIST)

  expect(fix).toEqual({ description: 'A quotient command.', isHidden: true })
  expect(list).toEqual({ description: 'A quotient command.', isHidden: false })
})

test('running /quotient:list-fixes again clears an unfinished pane pick', async ($, on) => {
  engine(on)
  const pane = await pickFix($)

  await $.command.run({
    command: LIST,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const outline = (await pane.find({ type: 'Box', key: 'row:fr-1' }))?.props.borderStyle
  const shown = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  await pane.unmount()

  expect(outline).toBeUndefined()
  expect(shown).toContain('↑↓ move · Enter open · Esc close')
})

test('running /quotient:list-fixes again ends an unfinished pick even when the list falls back to text', async ($, on) => {
  const seen = engine(on)
  await pickFix($)
  rowsFail = true

  await $.command.run({
    command: LIST,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  const called = await callTool($, OUTCOME_TOOL, 'toolu_other', { solutionId: 's-2', outcome: 'applied' })

  expect(called.deny).toBeUndefined()
  expect(seen.asked).toContain('mark_solution_implemented s-2')
})

test('a second fix applied counts both on the status line', async ($, on) => {
  const seen = engine(on)

  await callTool($, OUTCOME_TOOL, 'toolu_1', { solutionId: 's-1', outcome: 'applied' })
  await callTool($, OUTCOME_TOOL, 'toolu_2', { solutionId: 's-2', outcome: 'applied' })

  expect(seen.status).toEqual(['1 fix implemented', '2 fixes implemented'])
})

test('skipping records nothing, says it stays listed, and clears the outline', async ($, on) => {
  const seen = engine(on)
  const pane = await pickFix($)

  const called = await callTool($, OUTCOME_TOOL, 'toolu_skip', { solutionId: 's-1', outcome: 'skipped' })
  const shown = await drawRow($, 'ToolUse', OUTCOME_TOOL, 'toolu_skip')
  const outline = (await pane.find({ type: 'Box', key: 'row:fr-1' }))?.props.borderStyle
  await pane.unmount()

  expect(called.result).toBe('The operator sees that the fix was skipped. End your turn without writing anything else.')
  expect(shown).toBe('Skipped. It stays in /list-fixes.')
  expect(seen.asked).toEqual(['list_my_frictions'])
  expect(seen.status).toEqual([])
  expect(outline).toBeUndefined()
})

test("a failed record says the fix may not be recorded, asks the model to offer a retry, and leaves the status line", async ($, on) => {
  const seen = engine(on, { recorded: [{ text: "Quotient couldn't complete this request right now. Try again in a moment.", isError: true }] })
  const pane = await pickFix($)

  const called = await callTool($, OUTCOME_TOOL, 'toolu_fail', { solutionId: 's-1', outcome: 'applied' })
  const shown = await drawRow($, 'ToolUse', OUTCOME_TOOL, 'toolu_fail')
  const outline = (await pane.find({ type: 'Box', key: 'row:fr-1' }))?.props.borderStyle
  await pane.unmount()

  expect(called.result).toMatch(/^Quotient may not have recorded the fix: Quotient couldn't complete this request/)
  expect(called.result).toMatch(/offer to retry/)
  expect(shown).toContain('Fix applied, may not be recorded')
  expect(shown).not.toContain('Fix implemented')
  expect(seen.status).toEqual([])
  // The row stays outlined until the fix is recorded or skipped.
  expect(outline).toBe('round')
})

test("a failed record whose reply names the fix's id shows no id", async ($, on) => {
  engine(on, { recorded: [{ text: 'None of your frictions has a fix with the id s-1', isError: true }] })

  const called = await callTool($, OUTCOME_TOOL, 'toolu_fail', { solutionId: 's-1', outcome: 'applied' })
  const shown = await drawRow($, 'ToolUse', OUTCOME_TOOL, 'toolu_fail')

  expect(called.result).not.toContain('s-1')
  expect(shown).not.toContain('s-1')
  expect(shown).toContain('Quotient refused it')
})

test('a record Claude Code denied says so in the row, and the debug log has the reason', async ($, on) => {
  const seen = engine(on, { markRejects: 'denied' })

  const called = await callTool($, OUTCOME_TOOL, 'toolu_denied', { solutionId: 's-1', outcome: 'applied' })
  const shown = await drawRow($, 'ToolUse', OUTCOME_TOOL, 'toolu_denied')

  expect(shown).toContain('Claude Code denied the call to Quotient')
  expect(called.result).toMatch(/^Quotient may not have recorded the fix: Claude Code denied the call to Quotient/)
  expect(shown).not.toContain('refused:')
  expect(String(called.result)).not.toContain('refused:')
  expect(seen.debugged.filter(line => line.startsWith('quotient fix: mark_solution_implemented denied: '))).toHaveLength(1)
})

test("a record that rejects otherwise says Quotient couldn't be reached, and the debug log has the reason", async ($, on) => {
  const seen = engine(on, { markRejects: 'failed' })

  await callTool($, OUTCOME_TOOL, 'toolu_failed', { solutionId: 's-1', outcome: 'applied' })
  const shown = await drawRow($, 'ToolUse', OUTCOME_TOOL, 'toolu_failed')

  expect(shown).toContain("Quotient couldn't be reached")
  expect(seen.debugged.filter(line => line.startsWith('quotient fix: mark_solution_implemented failed: '))).toHaveLength(1)
})

test('a re-read of the rows Claude Code denied keeps the rows, and the debug log has the reason', async ($, on) => {
  const seen = engine(on, { rowsDenied: true })
  const pane = await pickFix($)

  await callTool($, OUTCOME_TOOL, 'toolu_done', { solutionId: 's-1', outcome: 'applied' })
  const paneText = (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')
  await pane.unmount()

  expect(paneText).not.toContain('1 of 2 done')
  expect(seen.debugged.filter(line => line.startsWith('quotient fix: list_my_frictions denied: '))).toHaveLength(1)
})

test('a re-read of the rows that is not usable keeps the rows, and the debug log says so', async ($, on) => {
  const seen = engine(on)
  const pane = await pickFix($)
  rowsFail = true

  await callTool($, OUTCOME_TOOL, 'toolu_done', { solutionId: 's-1', outcome: 'applied' })
  await pane.unmount()

  expect(seen.debugged).toContain('quotient fix: list_my_frictions gave no usable page')
})

const BAD_OUTCOMES: { name: string; input: Record<string, unknown>; error: RegExp }[] = [
  { name: 'an id with a slash', input: { solutionId: '../s-1', outcome: 'applied' }, error: /^solutionId:/ },
  { name: 'an id with a space', input: { solutionId: 's-1 s-2', outcome: 'applied' }, error: /^solutionId:/ },
  { name: 'an unknown outcome', input: { solutionId: 's-1', outcome: 'partly' }, error: /^outcome:/ },
]

for (const { name, input, error } of BAD_OUTCOMES) {
  test(`fix_outcome refuses ${name} without calling Quotient`, async ($, on) => {
    const seen = engine(on)

    const called = await callTool($, OUTCOME_TOOL, 'toolu_bad', input)

    expect(called.deny).toMatch(error)
    expect(seen.asked).toEqual([])
  })
}

test("a fix tool's result row is hidden, since its own row draws what it came to", async ($, on) => {
  engine(on)

  await callTool($, CARD_TOOL, 'toolu_card', CARD)

  expect(await drawRow($, 'ToolResult', CARD_TOOL, 'toolu_card')).toBe('')
})

test('the status line keeps a running setup over the count of fixes implemented', async ($, on) => {
  const seen = engine(on)
  await $.command.run({
    command: 'quotient:setup',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  await callTool($, OUTCOME_TOOL, 'toolu_done', { solutionId: 's-1', outcome: 'applied' })

  expect(seen.status).toEqual(['setup is getting ready…', 'setup is getting ready…'])
})

const LEAD = "This fix came from a teammate's setup. Want to say thanks?"
const LEAD_DIM = "They'll see it the next time they send Claude a prompt."

/**
 * Records a fix as the fix-friction skill would, so a thank-you is due for it.
 *
 * @param $ - The engine
 * @param solutionId - The solution's id
 */
async function recordFix($: Api, solutionId = 's-1') {
  await callTool($, OUTCOME_TOOL, `toolu_done_${solutionId}`, { solutionId, outcome: 'applied' })
}

test('after a recorded fix, fix_thanks says where the fix came from and asks the question with its options in order', async ($, on) => {
  const seen = engine(on, { thanks: 'Skip' })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
  const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')

  expect(called.deny).toBeUndefined()
  expect(seen.questions).toEqual([
    [
      {
        question: THANKS_QUESTION,
        header: 'Thanks',
        options: [
          { label: 'Send a high-five (Recommended)', description: '' },
          { label: 'Skip', description: '' },
        ],
        multiSelect: false,
      },
    ],
  ])
  expect(shown).toContain(LEAD)
  expect(shown).toContain(LEAD_DIM)
  expect(shown.indexOf(LEAD)).toBeLessThan(shown.indexOf(LEAD_DIM))
})

for (const [name, answer] of [
  ['Skip', 'Skip'],
  ['dismissing the question', null],
] as const) {
  test(`${name} sends nothing, shows nothing more, and ends the turn`, async ($, on) => {
    const seen = engine(on, { thanks: answer })
    await recordFix($)

    const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
    const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')

    expect(called.result).toBe(THANKS_OVER)
    expect(seen.thanks).toEqual([])
    expect(shown).not.toContain('sent')
    expect(shown).not.toContain("couldn't")
  })
}

test('fix_thanks is refused before any fix is recorded, without asking', async ($, on) => {
  const seen = engine(on, { thanks: 'Skip' })

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(called.deny).toMatch(/^solutionId:/)
  expect(seen.questions).toEqual([])
})

test('fix_thanks is refused after a skipped fix', async ($, on) => {
  const seen = engine(on, { thanks: 'Skip' })
  await callTool($, OUTCOME_TOOL, 'toolu_skip', { solutionId: 's-1', outcome: 'skipped' })

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(called.deny).toMatch(/^solutionId:/)
  expect(seen.questions).toEqual([])
})

test('fix_thanks is refused after a record that may have failed, so a failed record never leads to thanks', async ($, on) => {
  const seen = engine(on, { thanks: 'Skip', recorded: [{ text: "Quotient couldn't complete this request", isError: true }] })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(called.deny).toMatch(/^solutionId:/)
  expect(seen.questions).toEqual([])
})

test('fix_thanks is refused for a fix other than the one just recorded', async ($, on) => {
  const seen = engine(on, { thanks: 'Skip' })
  await recordFix($, 's-1')

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-2' })

  expect(called.deny).toMatch(/^solutionId:/)
  expect(seen.questions).toEqual([])
})

test('the operator is asked once per fix: a second fix_thanks after answering is refused', async ($, on) => {
  const seen = engine(on, { thanks: 'Skip' })
  await recordFix($)
  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  const again = await callTool($, THANKS_TOOL, 'toolu_again', { solutionId: 's-1' })

  expect(again.deny).toMatch(/^solutionId:/)
  expect(seen.questions).toHaveLength(1)
})

test('fix_thanks refuses an id that is not a plain id', async ($, on) => {
  engine(on, { thanks: 'Skip' })

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: '../s-1' })

  expect(called.deny).toMatch(/^solutionId:/)
})

test("fix_thanks's result row is hidden", async ($, on) => {
  engine(on, { thanks: 'Skip' })
  await recordFix($)
  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(await drawRow($, 'ToolResult', THANKS_TOOL, 'toolu_thanks')).toBe('')
})

const HIGH_FIVE = 'Send a high-five (Recommended)'

test('a high-five sends one thank-you with only the fix, shows a toast, and writes nothing more', async ($, on) => {
  const seen = engine(on, { thanks: HIGH_FIVE })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
  const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')
  const again = await callTool($, THANKS_TOOL, 'toolu_again', { solutionId: 's-1' })

  expect(called.result).toBe(THANKS_OVER)
  expect(seen.thanks).toEqual([{ solutionId: 's-1' }])
  expect(seen.toasts).toEqual(['High-five sent'])
  expect(shown).toContain(LEAD)
  expect(shown).not.toContain('✓')
  expect(shown).not.toContain("couldn't")
  expect(again.deny).toMatch(/^solutionId:/)
})

test('a fix already thanked counts as sent', async ($, on) => {
  const seen = engine(on, {
    thanks: HIGH_FIVE,
    sent: [{ text: SENT_REPLY.replace('"recorded"', '"alreadyRecorded"'), isError: false }],
  })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(called.result).toBe(THANKS_OVER)
  expect(seen.toasts).toEqual(['High-five sent'])
})

const FAILED_SENDS: { name: string; sent?: { text: string; isError: boolean } | 'throw'; signedOutAfter?: boolean; reason: string }[] = [
  {
    name: 'an error reply',
    sent: { text: "Quotient couldn't complete this request right now.", isError: true },
    reason: "Quotient couldn't complete this request right now.",
  },
  {
    name: "an error reply naming the fix's id",
    sent: { text: "None of your frictions has a teammate's fix with the id s-1.", isError: true },
    reason: 'Quotient refused it',
  },
  { name: 'a call that throws', sent: 'throw', reason: "Quotient couldn't be reached" },
  { name: 'a reply that cannot be read', sent: { text: 'ok', isError: false }, reason: "Quotient's reply couldn't be read" },
  { name: 'being signed out', signedOutAfter: true, reason: "you aren't signed in to Quotient" },
]

for (const { name, sent, signedOutAfter, reason } of FAILED_SENDS) {
  test(`after ${name}, the thanks isn't confirmed, no id is shown, and the model offers a retry`, async ($, on) => {
    const seen = engine(on, { thanks: HIGH_FIVE, ...(sent === undefined ? {} : { sent: [sent] }) })
    await recordFix($)
    // Signed out only after the record, which needs the server.
    signedOut = signedOutAfter === true

    const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
    const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')

    expect(called.result).toMatch(/^The thanks couldn't be sent: /)
    expect(called.result).toContain(reason)
    expect(called.result).toMatch(/offer to retry/)
    expect(called.result).not.toContain('s-1')
    expect(shown).toContain(`The thanks couldn't be sent: ${reason}`)
    expect(shown).not.toContain('s-1')
    expect(seen.toasts).toEqual([])
  })
}

test('a retry after a failed send sends the same choice again without asking twice', async ($, on) => {
  const seen = engine(on, { thanks: HIGH_FIVE, sent: ['throw'] })
  await recordFix($)
  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  const retried = await callTool($, THANKS_TOOL, 'toolu_retry', { solutionId: 's-1' })
  const retryRow = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_retry')

  expect(retried.result).toBe(THANKS_OVER)
  expect(seen.questions).toHaveLength(1)
  expect(seen.thanks).toEqual([{ solutionId: 's-1' }, { solutionId: 's-1' }])
  expect(seen.toasts).toEqual(['High-five sent'])
  expect(retryRow).not.toContain(LEAD)
})

const EMPTY_NOTE = 'Write a few words, or choose Skip.'
const LONG_NOTE = 'Keep it under 80 characters, or choose Skip.'

/**
 * The questions the engine was asked, by their text.
 *
 * @param seen - What the engine recorded
 * @returns Each question's text, in order
 */
function questionTexts(seen: ReturnType<typeof engine>) {
  return (seen.questions as { question: string }[][]).map(([one]) => one?.question)
}

test('a note typed as the answer is sent exactly as typed, with no pane opened, and the row says it was sent', async ($, on) => {
  const seen = engine(on, { thanks: '  Thanks, this fixed my CI failures!\n' })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
  const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')

  expect(called.result).toBe(THANKS_OVER)
  expect(seen.thanks).toEqual([{ solutionId: 's-1', message: '  Thanks, this fixed my CI failures!\n' }])
  expect(seen.opened).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(shown).toContain('✓ Note sent.')
  expect(shown.indexOf(LEAD)).toBeLessThan(shown.indexOf('✓ Note sent.'))
})

for (const [name, text, error] of [
  ['a note of only spaces', ' \n  ', EMPTY_NOTE],
  ['a note over 80 characters', 'a'.repeat(81), LONG_NOTE],
] as const) {
  test(`${name} asks again saying why, and sends only the note answered next`, async ($, on) => {
    const seen = engine(on, { thanks: [text, 'Thanks!'] })
    await recordFix($)

    const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

    expect(called.result).toBe(THANKS_OVER)
    expect(questionTexts(seen)).toEqual([THANKS_QUESTION, `${error} ${THANKS_QUESTION}`])
    expect(seen.thanks).toEqual([{ solutionId: 's-1', message: 'Thanks!' }])
  })
}

test('a note that is asked again can still be skipped', async ($, on) => {
  const seen = engine(on, { thanks: ['a'.repeat(81), 'Skip'] })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(called.result).toBe(THANKS_OVER)
  expect(seen.questions).toHaveLength(2)
  expect(seen.thanks).toEqual([])
})

test('a note of exactly 80 characters is sent', async ($, on) => {
  const seen = engine(on, { thanks: 'a'.repeat(80) })
  await recordFix($)

  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(seen.thanks).toEqual([{ solutionId: 's-1', message: 'a'.repeat(80) }])
})

test('a note answered for the operator while they were away counts as Skip, so nothing is sent', async ($, on) => {
  const seen = engine(on, { thanks: 'Thanks!', isAway: true })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(called.result).toBe(THANKS_OVER)
  expect(seen.thanks).toEqual([])
})

test('a retry after a failed note resends the same note without asking again', async ($, on) => {
  const seen = engine(on, { thanks: 'Thanks!', sent: ['throw'] })
  await recordFix($)
  const failed = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  const retried = await callTool($, THANKS_TOOL, 'toolu_retry', { solutionId: 's-1' })
  const retryRow = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_retry')

  expect(failed.result).toMatch(/^The thanks couldn't be sent: /)
  expect(retried.result).toBe(THANKS_OVER)
  expect(seen.questions).toHaveLength(1)
  expect(seen.thanks).toEqual([
    { solutionId: 's-1', message: 'Thanks!' },
    { solutionId: 's-1', message: 'Thanks!' },
  ])
  expect(retryRow).toContain('✓ Note sent.')
})

const CLOSING_IN_PANE = 'Your other fixes are still in the side pane. Run /list-fixes to open it again anytime.'
const CLOSING = 'You have other fixes waiting. Run /list-fixes to see them.'

test('with other fixes left and no pane open, the row ends by saying where to find them', async ($, on) => {
  engine(on, { thanks: HIGH_FIVE })
  await recordFix($)

  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
  const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')

  expect(shown).toContain(CLOSING)
  expect(shown).not.toContain(CLOSING_IN_PANE)
  expect(shown.indexOf(LEAD_DIM)).toBeLessThan(shown.indexOf(CLOSING))
})

test('with other fixes left and the list pane open, the row says they are still in the side pane', async ($, on) => {
  engine(on, { thanks: 'Skip', openPanes: ['frictions'] })
  await recordFix($)

  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
  const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')

  expect(shown).toContain(CLOSING_IN_PANE)
})

test('with no other fixes left, the flow ends with no closing line', async ($, on) => {
  engine(on, { thanks: 'Thanks!', isNoneLeft: true })
  await recordFix($)
  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  const shown = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')

  expect(shown).toContain('✓ Note sent.')
  expect(shown).not.toContain('/list-fixes')
})

test('a failed send shows no closing line, and the retry that sends it does', async ($, on) => {
  engine(on, { thanks: HIGH_FIVE, sent: ['throw'] })
  await recordFix($)

  await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })
  await callTool($, THANKS_TOOL, 'toolu_retry', { solutionId: 's-1' })
  const failedRow = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_thanks')
  const retryRow = await drawRow($, 'ToolUse', THANKS_TOOL, 'toolu_retry')

  expect(failedRow).not.toContain('/list-fixes')
  expect(retryRow).toContain(CLOSING)
})

test('a fix whose record fails and then succeeds on retry is offered a thank-you', async ($, on) => {
  const seen = engine(on, { thanks: 'Skip', recorded: [{ text: "Quotient couldn't complete this request", isError: true }] })
  await callTool($, OUTCOME_TOOL, 'toolu_fail', { solutionId: 's-1', outcome: 'applied' })

  const retried = await callTool($, OUTCOME_TOOL, 'toolu_retry', { solutionId: 's-1', outcome: 'applied' })
  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(retried.result).toBe(RECORDED_SHOWN)
  expect(called.deny).toBeUndefined()
  expect(seen.questions).toHaveLength(1)
})

test('a question answered for the operator while they were away counts as Skip, so nothing is sent', async ($, on) => {
  const seen = engine(on, { thanks: HIGH_FIVE, isAway: true })
  await recordFix($)

  const called = await callTool($, THANKS_TOOL, 'toolu_thanks', { solutionId: 's-1' })

  expect(called.result).toBe(THANKS_OVER)
  expect(seen.thanks).toEqual([])
  expect(seen.toasts).toEqual([])
})
