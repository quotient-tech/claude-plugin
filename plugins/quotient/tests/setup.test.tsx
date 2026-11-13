import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const SUMMARY_TOOL = 'mcp__quotient__setup_summary'
const CONFIG = '/home/op/.claude'
const PROJECTS = `${CONFIG}/projects`
// The plugin's own Quotient server, and the connector a cloud session reaches it through.
const AGEX = 'mcp__plugin_quotient_agex__'
const CONNECTOR = 'mcp__claude_ai_Quotient__'
const START_TOOL = 'mcp__quotient__setup_start'
const GO_ON = 'The start message is shown to the operator. Go on with the review, and write no text until the summary.'
const START = { sessions: 64, automatedRuns: 3, cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' }
// The last two weeks' transcripts quotient counts for setup_start: 64
// sessions and 3 automated runs, beside a probe run from a temporary folder,
// a daily run, and two sessions that started with one of quotient's skills,
// which it leaves out.
const SESSION_FILES = Array.from({ length: 67 }, (_, i) => `/home/op/.claude/projects/-repo/s${i}.jsonl`)
const AUTOMATED = SESSION_FILES.slice(0, 3)
const QUOTIENT_STARTED = ['/home/op/.claude/projects/-repo/setup.jsonl', '/home/op/.claude/projects/-repo/fix.jsonl']
const TRANSCRIPTS = [
  ...SESSION_FILES,
  ...QUOTIENT_STARTED,
  '/home/op/.claude/projects/-private-tmp-claude-501-scratchpad-probe/p.jsonl',
  '/home/op/.claude/projects/-home-op--local-share-quotient/d.jsonl',
]
const END_TURN = 'The summary is shown to the operator. End your turn now without writing anything else.'
const LIST_FIXES_HINT = "When your teammates' agents find fixes, run /list-fixes to see them."
const END_TURN_WITH_HINT = `The summary is shown to the operator. Its last line reads: "${LIST_FIXES_HINT}" End your turn now without writing anything else.`

const SAVED = {
  frictions: 5,
  working: ['Agents found the right file on the first try in 41 of 64 sessions'],
  top: [
    { severity: 'high', description: 'Lint passes on commit but fails in CI', impact: 'QUALITY', sessions: 9 },
    { severity: 'high', description: 'Agents can not sign in to the local app', impact: 'BLOCKED', sessions: 7 },
    { severity: 'medium', description: 'zsh quoting breaks shell commands', impact: 'TIME', sessions: 4 },
  ],
  remainingHigh: 1,
  inCommon: 'Two of your top three involve your CI and local setup.',
} as const

/**
 * Answers the plugin's calls the way the engine would, and records them.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param opts.reviewed - The `reviewedSources` in `start_setup_run`'s reply
 * @param opts.joinedCompany - The `joinedCompany` in `start_setup_run`'s reply, left out when absent
 * @param opts.failing - A Quotient tool whose call reports an error
 * @param opts.runFails - Whether running a process rejects
 * @param opts.newFixes - How many frictions the fix-status part's read finds
 * @param opts.teammates - The teammate frictions `list_teammate_frictions` lists
 * @param opts.findExit - The exit code of the `find` that lists the transcripts, 0 when absent
 * @param opts.invite - What `get_invite_link` replies, or 'throw' for a call that fails; `{}` when absent
 * @param opts.connected - What connecting to the plugin's server resolves to, when it isn't connected
 * @param opts.share - The answer to "Copy to share", or null when it's dismissed
 * @param opts.isAway - Whether that answer came while the operator was away
 * @param opts.isCopied - Whether the copy reaches the clipboard, true when absent
 * @returns The tools the plugin registered, the commands it ran, and the subagents it started
 */
function engine(
  on: On,
  opts: {
    reviewed?: string[]
    joinedCompany?: unknown
    failing?: string
    runFails?: boolean
    transcripts?: string[]
    newFixes?: number
    teammates?: { id: string; title: string }[]
    env?: Record<string, string>
    teammateFiles?: string[]
    teammateGrepFails?: boolean
    automated?: string[]
    prompts?: Record<string, string>
    contents?: Record<string, string>
    hugeLine?: number
    laterTeammateFiles?: string[]
    remote?: Record<string, unknown>
    routineIds?: Record<string, string[]>
    agents?: { id: string; type: string; status: 'running' | 'completed' }[]
    refused?: string[]
    findExit?: number
    invite?: { text: string; isError?: boolean } | 'throw'
    connected?: { isConnected: false; reason: string }
    share?: string | null
    isAway?: boolean
    isCopied?: boolean
  } = {},
) {
  const seen = {
    mcpCalls: [] as { server: string; tool: string }[],
    questions: [] as unknown[],
    copied: [] as string[],
    tools: [] as { name: string; isDeferred?: unknown }[],
    argv: [] as (readonly string[])[],
    status: [] as (string | undefined)[],
    logs: [] as string[],
    debug: [] as string[],
    spawned: [] as { subagentType: string; prompt: string }[],
  }
  // An operator's session: not a daily run, so quotient's sandbox doesn't hold.
  mock.env(on, { HOME: '/home/op', ...opts.env })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.register', (_, e) => {
    seen.tools.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__quotient__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.log', (_, e) => {
    if (e.to === 'debug') seen.debug.push(e.text)
    else seen.logs.push(e.text)
    return { value: undefined }
  })
  // The subagent setup starts for its teammate check.
  on('agent.list', () => ({
    value: (opts.agents ?? [{ id: TEAMMATE_AGENT, type: 'quotient:teammate-check', status: 'running' }]).map(agent => ({
      ...agent,
      description: 'check',
    })),
  }))
  on('mcp.connect', () => ({ value: opts.connected ?? { isConnected: true, server: 'plugin:quotient:agex' } }) as never)
  on('agent.spawn', (_, e) => {
    seen.spawned.push({ subagentType: e.subagentType, prompt: e.prompt })
    return { model: 'claude-test' }
  })
  on('mcp.call', (_, e) => {
    seen.mcpCalls.push({ server: e.server, tool: e.tool })
    if (e.tool === 'get_invite_link' && opts.invite !== undefined) {
      if (opts.invite === 'throw') throw new Error('socket hang up')
      return { value: { content: [{ type: 'text', text: opts.invite.text }], isError: opts.invite.isError ?? false } }
    }
    const fix = { isOwn: false, implementedAt: null, viewedAt: null }
    const frictions = Array.from({ length: opts.newFixes ?? 0 }, () => ({ solutions: [fix] }))
    const text = e.tool === 'list_my_frictions' ? JSON.stringify({ frictions, nextCursor: null }) : '{}'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    seen.questions.push((e as unknown as { questions: unknown }).questions)
    const answer = opts.share ?? null
    if (answer === null) return { deny: 'dismissed' }
    const away = opts.isAway === true ? { afkTimeoutMs: 60_000 } : {}
    return { result: { questions: [], answers: { 'Copy to share': answer }, ...away } } as never
  })
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)
    const isCopied = opts.isCopied ?? true
    return { value: isCopied ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } } as never
  })
  on('tool.call', (_, e) => {
    const tool = e.tool as string
    if (opts.failing !== undefined && tool.endsWith(`__${opts.failing}`)) {
      return { result: 'failed', text: 'Quotient could not complete this request.', isError: true }
    }
    if (tool === 'RemoteTrigger' && opts.remote !== undefined) return { result: opts.remote }
    if (tool.endsWith('__list_teammate_frictions')) {
      return { result: 'ran', text: JSON.stringify({ frictions: opts.teammates ?? TEAMMATES, nextCursor: null }) }
    }
    if (tool.endsWith('__submit_solutions') && opts.refused !== undefined) {
      const sent = (e as unknown as { answers: { frictionId: string }[] }).answers
      const answers = sent.map(({ frictionId }) =>
        opts.refused?.includes(frictionId)
          ? { frictionId, status: 'refused', reason: 'Quotient could not find this friction.' }
          : { frictionId, status: 'recorded' },
      )
      return { result: 'ran', text: JSON.stringify({ answers }) }
    }
    if (tool.endsWith('__start_setup_run')) {
      const reply = {
        runId: 'run-1',
        startedAt: '2026-10-29T12:00:00Z',
        reviewedSources: opts.reviewed ?? [],
        ...(opts.joinedCompany === undefined ? {} : { joinedCompany: opts.joinedCompany }),
      }
      return { result: 'ran', text: JSON.stringify(reply) }
    }
    return { result: 'ran' }
  })
  on('command.run', () => ({ text: 'the setup skill ran' }))
  on('process.run', (_, e) => {
    seen.argv.push(e.argv)
    if (opts.runFails) throw new Error('spawn failed')
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'find') return answer((opts.transcripts ?? TRANSCRIPTS).join('\n') + '\n', opts.findExit)
    if (e.argv[0] === 'grep' && e.argv.includes('"entrypoint":"sdk-')) {
      return answer((opts.automated ?? AUTOMATED).filter(file => e.argv.includes(file)).join('\n') + '\n')
    }
    // Prints a range of a transcript's lines; a line past 4 MiB cuts the output short.
    if (e.argv[0] === 'sed') {
      const [from, to] = (e.argv[2] ?? '').replace('p', '').split(',').map(Number) as [number, number]
      const lines = (opts.contents?.[e.argv[3] ?? ''] ?? '').split('\n').filter(line => line !== '').slice(from - 1, to)
      const huge = opts.hugeLine === undefined ? -1 : opts.hugeLine - from
      if (huge >= 0 && huge < lines.length) {
        const value = { exitCode: 0, stdout: lines.slice(0, huge).join('\n'), stderr: '', isStdoutTruncated: true, isStderrTruncated: false }
        return { value }
      }
      return answer(lines.map(line => `${line}\n`).join(''))
    }
    // One awk prints a line's length, the other the sessions quotient's own skills started.
    if (e.argv[0] === 'awk' && (e.argv[1] ?? '').startsWith('NR ==')) return answer('5000000\n')
    if (e.argv[0] === 'awk') return answer(QUOTIENT_STARTED.filter(file => e.argv.includes(file)).join('\n') + '\n')
    if (e.argv[0] === 'grep' && e.argv.includes('-q')) {
      return answer('', (opts.laterTeammateFiles ?? []).includes(e.argv.at(-1) ?? '') ? 0 : 1)
    }
    // Lists the files it's given, newest first: here, in the order given.
    if (e.argv[0] === 'ls') return answer(e.argv.filter(arg => arg.startsWith('/')).join('\n') + '\n')
    if (e.argv[0] === 'grep' && e.argv.includes('-ohE')) {
      const found = Object.entries(opts.routineIds ?? {}).filter(([file]) => e.argv.includes(file))
      return answer(found.flatMap(([, ids]) => ids).join('\n') + '\n', found.length === 0 ? 1 : 0)
    }
    if (e.argv[0] === 'grep' && e.argv.includes('-o')) {
      const prompts = Object.entries(opts.prompts ?? {}).filter(([file]) => e.argv.includes(file))
      return answer(prompts.map(([file, prompt]) => `${file}:"role":"user","content":"${prompt}`).join('\n') + '\n')
    }
    if (e.argv[0] === 'grep') {
      if (opts.teammateGrepFails) return answer('', 2)
      const held = (opts.teammateFiles ?? []).filter(file => e.argv.includes(file))
      return answer(held.length === 0 ? '' : held.join('\n') + '\n', held.length === 0 ? 1 : 0)
    }
    return {
      value: {
        exitCode: 0,
        stdout: `${CONFIG}\n/home/op\n/home/op/.local/share/quotient\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
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
function callTool($: Parameters<TestBody>[0], tool: string, toolUseId: string, input: Record<string, unknown>) {
  return $.tool.call({ tool, tool_use_id: toolUseId, ...input } as unknown as Parameters<typeof $.tool.call>[0])
}

/**
 * Calls `setup_summary` as the model would.
 *
 * @param $ - The engine
 * @param input - The tool's input
 * @returns What the call resolved to
 */
function callSummary($: Parameters<TestBody>[0], input: Record<string, unknown>) {
  return callTool($, SUMMARY_TOOL, 'toolu_summary', input)
}

test('the session registers setup_start and setup_summary in the tool list, not behind ToolSearch', async ($, on) => {
  const seen = engine(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(seen.tools).toContainEqual({ name: 'setup_summary', isDeferred: false })
  expect(seen.tools).toContainEqual({ name: 'setup_start', isDeferred: false })
})

test('a summary with frictions answers with the /list-fixes hint and the instruction to end the turn', async ($, on) => {
  engine(on)

  const called = await callSummary($, SAVED)

  expect(called.deny).toBeUndefined()
  expect(called.result).toBe(END_TURN_WITH_HINT)
})

test('a summary with no new frictions answers with only the instruction to end the turn', async ($, on) => {
  engine(on)

  const called = await callSummary($, { frictions: 0, working: [], top: [], remainingHigh: 0 })

  expect(called.deny).toBeUndefined()
  expect(called.result).toBe(END_TURN)
})

for (const [why, change, message] of [
  ['a fractional count', { frictions: 2.5 }, 'frictions: must be a whole number of at least 0'],
  ['a negative count', { frictions: -1 }, 'frictions: must be a whole number of at least 0'],
  ['four working items', { working: ['a', 'b', 'c', 'd'] }, 'working: must hold at most 3 items'],
  ['a working item that is not text', { working: [3] }, 'working[0]: must be text'],
  [
    'fewer top frictions than the count calls for',
    { top: SAVED.top.slice(0, 2) },
    'top: must hold 3 items when frictions is 5',
  ],
  [
    'an unknown severity',
    { top: [{ ...SAVED.top[0], severity: 'critical' }, SAVED.top[1], SAVED.top[2]] },
    'top[0].severity: must be high, medium or low',
  ],
  [
    'a friction with no impact',
    { top: [{ ...SAVED.top[0], impact: undefined }, SAVED.top[1], SAVED.top[2]] },
    'top[0].impact: must be one of SAFETY, QUALITY, BLOCKED, OPERATOR_ATTENTION, COST or TIME',
  ],
  [
    'an unknown impact',
    { top: [SAVED.top[0], { ...SAVED.top[1], impact: 'CRITICAL' }, SAVED.top[2]] },
    'top[1].impact: must be one of SAFETY, QUALITY, BLOCKED, OPERATOR_ATTENTION, COST or TIME',
  ],
  [
    'a freeform impact',
    { top: [SAVED.top[0], SAVED.top[1], { ...SAVED.top[2], impact: 'About 15 minutes lost' }] },
    'top[2].impact: must be one of SAFETY, QUALITY, BLOCKED, OPERATOR_ATTENTION, COST or TIME',
  ],
  [
    'a friction seen in no sessions',
    { top: [{ ...SAVED.top[0], sessions: 0 }, SAVED.top[1], SAVED.top[2]] },
    'top[0].sessions: must be a whole number of at least 1',
  ],
  ['more remaining high frictions than remain', { remainingHigh: 3 }, 'remainingHigh: must be at most 2'],
  ['a missing common thread', { inCommon: undefined }, 'inCommon: required when frictions were found'],
  ['text over 200 characters', { inCommon: 'x'.repeat(201) }, 'inCommon: must be at most 200 characters'],
  [
    'a friction id',
    { inCommon: 'Like fr-20261030-04, these involve CI.' },
    'inCommon: must not hold an id or email',
  ],
  [
    'a session id',
    { working: ['Session 6f1c2a9e-3b4d-4e5f-8a7b-1c2d3e4f5a6b went well'] },
    'working[0]: must not hold an id or email',
  ],
  [
    'an email',
    { top: [{ ...SAVED.top[0], description: 'Ask ron@example.com about lint' }, SAVED.top[1], SAVED.top[2]] },
    'top[0].description: must not hold an id or email',
  ],
] as const) {
  test(`setup_summary refuses ${why}`, async ($, on) => {
    engine(on)

    const called = await callSummary($, { ...SAVED, ...change })

    expect(called.deny).toBe(message)
  })
}

/**
 * Calls one of Quotient's setup tools the way the skill does, by the plugin
 * server's name unless another prefix is given.
 *
 * @param $ - The engine
 * @param tool - The tool's name on the server
 * @param toolUseId - The call's id
 * @param input - The tool's input
 * @param prefix - The server's tool-name prefix
 * @returns What the call resolved to
 */
function callQuotient(
  $: Parameters<TestBody>[0],
  tool: string,
  toolUseId: string,
  input: Record<string, unknown> = {},
  prefix = AGEX,
) {
  return callTool($, `${prefix}${tool}`, toolUseId, input)
}

/**
 * Runs /quotient:setup as the operator types it, then starts the run and
 * records a reviewed source the way the skill does.
 *
 * @param $ - The engine
 * @param source - The source the skill records
 * @returns What the record_setup_progress call resolved to
 */
async function startAndReview($: Parameters<TestBody>[0], source: string) {
  await $.command.run({
    command: 'quotient:setup',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  await callQuotient($, 'start_setup_run', 'toolu_run')
  return callQuotient($, 'record_setup_progress', 'toolu_add', { runId: 'run-1', sources: [source] })
}

test('setup_summary refuses the id of a source the run recorded', async ($, on) => {
  engine(on)
  await startAndReview($, 'trig_routine_run_42')

  const called = await callSummary($, { ...SAVED, inCommon: 'Seen in trig_routine_run_42 and others.' })

  expect(called.deny).toBe('inCommon: must not hold an id or email')
})

test('setup_summary refuses the id of a source an earlier part of the run reviewed', async ($, on) => {
  engine(on, { reviewed: ['trig_routine_run_7'] })
  await startAndReview($, 'trig_routine_run_42')

  const called = await callSummary($, { ...SAVED, inCommon: 'Seen in trig_routine_run_7 and others.' })

  expect(called.deny).toBe('inCommon: must not hold an id or email')
})

test('a failed record_setup_progress leaves the call as it ran, and records nothing', async ($, on) => {
  engine(on, { failing: 'record_setup_progress' })

  const called = await startAndReview($, 'trig_routine_run_42')
  const summary = await callSummary($, { ...SAVED, inCommon: 'Seen in trig_routine_run_42 and others.' })

  expect(called.isError).toBe(true)
  expect(summary.deny).toBeUndefined()
})

test('setup_summary takes no frictions with no top, remaining or common thread', async ($, on) => {
  engine(on)

  const called = await callSummary($, { frictions: 0, working: [], top: [], remainingHigh: 0 })

  expect(called.deny).toBeUndefined()
})

/**
 * Accepts a `setup_summary` call, then draws its row on a surface.
 *
 * @param $ - The engine
 * @param input - The tool's input
 * @param surface - Where it's drawn
 * @param isExpanded - Whether the row is drawn in full, as in ctrl+o
 * @returns The Text elements drawn, in order, and their joined text
 */
async function drawSummary(
  $: Parameters<TestBody>[0],
  input: Record<string, unknown>,
  surface: 'terminal' | 'desktop' = 'terminal',
  isExpanded = false,
) {
  const called = await callSummary($, input)
  expect(called.deny).toBeUndefined()
  return mountSummary($, input, surface, isExpanded)
}

/**
 * Draws the summary call's row as it stands, without calling it again.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @param surface - Where it's drawn
 * @param isExpanded - Whether the row is drawn in full, as in ctrl+o
 * @returns The Text elements drawn, in order, and their joined text
 */
async function mountSummary(
  $: Parameters<TestBody>[0],
  input: Record<string, unknown>,
  surface: 'terminal' | 'desktop' = 'terminal',
  isExpanded = false,
) {
  const ui = await $.ui.mount({
    plugin: 'quotient',
    surface,
    component: 'ToolUse',
    requestId: 'toolu_summary',
    props: {
      tool_use_id: 'toolu_summary',
      tool: SUMMARY_TOOL,
      input,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      isExpanded,
      output: END_TURN,
    },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return { texts, shown: texts.map(text => text.text).join('\n') }
}

/**
 * Draws the engine's own row for a component, standing for what Claude Code
 * draws when the plugin passes.
 *
 * @param on - The test's hooks
 */
function engineRows(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>the engine's row</Text>
  })
}

/**
 * Asserts that each part appears in the text, in the order given.
 *
 * @param shown - The drawn text
 * @param parts - What it must hold, in order
 */
function expectInOrder(shown: string, parts: readonly string[]) {
  let from = 0
  for (const part of parts) {
    const at = shown.indexOf(part, from)
    expect(at).toBeGreaterThanOrEqual(from)
    from = at + part.length
  }
}

/**
 * Runs /quotient:setup and shows its start message, so the summary knows how
 * many sources the run reviews.
 *
 * @param $ - The engine
 * @param start - The start message's fields
 */
async function startSetup($: Parameters<TestBody>[0], start: Record<string, unknown> = START) {
  await $.command.run(TYPED_SETUP)
  await callTool($, START_TOOL, 'toolu_start', start)
}

test('a saved summary draws every section in order', async ($, on) => {
  engine(on)
  await startSetup($)

  const { shown } = await drawSummary($, SAVED)

  expectInOrder(shown, [
    'Setup is done. Your agents ran into 5 frictions in the last two weeks.',
    "They're saved to Quotient, where your teammates' agents can look for fixes.",
    "What's working",
    'Agents found the right file on the first try in 41 of 64 sessions',
    'Your top frictions',
    '▲ high',
    'Lint passes on commit but fails in CI',
    'Quality · 12% of sessions',
    '◆ medium',
    'zsh quoting breaks shell commands',
    'Time lost · 5% of sessions',
    '+ 2 more, 1 of them high severity',
    'Your teammates have probably already fixed some of these.',
    'Two of your top three involve your CI and local setup.',
    "Why a teammate's fix beats asking Claude",
    "· Claude suggests a general fix. A teammate's fix already works in this repo, with your CI and your local setup.",
    "Here's what you'd get back:",
    'SAMPLE',
    'YOUR FRICTION',
    'SOLUTION FROM A TEAMMATE',
    'Ron Burgundy',
    'Apply it · Ask Ron · Not now',
    LIST_FIXES_HINT,
  ])
})

test('the summary colors severities, checks and the remaining line as the mockup does', async ($, on) => {
  engine(on)

  const { texts } = await drawSummary($, {
    ...SAVED,
    top: [SAVED.top[0], SAVED.top[2], { severity: 'low', description: 'Slow test start', impact: 'TIME', sessions: 2 }],
    remainingHigh: 2,
  })
  const find = (text: string) => texts.find(one => one.text === text)?.props

  expect(find('▲ high')?.color).toBe('error')
  expect(find('◆ medium')?.color).toBe('warning')
  expect(find('▼ low')?.dimColor).toBe(true)
  expect(find('✓')?.color).toBe('success')
  expect(find('Quality')?.color).toBe('suggestion')
  expect(find('Quality · 9 sessions')?.dimColor).toBe(true)
  expect(find('+ 2 more, 2 of them high severity')?.dimColor).toBe(true)
})

test('the sample card is fixed text, whatever the top frictions are', async ($, on) => {
  engine(on)

  const { shown } = await drawSummary($, {
    ...SAVED,
    top: SAVED.top.map(one => ({ ...one, description: 'Something else entirely' })),
  })

  for (const part of [
    'SAMPLE',
    '· not a real fix',
    'Lint passes on commit but fails in CI',
    'Blocked · in 14% of your sessions',
    '· Ron Burgundy',
    'Run ESLint from the repo root in the pre-commit hook, so commits use the same rules as CI.',
    '+ cd "$(git rev-parse --show-toplevel)" && npx eslint --cache $FILES',
    '.husky/pre-commit · 1 line',
    "Worked in 14 of Ron's sessions",
  ]) {
    expect(shown).toContain(part)
  }
})

test('with no new frictions only the headline and what is working show', async ($, on) => {
  engine(on)

  const { shown } = await drawSummary($, {
    frictions: 0,
    working: ['The pre-commit typecheck stopped type errors before they reached CI'],
    top: [],
    remainingHigh: 0,
  })

  expectInOrder(shown, [
    'Setup is done. Your agents ran into no new frictions in the last two weeks.',
    "What's working",
    'The pre-commit typecheck stopped type errors before they reached CI',
  ])
  for (const absent of ["They're saved", 'Your top frictions', 'more,', 'Your teammates', 'SAMPLE', '/list-fixes']) {
    expect(shown).not.toContain(absent)
  }
})

test('three frictions or fewer leave out the remaining line, and no working items leave out that section', async ($, on) => {
  engine(on)

  const { shown } = await drawSummary($, { ...SAVED, frictions: 3, working: [], remainingHigh: 0 })

  expect(shown).toContain('Setup is done. Your agents ran into 3 frictions in the last two weeks.')
  expect(shown).not.toContain('more,')
  expect(shown).not.toContain("What's working")
})

test('one friction and one session read in the singular', async ($, on) => {
  engine(on)

  const { shown } = await drawSummary($, {
    ...SAVED,
    frictions: 1,
    top: [{ ...SAVED.top[0], sessions: 1 }],
    remainingHigh: 0,
  })

  expect(shown).toContain('Your agents ran into 1 friction in the last two weeks.')
  expect(shown).toContain('Quality · 1 session')
  expect(shown).not.toContain('1 sessions')
})

test("a friction in fewer than 1% of the run's sources reads as 1%", async ($, on) => {
  engine(on)
  await startSetup($, { ...START, sessions: 300 })

  const { shown } = await drawSummary($, { ...SAVED, frictions: 1, top: [{ ...SAVED.top[0], sessions: 1 }], remainingHigh: 0 })

  expect(shown).toContain('Quality · 1% of sessions')
})

test("the sample card's friction line names its impact in the accent color", async ($, on) => {
  engine(on)

  const { texts } = await drawSummary($, SAVED)

  expect(texts.find(one => one.text === 'Blocked')?.props.color).toBe('suggestion')
})

test("without the start message's counts, each row shows its session count", async ($, on) => {
  engine(on)

  const { shown } = await drawSummary($, SAVED)

  expect(shown).toContain('Quality · 9 sessions')
  expect(shown).not.toContain('% of sessions')
})

test('each impact category draws as its label beside the session count', async ($, on) => {
  engine(on)
  const labels = {
    SAFETY: 'Safety & privacy',
    QUALITY: 'Quality',
    BLOCKED: 'Blocked',
    OPERATOR_ATTENTION: 'Operator effort',
    COST: 'Token cost',
    TIME: 'Time lost',
  }

  for (const [impact, label] of Object.entries(labels)) {
    const { shown } = await drawSummary($, {
      ...SAVED,
      frictions: 1,
      top: [{ ...SAVED.top[0], impact }],
      remainingHigh: 0,
    })

    expect(shown).toContain(`${label} · 9 sessions`)
    expect(shown).not.toContain(impact)
  }
})

const { inCommon: _inCommon, ...INVITED } = SAVED
const TEAMMATE_AGENT = 'agent-check'
const TEAMMATES = [
  { id: 't1', title: 'Lint passes on commit but fails in CI' },
  { id: 't2', title: "Agents can't sign in to the local app" },
  { id: 't3', title: 'zsh quoting breaks shell commands' },
  { id: 't4', title: 'Tests flake on the first run' },
  { id: 't5', title: 'Docker builds time out' },
]
const FIXES = [
  'Run ESLint from the repo root in the pre-commit hook, so commits use the same rules as CI.',
  'Tell agents in CLAUDE.md to sign in with the seeded test user from the fixtures.',
  'Run agent shell commands in bash, so zsh quoting never comes up.',
  'Warm the test cache before the first run.',
  'Give the Docker build a longer timeout.',
] as const

/**
 * Runs setup with its teammate check: starts it, then has the check's
 * subagent list teammates' frictions and send one answer per fix given.
 *
 * @param $ - The engine
 * @param answers - Each answer's friction id and fix, null for an answer with none
 */
async function checkTeammates($: Parameters<TestBody>[0], answers: [string, string | null][]) {
  await startTeammateCheck($)
  for (const [frictionId, fix] of answers) {
    await $.tool.call({
      tool: `${AGEX}submit_solution`,
      agentId: TEAMMATE_AGENT,
      frictionId,
      ...(fix === null ? {} : { description: fix, prompt: 'Apply it.' }),
      source: 'local',
    } as unknown as Parameters<typeof $.tool.call>[0])
  }
}

/**
 * Starts setup with its teammate check, up to the check's subagent listing
 * teammates' frictions.
 *
 * @param $ - The engine
 */
async function startTeammateCheck($: Parameters<TestBody>[0]) {
  await $.command.run(TYPED_SETUP)
  await callTool($, START_TOOL, 'toolu_start', { ...START, checksTeammates: true })
  await $.tool.call({ tool: `${AGEX}list_teammate_frictions`, agentId: TEAMMATE_AGENT } as unknown as Parameters<typeof $.tool.call>[0])
}

/**
 * Has setup's teammate check send a page of answers in one `submit_solutions` call.
 *
 * @param $ - The engine
 * @param answers - Each answer's friction id and fix, null for an answer with none
 */
async function sendTeammateAnswers($: Parameters<TestBody>[0], answers: [string, string | null][]) {
  await $.tool.call({
    tool: `${AGEX}submit_solutions`,
    agentId: TEAMMATE_AGENT,
    answers: answers.map(([frictionId, fix]) => ({ frictionId, ...(fix === null ? {} : { description: fix, prompt: 'Apply it.' }) })),
    source: 'local',
  } as unknown as Parameters<typeof $.tool.call>[0])
}

const CHECK_PROMPT = "Check my setup for fixes to my teammates' frictions."

// The check reads with Read, Grep and Glob only, and Glob lists files oldest
// first and stops at 100, so it can't find the recent sessions itself.
test("setup's teammate check is told the project folders with a session in setup's two weeks", async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED_SETUP)
  await callTool($, START_TOOL, 'toolu_start', { ...START, checksTeammates: true })

  await $.agent.spawn({ subagentType: 'quotient:teammate-check', prompt: CHECK_PROMPT })

  expect(seen.spawned).toEqual([
    {
      subagentType: 'quotient:teammate-check',
      prompt: `${CHECK_PROMPT}\n\nThe project folders with a session from the last two weeks, under \`~/.claude/projects/\`: -repo`,
    },
  ])
})

test("a setup pinned to a window tells its teammate check the folders from that window", async ($, on) => {
  const seen = engine(on, { env: { QUOTIENT_SETUP_WINDOW_END: '2026-10-29' } })
  await $.command.run(TYPED_SETUP)
  await callTool($, START_TOOL, 'toolu_start', { ...START, checksTeammates: true })

  await $.agent.spawn({ subagentType: 'quotient:teammate-check', prompt: CHECK_PROMPT })

  const listings = seen.argv.filter(argv => argv[0] === 'find')
  expect(listings.at(-1)).toContain('-newermt')
  expect(seen.spawned.at(-1)?.prompt).toContain(': -repo')
})

test("setup's other subagents start with their prompts as written", async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED_SETUP)
  await callTool($, START_TOOL, 'toolu_start', { ...START, checksTeammates: true })

  await $.agent.spawn({ subagentType: 'quotient:setup-reviewer', prompt: 'Review these sessions.' })

  expect(seen.spawned).toEqual([{ subagentType: 'quotient:setup-reviewer', prompt: 'Review these sessions.' }])
})

test("a teammate check whose sessions can't be listed starts with its prompt as written", async ($, on) => {
  const seen = engine(on, { findExit: 1 })
  await $.command.run(TYPED_SETUP)

  await $.agent.spawn({ subagentType: 'quotient:teammate-check', prompt: CHECK_PROMPT })

  expect(seen.spawned).toEqual([{ subagentType: 'quotient:teammate-check', prompt: CHECK_PROMPT }])
})

test("an invited operator's summary opens with setup being done and leaves out the pitch, sample, waiting line and hint", async ($, on) => {
  engine(on)
  await checkTeammates($, [])

  const { shown } = await drawSummary($, INVITED)

  expectInOrder(shown, [
    'Setup is done. Your agents ran into 5 frictions in the last two weeks.',
    "They're saved to Quotient, where your teammates' agents can look for fixes.",
    "What's working",
    'Agents found the right file on the first try in 41 of 64 sessions',
    'Your top frictions',
    'Lint passes on commit but fails in CI',
    '+ 2 more, 1 of them high severity',
  ])
  for (const absent of ['Your teammates have probably', "Why a teammate's fix", 'SAMPLE', 'Ron Burgundy', '✻', 'Waiting on solutions', '/list-fixes']) {
    expect(shown).not.toContain(absent)
  }
})

test('an invited operator with no new frictions sees setup being done and what is working', async ($, on) => {
  engine(on)
  await checkTeammates($, [])

  const { shown } = await drawSummary($, { ...INVITED, frictions: 0, top: [], remainingHigh: 0 })

  expect(shown).toContain('Setup is done. Your agents ran into no new frictions in the last two weeks.')
  expect(shown).toContain("What's working")
  for (const absent of ["They're saved", 'Waiting on solutions', 'SAMPLE', '/list-fixes']) {
    expect(shown).not.toContain(absent)
  }
})

test("an invited operator sees their own frictions before the teammates' frictions their setup solves", async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', FIXES[0]]])

  const { shown } = await drawSummary($, INVITED)

  expectInOrder(shown, ['Setup is done. Your agents ran into 5 frictions', '+ 2 more, 1 of them high severity', 'Your setup solves'])
})

test("an invited operator's summary answers with only the instruction to end the turn, since it doesn't end with the hint", async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', FIXES[0]]])

  const called = await callSummary($, INVITED)

  expect(called.deny).toBeUndefined()
  expect(called.result).toBe(END_TURN)
})

test("setup_summary refuses inCommon when setup checked for teammates' fixes", async ($, on) => {
  engine(on)
  await checkTeammates($, [])

  const called = await callSummary($, { ...INVITED, inCommon: SAVED.inCommon })

  expect(called.deny).toBe("inCommon: leave it out when setup checked for teammates' fixes")
})

test('setup_summary refuses a teammateCheck the model sends, since quotient builds it from the calls', async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', FIXES[0]]])

  const called = await callSummary($, { ...INVITED, teammateCheck: { solvedCount: 9, solved: [] } })

  expect(called.deny).toBe('teammateCheck: leave it out, quotient adds it')
})

test("an invited operator sees one example of the teammates' frictions their setup solves, its card from what was sent", async ($, on) => {
  engine(on)
  await checkTeammates($, [
    ['t1', FIXES[0]],
    ['t2', FIXES[1]],
    ['t3', FIXES[2]],
  ])

  const { texts, shown } = await drawSummary($, INVITED)

  expectInOrder(shown, [
    "Your setup solves 3 of your teammates' frictions.",
    "A TEAMMATE'S FRICTION",
    'Lint passes on commit but fails in CI',
    'YOUR FIX',
    FIXES[0],
  ])
  expect(texts.filter(one => one.text === 'YOUR FIX')).toHaveLength(1)
  for (const absent of [FIXES[1], FIXES[2], 'Their agents keep running into these', 'worked in', 'Quotient will suggest these']) {
    expect(shown).not.toContain(absent)
  }
})

test('the solved block and closing sections color their labels, headings and notes as the mockup does', async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', FIXES[0]]])

  const { texts } = await drawSummary($, INVITED)
  const find = (text: string) => texts.find(one => one.text === text)?.props

  expect(find("A TEAMMATE'S FRICTION")).toMatchObject({ color: 'error', bold: true })
  expect(find('YOUR FIX')).toMatchObject({ color: 'success', bold: true })
  expect(texts.filter(one => one.text === 'Lint passes on commit but fails in CI').at(-1)?.props.bold).toBe(true)
  expect(find("What's next")?.bold).toBe(true)
  expect(find('What you can do now')?.bold).toBe(true)
  expect(find('(you both stay anonymous)')?.dimColor).toBe(true)
})

test("an invited operator's summary ends with what's next and what they can do now", async ($, on) => {
  engine(on)
  await checkTeammates($, [
    ['t1', FIXES[0]],
    ['t2', FIXES[1]],
    ['t3', FIXES[2]],
  ])

  const { shown } = await drawSummary($, INVITED)

  expectInOrder(shown, [
    'Setup is done. Your agents ran into 5 frictions in the last two weeks.',
    "Your setup solves 3 of your teammates' frictions.",
    FIXES[0],
    "What's next",
    '1. Quotient will suggest all 3 to your teammates in their next session',
    '(you both stay anonymous)',
    "2. I'll notify you when I have some proven solutions for you to consider",
    'What you can do now',
    'Invite more teammates. The more the merrier.',
  ])
  expect(shown.trimEnd().endsWith('Invite more teammates. The more the merrier.')).toBe(true)
})

test("one fix found is suggested to one teammate in what's next", async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', FIXES[0]]])

  const { shown } = await drawSummary($, INVITED)

  expectInOrder(shown, [
    '1. Quotient will suggest it to your teammate in their next session',
    "2. I'll notify you when I have some proven solutions for you to consider",
  ])
})

test("no fix found leaves only the notify line in what's next, numbered first", async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', null]])

  const { shown } = await drawSummary($, INVITED)

  expectInOrder(shown, ["What's next", "1. I'll notify you when I have some proven solutions for you to consider", 'What you can do now'])
  expect(shown).not.toContain('2. ')
})

test("an invited operator with no new frictions still sees what's next and what they can do now", async ($, on) => {
  engine(on)
  await checkTeammates($, [])

  const { shown } = await drawSummary($, { ...INVITED, frictions: 0, top: [], remainingHigh: 0 })

  expectInOrder(shown, ["What's next", "1. I'll notify you when I have some proven solutions", 'What you can do now', 'Invite more teammates.'])
})

test("an operator setup didn't check for teammates' fixes sees neither closing section", async ($, on) => {
  engine(on)

  const { shown } = await drawSummary($, SAVED)

  for (const absent of ["What's next", 'What you can do now', 'Invite more teammates']) {
    expect(shown).not.toContain(absent)
  }
})

test('the solved headline counts every answer with a fix, beyond the one card shown, and none without', async ($, on) => {
  engine(on)
  await checkTeammates($, [...TEAMMATES.map(({ id }, i): [string, string | null] => [id, FIXES[i] ?? null]), ['t5', null]])

  const { texts, shown } = await drawSummary($, INVITED)

  expectInOrder(shown, [
    "Your setup solves 5 of your teammates' frictions.",
    "They'll get these as anonymous suggestions in their next session.",
  ])
  expect(texts.filter(one => one.text === 'YOUR FIX')).toHaveLength(1)
})

test("one fix found reads as one of your teammates' frictions, with its card", async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', FIXES[0]], ['t2', null]])

  const { shown } = await drawSummary($, INVITED)

  expectInOrder(shown, [
    "Your setup solves 1 of your teammates' frictions.",
    "They'll get it as an anonymous suggestion in their next session.",
    "A TEAMMATE'S FRICTION",
    FIXES[0],
  ])
  expect(shown).not.toContain("Here's an example")
})

test("fixes whose cards can't be shown keep the count but drop the example", async ($, on) => {
  engine(on, {
    teammates: [
      { id: 't1', title: 'Lint fails, see fr-20261029-4' },
      { id: 't2', title: 'Sign-in breaks for ron@example.com' },
    ],
  })
  await checkTeammates($, [
    ['t1', FIXES[0]],
    ['t2', 'Point the sign-in hook at the repo root.'],
  ])

  const { shown } = await drawSummary($, INVITED)

  expect(shown).toContain("Your setup solves 2 of your teammates' frictions.")
  for (const absent of ["Here's an example", "A TEAMMATE'S FRICTION", 'YOUR FIX']) {
    expect(shown).not.toContain(absent)
  }
})

test("one fix whose card can't be shown reads as one of your teammates' frictions, with no card", async ($, on) => {
  engine(on, { teammates: [{ id: 't1', title: 'Sign-in breaks for ron@example.com' }] })
  await checkTeammates($, [['t1', FIXES[0]]])

  const { shown } = await drawSummary($, INVITED)

  expect(shown).toContain("Your setup solves 1 of your teammates' frictions.")
  expect(shown).not.toContain("A TEAMMATE'S FRICTION")
})

test('no fix found leaves out the solved block', async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', null]])

  const { shown } = await drawSummary($, INVITED)

  for (const absent of ['Your setup solves', "A TEAMMATE'S FRICTION", 'Quotient will suggest']) {
    expect(shown).not.toContain(absent)
  }
})

test('the desktop app draws the solved block too', async ($, on) => {
  engine(on)
  await checkTeammates($, [['t1', FIXES[0]]])

  const { shown } = await drawSummary($, INVITED, 'desktop')

  expect(shown).toContain("Your setup solves 1 of your teammates' frictions.")
  expect(shown).toContain('YOUR FIX')
})

test("a card whose text holds an id or an email is left out but still counted, and text past the limit is cut", async ($, on) => {
  engine(on, {
    teammates: [
      { id: 't1', title: 'Lint fails, see fr-20261029-4' },
      { id: 't2', title: 'Sign-in breaks for ron@example.com' },
      { id: 't3', title: 'Builds are slow' },
    ],
  })
  await checkTeammates($, [
    ['t1', FIXES[0]],
    ['t2', 'Point the sign-in hook at the repo root.'],
    ['t3', `Cache the build. ${'x'.repeat(300)}`],
  ])

  const { shown } = await drawSummary($, INVITED)

  expect(shown).toContain("Your setup solves 3 of your teammates' frictions.")
  expect(shown).not.toContain('fr-20261029-4')
  expect(shown).not.toContain('ron@example.com')
  expect(shown).toContain('Builds are slow')
  expect(shown).toContain('…')
  expect(shown).not.toContain('x'.repeat(250))
})

test("escape sequences and control characters in a teammate's text are drawn as plain text", async ($, on) => {
  engine(on, { teammates: [{ id: 't1', title: 'Lint\u001b[2J fails\u0007 in CI' }] })
  await checkTeammates($, [['t1', 'Run\u001b]8;;http://x\u0007 ESLint \u202efrom the root.']])

  const { shown } = await drawSummary($, INVITED)

  expect(shown).toContain('Lint fails in CI')
  expect(shown).toContain('Run ESLint from the root.')
  expect(shown.includes('\u001b')).toBe(false)
})

test('each answer the teammate check sends gets a row of its own, without its friction id', async ($, on) => {
  const seen = engine(on)
  await checkTeammates($, [['t1', FIXES[0]], ['t2', null], ['t3', 'See fr-20261029-5.']])

  expect(seen.logs).toEqual([
    `Sent a teammate a fix: ${FIXES[0]}`,
    "Checked a teammate's friction: no fix found in your setup.",
    'Sent a teammate a fix.',
  ])
})

test('each answer in a batch the teammate check sends gets a row of its own, and only those Quotient stored count', async ($, on) => {
  const seen = engine(on, { refused: ['t3'] })
  await startTeammateCheck($)
  await sendTeammateAnswers($, [['t1', FIXES[0]], ['t2', null], ['t3', FIXES[2]]])

  const { shown } = await drawSummary($, INVITED)

  expect(seen.logs).toEqual([`Sent a teammate a fix: ${FIXES[0]}`, "Checked a teammate's friction: no fix found in your setup."])
  expect(shown).toContain("Your setup solves 1 of your teammates' frictions.")
  expect(shown).not.toContain(FIXES[2])
})

test('a batch whose reply cannot be read still counts every answer it sent', async ($, on) => {
  const seen = engine(on)
  await startTeammateCheck($)
  await sendTeammateAnswers($, [['t1', FIXES[0]], ['t2', FIXES[1]]])

  const { shown } = await drawSummary($, INVITED)

  expect(seen.logs).toEqual([`Sent a teammate a fix: ${FIXES[0]}`, `Sent a teammate a fix: ${FIXES[1]}`])
  expect(shown).toContain("Your setup solves 2 of your teammates' frictions.")
})

test("setup's own session learns only whether teammates have frictions, never their text", async ($, on) => {
  engine(on)
  await $.command.run(TYPED_SETUP)

  const called = await $.tool.call({ tool: `${AGEX}list_teammate_frictions` } as unknown as Parameters<typeof $.tool.call>[0])

  const read = JSON.stringify(called)
  expect(read).toContain('{\\"hasFrictions\\":true}')
  expect(read).not.toContain('Lint passes on commit')
})

test("setup the model starts with the Skill tool is held the same: its session learns only whether there are frictions", async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Skill', skill: 'quotient:setup' } as unknown as Parameters<typeof $.tool.call>[0])

  const called = await $.tool.call({ tool: `${AGEX}list_teammate_frictions` } as unknown as Parameters<typeof $.tool.call>[0])

  expect(JSON.stringify(called)).toContain('{\\"hasFrictions\\":true}')
  expect(JSON.stringify(called)).not.toContain('Lint passes on commit')
})

test("setup's own session learns there are none when the list is empty", async ($, on) => {
  engine(on, { teammates: [] })
  await $.command.run(TYPED_SETUP)

  const called = await $.tool.call({ tool: `${CONNECTOR}list_teammate_frictions` } as unknown as Parameters<typeof $.tool.call>[0])

  expect(JSON.stringify(called)).toContain('{\\"hasFrictions\\":false}')
})

const INVITE_URL = 'https://dev.getquotient.com/join/ABCD1234'
const INVITE = { companyName: 'Northwind Robotics', inviteUrl: INVITE_URL, emailDomain: 'acme.com', memberCount: 1, maxSeats: 20 }
const FIRST_MESSAGE = 'hey this plugin lets our agents talk to each other / suggest fixes for problems.'
const MORE_MESSAGE = "hey are you using this yet? it's a plugin that lets our agents talk to each other and suggest fixes."

/**
 * The `get_invite_link` reply for an invite, with any fields changed.
 *
 * @param change - The fields to change
 * @returns The reply as `engine` takes it
 */
function inviteReply(change: Record<string, unknown> = {}) {
  return { text: JSON.stringify({ ...INVITE, ...change }) }
}

test("the first on their team sees the invite after the sample card, in place of the /list-fixes hint", async ($, on) => {
  engine(on, { invite: inviteReply() })

  const { texts, shown } = await drawSummary($, SAVED)

  expectInOrder(shown, [
    'Apply it · Ask Ron · Not now',
    "You're the first on your team. Invite teammates by sharing the link.",
    "They'll join Northwind Robotics. They won't see your sessions.",
    FIRST_MESSAGE,
    'signup + install here:',
    INVITE_URL,
  ])
  expect(shown).not.toContain(LIST_FIXES_HINT)
  expect(texts.find(one => one.text.startsWith("You're the first"))?.props.bold).toBe(true)
  expect(texts.find(one => one.text.startsWith("They'll join"))?.props.dimColor).toBe(true)
})

test('a summary with the invite tells the model only to end the turn, without the link', async ($, on) => {
  engine(on, { invite: inviteReply() })

  const called = await callSummary($, SAVED)

  expect(called.result).toBe(END_TURN)
  expect(JSON.stringify(called)).not.toContain('ABCD1234')
})

test('an operator with one teammate is asked if they are using it yet', async ($, on) => {
  engine(on, { invite: inviteReply({ memberCount: 2 }) })

  const { shown } = await drawSummary($, SAVED)

  expectInOrder(shown, [
    'You have 1 teammate on Quotient so far. Invite more by sharing the link.',
    "They'll join Northwind Robotics. They won't see your sessions.",
    MORE_MESSAGE,
    INVITE_URL,
  ])
  expect(shown).not.toContain(FIRST_MESSAGE)
})

test('an operator with several teammates counts the others', async ($, on) => {
  engine(on, { invite: inviteReply({ memberCount: 15 }) })

  const { shown } = await drawSummary($, SAVED)

  expect(shown).toContain('You have 14 teammates on Quotient so far. Invite more by sharing the link.')
})

test("an invited operator sees the invite after the frictions their setup solves, in place of what's next", async ($, on) => {
  engine(on, { invite: inviteReply({ memberCount: 3 }) })
  await checkTeammates($, [['t1', FIXES[0]]])

  const { shown } = await drawSummary($, INVITED)

  expectInOrder(shown, ["Your setup solves 1 of your teammates' frictions.", FIXES[0], 'You have 2 teammates on Quotient so far.'])
  for (const absent of ["What's next", 'What you can do now', 'Invite more teammates.']) {
    expect(shown).not.toContain(absent)
  }
})

test('an operator with no new frictions still sees the invite', async ($, on) => {
  engine(on, { invite: inviteReply() })

  const { shown } = await drawSummary($, { frictions: 0, working: [], top: [], remainingHigh: 0 })

  expectInOrder(shown, ['Setup is done. Your agents ran into no new frictions', "You're the first on your team."])
})

test('quotient asks the Quotient connector for the invite when the session runs the plugin servers itself', async ($, on) => {
  const seen = engine(on, { invite: inviteReply(), connected: { isConnected: false, reason: 'unlisted' } })

  const { shown } = await drawSummary($, SAVED)

  expect(seen.mcpCalls).toContainEqual({ server: 'claude.ai Quotient', tool: 'get_invite_link' })
  expect(shown).toContain(INVITE_URL)
})

for (const [why, opts] of [
  ['a refusal', { invite: { text: "Your company doesn't have an AgEx invite link.", isError: true } }],
  ['a reply that is not JSON', { invite: { text: 'not json' } }],
  ['a missing company name', { invite: inviteReply({ companyName: undefined }) }],
  ['an empty invite link', { invite: inviteReply({ inviteUrl: '' }) }],
  ['a member count of 0', { invite: inviteReply({ memberCount: 0 }) }],
  ['a fractional member count', { invite: inviteReply({ memberCount: 1.5 }) }],
  ['a seat limit that is not a number', { invite: inviteReply({ maxSeats: 'twenty' }) }],
  ['a full trial', { invite: inviteReply({ memberCount: 20, maxSeats: 20 }) }],
  ['a link that is not a web address', { invite: inviteReply({ inviteUrl: 'javascript:alert(1)' }) }],
  ['a link with a control character', { invite: inviteReply({ inviteUrl: `${INVITE_URL}\x1b[2J` }) }],
  ['a company name with nothing printable', { invite: inviteReply({ companyName: '\x1b[31m\x07' }) }],
  ['a call that fails', { invite: 'throw' }],
  ['an operator who is not signed in', { invite: inviteReply(), connected: { isConnected: false, reason: 'failed' } }],
  ['a server without the tool', {}],
] as const) {
  test(`${why} shows no invite, and the summary ends as before`, async ($, on) => {
    const seen = engine(on, opts as Parameters<typeof engine>[1])

    const called = await callSummary($, SAVED)
    const { shown } = await drawSummary($, SAVED)

    expect(called.result).toBe(END_TURN_WITH_HINT)
    if (why !== 'an operator who is not signed in') expect(seen.debug.some(line => line.includes('get_invite_link'))).toBe(true)
    expect(shown).toContain(LIST_FIXES_HINT)
    expect(shown).not.toContain('sharing the link')
  })
}

test("escape sequences in the company's name are drawn as plain text", async ($, on) => {
  engine(on, { invite: inviteReply({ companyName: 'Northwind\x1b[31m Robotics\x07' }) })

  const { shown } = await drawSummary($, SAVED)

  expect(shown).toContain("They'll join Northwind Robotics. They won't see your sessions.")
  expect(shown).not.toContain('\x1b')
})

test('a summary with no seat limit still shows the invite', async ($, on) => {
  engine(on, { invite: inviteReply({ memberCount: 40, maxSeats: null }) })

  const { shown } = await drawSummary($, SAVED)

  expect(shown).toContain('You have 39 teammates on Quotient so far.')
})

const WHAT_HAPPENS_NEXT = [
  'What happens next',
  '1. Your teammate joins.',
  '2. Quotient finds solutions in their setup.',
  '3. You get suggestions next session.',
]

/**
 * Shows the summary with an invite, ends the turn as the model does, and
 * draws the summary's row once the question is answered.
 *
 * @param $ - The engine
 * @param input - The summary call's input
 * @returns The Text elements drawn, in order, and their joined text
 */
async function shareInvite($: Parameters<TestBody>[0], input: Record<string, unknown> = SAVED) {
  await callSummary($, input)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  return mountSummary($, input)
}

test('once the turn ends, quotient asks "Copy to share" with the two copies', async ($, on) => {
  const seen = engine(on, { invite: inviteReply(), share: 'Copy message' })

  await shareInvite($)

  expect(seen.questions).toEqual([
    [
      {
        question: 'Copy to share',
        header: 'Invite',
        options: [
          { label: 'Copy message', description: '' },
          { label: 'Copy link', description: '' },
        ],
        multiSelect: false,
      },
    ],
  ])
})

test('Copy message copies the message and the link, then says what happens next', async ($, on) => {
  const seen = engine(on, { invite: inviteReply(), share: 'Copy message' })

  const { texts, shown } = await shareInvite($)

  expect(seen.copied).toEqual([`${FIRST_MESSAGE}\n\nsignup + install here:\n${INVITE_URL}`])
  expectInOrder(shown, [
    INVITE_URL,
    'Copy to share → Copy message',
    'Message copied. Paste it to your teammates in Slack.',
    ...WHAT_HAPPENS_NEXT,
    'Your frictions stay saved. Run /list-fixes to see the full list.',
  ])
  expect(texts.find(one => one.text === '✓')?.props.color).toBe('success')
  expect(texts.find(one => one.text === 'What happens next')?.props.bold).toBe(true)
})

test('Copy link copies only the link', async ($, on) => {
  const seen = engine(on, { invite: inviteReply({ memberCount: 4 }), share: 'Copy link' })

  const { shown } = await shareInvite($)

  expect(seen.copied).toEqual([INVITE_URL])
  expectInOrder(shown, ['Copy to share → Copy link', 'Link copied. Paste it to your teammates in Slack.', 'What happens next'])
})

test("a teammate's copied message asks if they are using it yet", async ($, on) => {
  const seen = engine(on, { invite: inviteReply({ memberCount: 4 }), share: 'Copy message' })

  await shareInvite($)

  expect(seen.copied).toEqual([`${MORE_MESSAGE}\n\nsignup + install here:\n${INVITE_URL}`])
})

for (const [why, opts] of [
  ['a dismissed question', { share: null }],
  ['an answer typed under Other', { share: 'send it to the team' }],
  ['an answer given while the operator was away', { share: 'Copy message', isAway: true }],
] as const) {
  test(`${why} copies nothing, and still says what happens next`, async ($, on) => {
    const seen = engine(on, { invite: inviteReply(), ...opts })

    const { shown } = await shareInvite($)

    expect(seen.copied).toEqual([])
    expect(shown).not.toContain('copied')
    expect(shown).not.toContain('Copy to share →')
    expectInOrder(shown, WHAT_HAPPENS_NEXT)
  })
}

test("a copy the clipboard doesn't take says to select the text instead", async ($, on) => {
  engine(on, { invite: inviteReply(), share: 'Copy message', isCopied: false })

  const { texts, shown } = await shareInvite($)

  expect(shown).toContain("Couldn't reach the clipboard here. Select the message above to copy it.")
  expect(shown).not.toContain('Message copied')
  expect(texts.find(one => one.text === '!')?.props.color).toBe('warning')
  expectInOrder(shown, WHAT_HAPPENS_NEXT)
})

test('with no new frictions, what happens next leaves out the saved frictions line', async ($, on) => {
  engine(on, { invite: inviteReply(), share: 'Copy link' })

  const { shown } = await shareInvite($, { frictions: 0, working: [], top: [], remainingHigh: 0 })

  expectInOrder(shown, WHAT_HAPPENS_NEXT)
  expect(shown).not.toContain('Your frictions stay saved')
})

test('a summary with no invite asks nothing when the turn ends', async ($, on) => {
  const seen = engine(on, { share: 'Copy message' })

  const { shown } = await shareInvite($)

  expect(seen.questions).toEqual([])
  expect(shown).not.toContain('What happens next')
})

for (const reason of ['aborted', 'error'] as const) {
  test(`a summary turn that ends ${reason} asks nothing then or on a later turn`, async ($, on) => {
    const seen = engine(on, { invite: inviteReply(), share: 'Copy link' })

    await callSummary($, SAVED)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

    expect(seen.questions).toEqual([])
  })
}

test('the question is asked once, not again on a later turn', async ($, on) => {
  const seen = engine(on, { invite: inviteReply(), share: 'Copy link' })

  await shareInvite($)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

  expect(seen.questions).toHaveLength(1)
})

test('the desktop app draws the summary too', async ($, on) => {
  engine(on)

  const { shown } = await drawSummary($, SAVED, 'desktop')

  expect(shown).toContain('Setup is done. Your agents ran into 5 frictions in the last two weeks.')
  expect(shown).toContain('Ron Burgundy')
})

test('ctrl+o shows the engine row for the summary call', async ($, on) => {
  engine(on)
  engineRows(on)

  const { shown } = await drawSummary($, SAVED, 'terminal', true)

  expect(shown).toBe("the engine's row")
})

test("the summary call's result row is hidden, since the call's own row draws the summary", async ($, on) => {
  engine(on)
  engineRows(on)
  await callSummary($, SAVED)

  const ui = await $.ui.mount({
    plugin: 'quotient',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'toolu_summary',
    props: { tool_use_id: 'toolu_summary', tool: SUMMARY_TOOL, output: END_TURN, isErrored: false, isExpanded: false },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  expect(texts).toEqual([])
})

test('a refused summary call draws the engine row, with its error', async ($, on) => {
  engine(on)
  engineRows(on)
  await callSummary($, { ...SAVED, frictions: -1 })

  const ui = await $.ui.mount({
    plugin: 'quotient',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_summary',
    props: {
      tool_use_id: 'toolu_summary',
      tool: SUMMARY_TOOL,
      input: {},
      isRunning: false,
      isErrored: true,
      isInterrupted: false,
      isExpanded: false,
    },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  expect(texts.map(text => text.text)).toEqual(["the engine's row"])
})

test('a summary call that is still running draws nothing, not its raw input', async ($, on) => {
  engine(on)
  engineRows(on)

  const ui = await $.ui.mount({
    plugin: 'quotient',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_running',
    props: {
      tool_use_id: 'toolu_running',
      tool: SUMMARY_TOOL,
      input: SAVED,
      isRunning: true,
      isErrored: false,
      isInterrupted: false,
      isExpanded: false,
    },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  expect(texts).toEqual([])
})

/**
 * Calls `setup_start` as the model would, then draws its row.
 *
 * @param $ - The engine
 * @param input - The tool's input
 * @param surface - Where it's drawn
 * @returns What the call resolved to, and the joined text drawn
 */
async function drawStart(
  $: Parameters<TestBody>[0],
  input: Record<string, unknown>,
  surface: 'terminal' | 'desktop' = 'terminal',
) {
  const called = await callTool($, START_TOOL, 'toolu_start', input)
  const ui = await $.ui.mount({
    plugin: 'quotient',
    surface,
    component: 'ToolUse',
    requestId: 'toolu_start',
    props: {
      tool_use_id: 'toolu_start',
      tool: START_TOOL,
      input,
      isRunning: false,
      isErrored: called.deny !== undefined,
      isInterrupted: false,
      isExpanded: false,
      output: called.result,
    },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return { called, texts, shown: texts.map(text => text.text).join('\n') }
}

test("setup_start counts the sessions and automated runs itself, leaving out probes, daily runs and quotient's own sessions", async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED_SETUP)

  const { called, shown } = await drawStart($, { cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  expect(called.deny).toBeUndefined()
  expect(String(called.result)).toContain(
    'quotient counted 64 sessions and 3 automated runs from the last two weeks, leaving out every session setup skips.',
  )
  expect(shown).toContain('Reviewing 64 sessions, 3 automated runs and 10 cloud routine runs from Oct 15 to Oct 29')
  const awk = seen.argv.find(argv => argv[0] === 'awk') ?? []
  expect(awk.some(arg => arg.includes('-private-tmp-') || arg.includes('-local-share-quotient'))).toBe(false)
  const grep = seen.argv.find(argv => argv[0] === 'grep') ?? []
  expect(grep.some(arg => arg.includes('-private-tmp-') || arg.includes('-local-share-quotient'))).toBe(false)
  expect(grep.some(arg => QUOTIENT_STARTED.includes(arg))).toBe(false)
})

test("setup_start looks for quotient's own sessions by their first typed prompt", async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED_SETUP)

  await drawStart($, { cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  const [, program] = seen.argv.find(argv => argv[0] === 'awk') ?? []
  expect(program).toContain('"content": ?"<command-(name>\\/|message>)quotient:')
  expect(program).toContain('!/"isMeta": ?true/')
  expect(program).toContain('nextfile')
})

test("setup_start counts nothing when every recent session started with one of quotient's skills", async ($, on) => {
  const seen = engine(on, { transcripts: QUOTIENT_STARTED })
  await $.command.run(TYPED_SETUP)

  const { called } = await drawStart($, { cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  expect(String(called.result)).toContain('quotient counted 0 sessions and 0 automated runs')
  expect(seen.argv.some(argv => argv[0] === 'grep')).toBe(false)
})

test('setup_start counts the last two weeks by modification time when no window is pinned', async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED_SETUP)

  const { called, shown } = await drawStart($, { cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  const find = seen.argv.find(argv => argv[0] === 'find') ?? []
  expect(find).toContain('-mtime')
  expect(find).not.toContain('-newermt')
  expect(called.deny).toBeUndefined()
  expect(shown).toContain('from Oct 15 to Oct 29')
})

test('a pinned window counts only the 14 days before its end, and the start message shows those days', async ($, on) => {
  const seen = engine(on, { env: { QUOTIENT_SETUP_WINDOW_END: '2026-10-30' } })
  await $.command.run(TYPED_SETUP)

  const { called, shown } = await drawStart($, { cloudRuns: 10, firstDay: 'Oct 20', lastDay: 'Nov 3' })

  const find = seen.argv.find(argv => argv[0] === 'find') ?? []
  expect(find.join(' ')).toContain('-newermt 2026-10-16 ! -newermt 2026-10-30')
  expect(find).not.toContain('-mtime')
  expect(called.deny).toBeUndefined()
  expect(shown).toContain('from Oct 16 to Oct 29')
})

test("a pinned window moves start_setup_run's startedAt to the window's end, so the skill reviews those two weeks", async ($, on) => {
  engine(on, { env: { QUOTIENT_SETUP_WINDOW_END: '2026-10-30' } })
  await $.command.run(TYPED_SETUP)

  const called = await callTool($, `${AGEX}start_setup_run`, 'toolu_run', {})

  const reply = JSON.stringify({ runId: 'run-1', startedAt: '2026-10-30T00:00:00Z', reviewedSources: [] })
  expect(JSON.stringify(called)).toContain(JSON.stringify(reply).slice(1, -1))
})

test("without a pinned window, start_setup_run's reply is unchanged", async ($, on) => {
  engine(on)
  await $.command.run(TYPED_SETUP)

  const called = await callTool($, `${AGEX}start_setup_run`, 'toolu_run', {})

  expect(called.text).toBe(JSON.stringify({ runId: 'run-1', startedAt: '2026-10-29T12:00:00Z', reviewedSources: [] }))
})

test("start_setup_run's reply gains the routine ids the window's sessions mention, most mentioned first", async ($, on) => {
  const seen = engine(on, {
    routineIds: { [`${PROJECTS}/-repo/s1.jsonl`]: ['trig_0000000002', 'trig_0000000001', 'trig_0000000002'], [`${PROJECTS}/-repo/s5.jsonl`]: ['trig_0000000009'] },
    teammateFiles: [`${PROJECTS}/-repo/s5.jsonl`],
  })
  await $.command.run(TYPED_SETUP)

  const called = await callTool($, `${AGEX}start_setup_run`, 'toolu_run', {})

  const text = (called.result as unknown as { text: string }[])[0]?.text
  expect(JSON.parse(String(text)).routineIdsInSessions).toEqual(['trig_0000000002', 'trig_0000000001'])
  const ids = seen.argv.find(argv => argv.includes('-ohE')) ?? []
  expect(ids).not.toContain(`${PROJECTS}/-repo/s5.jsonl`)
  expect(ids.some(arg => arg.includes('-private-tmp-'))).toBe(false)
})

test("when quotient can't check sessions for teammates' fixes, start_setup_run's reply gains no routine ids", async ($, on) => {
  engine(on, { routineIds: { [`${PROJECTS}/-repo/s1.jsonl`]: ['trig_0000000001'] }, teammateGrepFails: true })
  await $.command.run(TYPED_SETUP)

  const called = await callTool($, `${AGEX}start_setup_run`, 'toolu_run', {})

  expect(called.text).toBe(JSON.stringify({ runId: 'run-1', startedAt: '2026-10-29T12:00:00Z', reviewedSources: [] }))
})

test('a window end that is not a date is ignored', async ($, on) => {
  const seen = engine(on, { env: { QUOTIENT_SETUP_WINDOW_END: 'last tuesday' } })
  await $.command.run(TYPED_SETUP)

  const { called } = await drawStart($, { cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  expect(seen.argv.find(argv => argv[0] === 'find')).toContain('-mtime')
  expect(called.deny).toBeUndefined()
})

test('batches hold ten sources each, in folder order, and a small folder shares a batch with the next', async ($, on) => {
  const a = Array.from({ length: 21 }, (_, i) => `${PROJECTS}/-a/a${String(i).padStart(2, '0')}.jsonl`)
  const b = ['b1', 'b2', 'b3'].map(id => `${PROJECTS}/-b/${id}.jsonl`)
  engine(on, { transcripts: [...b, ...a], automated: [] })
  await $.command.run(TYPED_SETUP)

  const { called } = await drawStart($, { cloudRuns: 0, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  const result = String(called.result)
  expect(result).toContain('Review these 24 sources in 3 batches')
  expect(result).toContain(`Batch 2, in ${PROJECTS}/-a: a10, a11, a12, a13, a14, a15, a16, a17, a18, a19\n`)
  expect(result).toContain(`Batch 3, in ${PROJECTS}/-a: a20; in ${PROJECTS}/-b: b1, b2, b3\n`)
})

test('setup_start lists the latest three runs of a small recurring automated job, and counts only the runs it lists', async ($, on) => {
  const jobs = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map(id => `${PROJECTS}/-jobs/${id}.jsonl`)
  const review = 'Review this change for security vulnerabilities.'
  engine(on, {
    transcripts: [`${PROJECTS}/-repo/s1.jsonl`, ...jobs],
    automated: jobs,
    // The engine's ls keeps the order it's given, so r1 is the newest.
    prompts: Object.fromEntries([
      ...jobs.slice(0, 5).map(file => [file, review]),
      [jobs[5] as string, 'Reply OK.'],
    ]),
  })
  await $.command.run(TYPED_SETUP)

  const { called, shown } = await drawStart($, { cloudRuns: 0, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  const result = String(called.result)
  expect(result).toContain(
    'quotient counted 1 session and 4 automated runs from the last two weeks, leaving out every session setup skips and 2 older runs of recurring automated jobs: it lists the latest runs of each job, about the square root of its run count, from 3 to 15.',
  )
  expect(result).toContain(`Batch 1, in ${PROJECTS}/-jobs: r1, r2, r3, r6; in ${PROJECTS}/-repo: s1\n`)
  expect(shown).toContain('Reviewing 1 session and 4 automated runs from')
})

test('a busy automated job gets about the square root of its run count, at most 15', async ($, on) => {
  const busy = Array.from({ length: 300 }, (_, i) => `${PROJECTS}/-jobs/b${String(i).padStart(3, '0')}.jsonl`)
  const daily = Array.from({ length: 30 }, (_, i) => `${PROJECTS}/-jobs/d${String(i).padStart(2, '0')}.jsonl`)
  engine(on, {
    transcripts: [...busy, ...daily],
    automated: [...busy, ...daily],
    prompts: Object.fromEntries([...busy.map(file => [file, 'Review this change.']), ...daily.map(file => [file, 'Nightly: update the sitemap.'])]),
  })
  await $.command.run(TYPED_SETUP)

  const { called } = await drawStart($, { cloudRuns: 0, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  // 15 of the 300, the newest first, and 5 of the 30 (the square root of 30 is about 5.5).
  expect(String(called.result)).toContain('quotient counted 0 sessions and 20 automated runs')
  expect(String(called.result)).toContain('b000, b001')
  expect(String(called.result)).toContain('b014')
  expect(String(called.result)).not.toContain('b015')
  expect(String(called.result)).toContain('d04')
  expect(String(called.result)).not.toContain('d05')
})

test("when quotient can't tell automated runs' jobs apart, setup_start lists every run", async ($, on) => {
  const jobs = ['r1', 'r2', 'r3', 'r4'].map(id => `${PROJECTS}/-jobs/${id}.jsonl`)
  engine(on, { transcripts: jobs, automated: jobs, prompts: {} })
  await $.command.run(TYPED_SETUP)

  const { called } = await drawStart($, { cloudRuns: 0, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  expect(String(called.result)).toContain('quotient counted 0 sessions and 4 automated runs from the last two weeks, leaving out every session setup skips.\n')
  expect(String(called.result)).toContain('Review these 4 sources in 1 batch')
})

test("setup_start lists the batches to review by full path, leaving out reviewed sources and teammates' transcripts", async ($, on) => {
  engine(on, { reviewed: ['s0'], teammateFiles: [`${PROJECTS}/-repo/s5.jsonl`] })
  await $.command.run(TYPED_SETUP)
  await callTool($, `${AGEX}start_setup_run`, 'toolu_run', {})

  const { called } = await drawStart($, { cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  const result = String(called.result)
  expect(result).toContain('Review these 65 sources in 7 batches')
  expect(result).toContain('Review each through setup_digest, by its name.')
  expect(result).toContain('Never read a transcript itself')
  expect(result).not.toContain('only without setup_digest')
  expect(result).toContain(`Batch 1, in ${PROJECTS}/-repo: s1, s10, s11, s12, s13, s14, s15, s16, s17, s18`)
  expect(result).not.toMatch(/\bs0\b/)
  expect(result).not.toMatch(/\bs5\b/)
  expect(result).toContain("1 session holds teammates' fixes, so it's left out: never read it.")
  expect(result).toContain(GO_ON)
})

const DIGEST_TOOL = 'mcp__quotient__setup_digest'
const S1 = `${PROJECTS}/-repo/s1.jsonl`
const S1_LINES = [
  { type: 'user', cwd: '/repo', timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: 'Fix the flaky checkout test.' } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Error: timed out after 5000 ms' }] } },
]
  .map(line => JSON.stringify(line))
  .join('\n')

/**
 * Starts setup and lists its batches, so setup_digest knows which sources it may read.
 *
 * @param $ - The engine
 */
async function startListed($: Parameters<TestBody>[0]) {
  await $.command.run(TYPED_SETUP)
  await drawStart($, { cloudRuns: 0, firstDay: 'Oct 15', lastDay: 'Oct 29' })
}

test('the session registers setup_digest in the tool list', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.tools).toContainEqual({ name: 'setup_digest', isDeferred: false })
})

test('setup_digest answers with the digest of a source setup_start listed, reading it in line ranges', async ($, on) => {
  const seen = engine(on, { contents: { [S1]: S1_LINES } })
  await startListed($)

  const called = await callTool($, DIGEST_TOOL, 'toolu_digest', { source: 's1' })

  expect(called.deny).toBeUndefined()
  expect(String(called.result)).toContain('Session s1: 3 lines, /repo')
  expect(String(called.result)).toContain('L1 operator: Fix the flaky checkout test.')
  expect(String(called.result)).toContain('L2 Bash {"command":"npm test"} → ERROR: Error: timed out after 5000 ms')
  expect(seen.argv.some(argv => argv[0] === 'sed' && argv.at(-1) === S1)).toBe(true)
})

test('setup_digest notes a line too large to read and goes on after it', async ($, on) => {
  engine(on, { contents: { [S1]: S1_LINES }, hugeLine: 2 })
  await startListed($)

  const called = await callTool($, DIGEST_TOOL, 'toolu_digest', { source: 's1' })

  expect(String(called.result)).toContain('L2 (line of 5,000,000 bytes, too large to read)')
  expect(String(called.result)).toContain('L1 operator: Fix the flaky checkout test.')
  expect(String(called.result)).toContain('Session s1: 3 lines')
})

for (const [why, source] of [
  ["a source setup_start didn't list", 'nope'],
  ['a path', `${PROJECTS}/-repo/s1.jsonl`],
  ['a climb out of the folder', '../s1'],
  ['no source', undefined],
] as const) {
  test(`setup_digest refuses ${why}`, async ($, on) => {
    const seen = engine(on, { contents: { [S1]: S1_LINES } })
    await startListed($)

    const called = await callTool($, DIGEST_TOOL, 'toolu_digest', { source })

    expect(called.deny).toContain('setup_start')
    expect(seen.argv.some(argv => argv[0] === 'sed')).toBe(false)
  })
}

test("setup_digest refuses a listed source that has since come to hold teammates' fixes, and never reads it", async ($, on) => {
  const seen = engine(on, { contents: { [S1]: S1_LINES }, laterTeammateFiles: [S1] })
  await startListed($)

  const called = await callTool($, DIGEST_TOOL, 'toolu_digest', { source: 's1' })

  expect(called.deny).toContain("teammates' fixes")
  expect(seen.argv.some(argv => argv[0] === 'sed')).toBe(false)
})

// A transcript line that called one of Quotient's tools that return teammates' fixes.
const TEAMMATE_CALL = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 't9', name: 'mcp__plugin_quotient_agex__list_my_frictions', input: {} }] },
})

test("setup_digest refuses a transcript whose lines, as read, hold teammates' fixes, even when the check before passed", async ($, on) => {
  engine(on, { contents: { [S1]: `${S1_LINES}\n${TEAMMATE_CALL}` } })
  await startListed($)

  const called = await callTool($, DIGEST_TOOL, 'toolu_digest', { source: 's1' })

  expect(called.deny).toContain("teammates' fixes")
})

test('setup_digest refuses outside a setup run', async ($, on) => {
  engine(on, { contents: { [S1]: S1_LINES } })

  const called = await callTool($, DIGEST_TOOL, 'toolu_digest', { source: 's1' })

  expect(called.deny).toContain('/quotient:setup')
})

const BIG = 'x'.repeat(5_000)
const ROUTINE = {
  id: 'trig_0000000001',
  name: 'Nightly check',
  cron_expression: '0 6 * * *',
  enabled: true,
  last_run: { status: 'failed' },
  derived_state: { prompt: 'Check the nightly build.' },
  job_config: { big: BIG },
  session_request: { big: BIG },
}
const ROUTINE_LIST = { status: 'ok', json: JSON.stringify({ data: [ROUTINE], has_more: false }) }
const RUN_LOG = {
  status: 'ok',
  json: JSON.stringify({ session_id: 'session_01', events_fetched: 1, events_shown: 1, next_cursor: null }),
  summary: `[2026-11-08T06:00:09.000000Z] tool_result: ${BIG}`,
}

test('during setup, a RemoteTrigger routine list keeps only the fields setup reads, in the same shape', async ($, on) => {
  engine(on, { remote: ROUTINE_LIST })
  await $.command.run(TYPED_SETUP)

  const called = (await callTool($, 'RemoteTrigger', 'toolu_list', { action: 'list' })) as unknown as { result: Record<string, unknown> }

  expect(called.result.status).toBe('ok')
  const json = String(called.result.json)
  expect(json).toContain('quotient shortened this reply for setup')
  expect(json).toContain('"id":"trig_0000000001"')
  expect(json).not.toContain('job_config')
  expect(json.length).toBeLessThan(1_000)
})

test('during setup, a RemoteTrigger run log arrives as a digest, each event numbered', async ($, on) => {
  engine(on, { remote: RUN_LOG })
  await $.command.run(TYPED_SETUP)

  const called = (await callTool($, 'RemoteTrigger', 'toolu_log', { action: 'get_run_log', session_id: 'session_01' })) as unknown as {
    result: Record<string, unknown>
  }

  expect(String(called.result.summary)).toContain('quotient digested this log for setup')
  expect(String(called.result.summary)).toContain('E1 [06:00:09] tool_result: xxx')
  expect(String(called.result.summary).length).toBeLessThan(400)
  expect(called.result.json).toBe(RUN_LOG.json)
})

// A full page of 200 events, each tool event 5,000 characters, with three errors.
const FULL_PAGE = Array.from({ length: 200 }, (_, i) => {
  const time = `2026-11-08T06:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000Z`
  if (i === 0) return `[${time}] user: Check the nightly build.`
  if (i % 50 === 0) return `[${time}] tool_result ERROR: npm error 404 at step ${i}`
  return `[${time}] ${i % 2 === 1 ? 'tool_use Read' : 'tool_result'}: ${BIG}`
}).join('\n')
const FULL_LOG = {
  status: 'ok',
  json: JSON.stringify({ session_id: 'session_01', events_fetched: 200, events_shown: 200, next_cursor: 'cursor_1' }),
  summary: FULL_PAGE,
}

test('during setup, a full run-log page fits the digest budget and keeps every error', async ($, on) => {
  engine(on, { remote: FULL_LOG })
  await $.command.run(TYPED_SETUP)

  const called = (await callTool($, 'RemoteTrigger', 'toolu_log', { action: 'get_run_log', session_id: 'session_01' })) as unknown as {
    result: Record<string, unknown>
  }

  const summary = String(called.result.summary)
  expect(FULL_PAGE.length).toBeGreaterThan(400_000)
  expect(summary.length).toBeLessThanOrEqual(16_000)
  expect(summary).toContain('E1 [06:00:00] user: Check the nightly build.')
  for (const step of [50, 100, 150]) expect(summary).toContain(`tool_result ERROR: npm error 404 at step ${step}`)
  expect(summary).toContain('plain tool calls')
})

test('during setup, an older run-log page fetched with next_cursor is digested too', async ($, on) => {
  engine(on, { remote: FULL_LOG })
  await $.command.run(TYPED_SETUP)

  const called = (await callTool($, 'RemoteTrigger', 'toolu_older', {
    action: 'get_run_log',
    session_id: 'session_01',
    cursor: 'cursor_1',
  })) as unknown as { result: Record<string, unknown> }

  expect(String(called.result.summary)).toContain('quotient digested this log for setup')
  expect(String(called.result.summary).length).toBeLessThanOrEqual(16_000)
})

test('outside setup, a RemoteTrigger run log is left alone', async ($, on) => {
  engine(on, { remote: FULL_LOG })

  const called = (await callTool($, 'RemoteTrigger', 'toolu_log', { action: 'get_run_log', session_id: 'session_01' })) as unknown as {
    result: Record<string, unknown>
  }

  expect(called.result).toEqual(FULL_LOG)
})

test('outside setup, RemoteTrigger replies are left alone', async ($, on) => {
  engine(on, { remote: ROUTINE_LIST })

  const called = (await callTool($, 'RemoteTrigger', 'toolu_list', { action: 'list' })) as unknown as { result: Record<string, unknown> }

  expect(called.result).toEqual(ROUTINE_LIST)
})

test("during setup, a RemoteTrigger reply that isn't a routine list is left alone", async ($, on) => {
  const odd = { status: 'ok', json: 'not json' }
  engine(on, { remote: odd })
  await $.command.run(TYPED_SETUP)

  const called = (await callTool($, 'RemoteTrigger', 'toolu_list', { action: 'list' })) as unknown as { result: Record<string, unknown> }

  expect(called.result).toEqual(odd)
})

const STATUS = { text: "Both review batches are still running. I'll write the summary once they report back.", isFirstOfReply: true }
const REVIEWER_RUNNING = [{ id: 'rev-1', type: 'quotient:setup-reviewer', status: 'running' as const }]

test("while setup's reviewers run, the agent's text is drawn as nothing", async ($, on) => {
  engine(on, { agents: REVIEWER_RUNNING })
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await drawStart($, { cloudRuns: 0, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  expect(await row($, 'AssistantMessage', STATUS)).toBe('')
})

test("once setup's reviewers have reported, the agent's text shows, so an error it writes is seen", async ($, on) => {
  engine(on, { agents: [{ id: 'rev-1', type: 'quotient:setup-reviewer', status: 'completed' }] })
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await drawStart($, { cloudRuns: 0, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  expect(await row($, 'AssistantMessage', STATUS)).toBe("the engine's row")
})

test("outside setup, the agent's text shows even while a reviewer runs", async ($, on) => {
  engine(on, { agents: REVIEWER_RUNNING })
  engineRows(on)

  expect(await row($, 'AssistantMessage', STATUS)).toBe("the engine's row")
})

test("when quotient can't check transcripts for teammates' fixes, setup_start lists no batches", async ($, on) => {
  engine(on, { teammateGrepFails: true })
  await $.command.run(TYPED_SETUP)

  const { called } = await drawStart($, { cloudRuns: 10, firstDay: 'Oct 15', lastDay: 'Oct 29' })

  expect(String(called.result)).toContain('quotient counted 64 sessions and 3 automated runs')
  expect(String(called.result)).not.toContain('Batch 1')
})

test("setup_start takes the model's own counts when quotient can't count", async ($, on) => {
  engine(on, { runFails: true })
  await $.command.run(TYPED_SETUP)

  const { called, shown } = await drawStart($, { ...START, sessions: 5, automatedRuns: 1 })

  expect(String(called.result)).not.toContain('quotient counted')
  expect(shown).toContain('Reviewing 5 sessions, 1 automated run and 10 cloud routine runs')
})

test('setup_start draws the two start lines and tells the model to go on quietly', async ($, on) => {
  engine(on)

  const { called, texts, shown } = await drawStart($, START)

  expect(called.result).toBe(GO_ON)
  expectInOrder(shown, [
    'Reviewing 64 sessions, 3 automated runs and 10 cloud routine runs from Oct 15 to Oct 29',
    'This can take some time. You can keep working in another session while it runs.',
  ])
  expect(texts.find(one => one.text.startsWith('This can take'))?.props.dimColor).toBe(true)
})

test("an invited operator's start line says setup also checks their setup for teammates' fixes", async ($, on) => {
  engine(on)

  const { called, shown } = await drawStart($, { ...START, checksTeammates: true })

  expect(called.result).toBe(GO_ON)
  expectInOrder(shown, [
    "Reviewing 64 sessions, 3 automated runs and 10 cloud routine runs from Oct 15 to Oct 29, and checking your setup for fixes to your teammates' frictions",
    'This can take some time. You can keep working in another session while it runs.',
  ])
})

test('a start call with checksTeammates false draws the usual start line', async ($, on) => {
  engine(on)

  const { shown } = await drawStart($, { ...START, checksTeammates: false })

  expect(shown).toContain('Reviewing 64 sessions, 3 automated runs and 10 cloud routine runs from Oct 15 to Oct 29\n')
  expect(shown).not.toContain('teammates')
})

test('counts of one in the start message are singular', async ($, on) => {
  engine(on)

  const { shown } = await drawStart($, { ...START, sessions: 1, automatedRuns: 1, cloudRuns: 0 }, 'desktop')

  expect(shown).toContain('Reviewing 1 session and 1 automated run from Oct 15 to Oct 29')
  expect(shown).not.toContain('Dry run')
})

test('an operator on their first setup since joining sees the company they joined above the start lines', async ($, on) => {
  engine(on, { joinedCompany: { name: 'Northwind Robotics' } })
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'start_setup_run', 'toolu_run')

  const { texts, shown } = await drawStart($, START)

  expectInOrder(shown, ['Joined Northwind Robotics', 'Reviewing 64 sessions'])
  expect(texts.find(one => one.text === '✓')?.props.color).toBe('success')
})

test("the model reads start_setup_run's reply without the company the operator joined", async ($, on) => {
  engine(on, { joinedCompany: { name: 'Northwind Robotics' } })
  await $.command.run(TYPED_SETUP)

  const called = await callQuotient($, 'start_setup_run', 'toolu_run')

  expect(JSON.stringify(called)).not.toContain('joinedCompany')
  expect(JSON.stringify(called)).not.toContain('Northwind')
  expect(JSON.stringify(called)).toContain('run-1')
})

test("escape sequences in the joined company's name are drawn as plain text", async ($, on) => {
  engine(on, { joinedCompany: { name: 'Northwind\x1b[31m Robotics' } })
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'start_setup_run', 'toolu_run')

  const { shown } = await drawStart($, START)

  expect(shown).toContain('Joined Northwind Robotics')
  expect(shown).not.toContain('\x1b')
})

for (const [why, joinedCompany] of [
  ['null', null],
  ['left out', undefined],
  ['a name that is not text', { name: 3 }],
  ['an empty name', { name: '' }],
  ['not an object', 'Northwind Robotics'],
] as const) {
  test(`a start_setup_run reply whose joinedCompany is ${why} shows no joined line`, async ($, on) => {
    engine(on, { joinedCompany })
    await $.command.run(TYPED_SETUP)
    await callQuotient($, 'start_setup_run', 'toolu_run')

    const { shown } = await drawStart($, START)

    expect(shown).not.toContain('Joined')
  })
}

test('the start line leaves out the counts that are 0', async ($, on) => {
  engine(on)

  const { shown } = await drawStart($, { ...START, automatedRuns: 0 })

  expect(shown).toContain('Reviewing 64 sessions and 10 cloud routine runs from Oct 15 to Oct 29')
})

test("a start line with only sessions still says setup checks teammates' fixes", async ($, on) => {
  engine(on)

  const { shown } = await drawStart($, { ...START, sessions: 58, automatedRuns: 0, cloudRuns: 0, checksTeammates: true })

  expect(shown).toContain(
    "Reviewing 58 sessions from Oct 15 to Oct 29, and checking your setup for fixes to your teammates' frictions",
  )
})

test('a start line with nothing to review says so', async ($, on) => {
  engine(on)

  const { shown } = await drawStart($, { ...START, sessions: 0, automatedRuns: 0, cloudRuns: 0 })

  expect(shown).toContain('Reviewing no sessions from Oct 15 to Oct 29')
})

for (const [why, change, message] of [
  ['a negative count', { sessions: -1 }, 'sessions: must be a whole number of at least 0'],
  ['a fractional count', { cloudRuns: 1.5 }, 'cloudRuns: must be a whole number of at least 0'],
  ['a missing count', { automatedRuns: undefined }, 'automatedRuns: must be a whole number of at least 0'],
  ['a day not written as Mon D', { firstDay: '2026-10-15' }, 'firstDay: must be a day like Oct 15'],
  ['a day with a leading zero', { lastDay: 'Nov 02' }, 'lastDay: must be a day like Oct 15'],
  ['a checksTeammates that is not true or false', { checksTeammates: 'yes' }, 'checksTeammates: must be true or false'],
] as const) {
  test(`setup_start refuses ${why}`, async ($, on) => {
    engine(on)
    engineRows(on)

    const { called, shown } = await drawStart($, { ...START, ...change })

    expect(called.deny).toBe(message)
    expect(shown).toBe("the engine's row")
  })
}

test("the start call's result row is hidden", async ($, on) => {
  engine(on)
  engineRows(on)
  await drawStart($, START)

  const ui = await $.ui.mount({
    plugin: 'quotient',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'toolu_start',
    props: { tool_use_id: 'toolu_start', tool: START_TOOL, output: GO_ON, isErrored: false, isExpanded: false },
  })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()

  expect(texts).toEqual([])
})

const TYPED_SETUP = {
  command: 'quotient:setup',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

/**
 * Joins the text of every Text element in a drawn tree, one line each.
 *
 * @param node - A drawn element, or one of its string children
 * @returns The joined text
 */
function textOf(node: unknown): string {
  if (typeof node !== 'object' || node === null) return ''
  const { type, children = [] } = node as { type: string; children?: unknown[] }
  if (type === 'Text') return children.filter(child => typeof child === 'string').join('')
  return children.map(textOf).filter(text => text !== '').join('\n')
}

/**
 * Collects the rows quotient drew in a drawn tree. The band shows one row for
 * each plugin that draws one, stacked or alone depending on Claude Code's
 * version, and each row carries the plugin that drew it.
 *
 * @param node - A drawn element, or one of its string children
 * @returns Quotient's rows
 */
function quotientRows(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return []
  const { part, children = [] } = node as { part?: { plugin?: string }; children?: unknown[] }
  if (part?.plugin === 'quotient') return [node]
  return children.flatMap(quotientRows)
}

/**
 * Draws the band above the prompt and returns quotient's row in it.
 *
 * @param $ - The engine
 * @returns The joined text of quotient's row, or '' when quotient passes
 */
async function band($: Parameters<TestBody>[0]) {
  const ui = await $.ui.mount({
    plugin: 'quotient',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as Parameters<typeof $.ui.mount>[0])
  const drawn = await ui.drawn()
  await ui.unmount()
  return quotientRows(drawn).map(textOf).join('\n')
}

/**
 * Records sources the way the setup skill does.
 *
 * @param $ - The engine
 * @param id - The call's id
 * @param sources - The sources the batch reviewed
 * @param prefix - The server's tool-name prefix
 */
function recordReviewed($: Parameters<TestBody>[0], id: string, sources = ['session-a', 'session-b'], prefix = AGEX) {
  return callQuotient($, 'record_setup_progress', id, { runId: 'run-1', sources }, prefix)
}

test('the band and status line say setup is getting ready, then count the sources reviewed', async ($, on) => {
  const seen = engine(on)
  engineRows(on)

  await $.command.run(TYPED_SETUP)
  const ready = await band($)
  await callQuotient($, 'start_setup_run', 'toolu_run')
  await drawStart($, START)
  const started = await band($)
  await recordReviewed($, 'toolu_add')
  const counted = await band($)
  // A source recorded again counts once, as Quotient counts it.
  await recordReviewed($, 'toolu_again', ['session-b', 'session-c'], CONNECTOR)

  expect(ready).toBe('Quotient setup is getting ready…')
  expect(started).toBe('0 of 77 sources reviewed')
  expect(counted).toBe('2 of 77 sources reviewed')
  expect(await band($)).toBe('3 of 77 sources reviewed')
  // start_setup_run's reply is read before the start message, so the line still says it's getting ready.
  expect(seen.status.slice(0, 4)).toEqual([
    'setup is getting ready…',
    'setup is getting ready…',
    'setup · 0 of 77 sources reviewed',
    'setup · 2 of 77 sources reviewed',
  ])
})

test('a resumed run counts the sources Quotient already recorded', async ($, on) => {
  engine(on, { reviewed: ['session-a', 'session-b', 'session-c'] })
  engineRows(on)

  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'start_setup_run', 'toolu_run')
  await drawStart($, START)

  expect(await band($)).toBe('3 of 77 sources reviewed')
})

test('quotient draws no row in the band when no setup is running', async ($, on) => {
  engine(on)
  engineRows(on)

  expect(await band($)).toBe('')
})

test('a failed record_setup_progress leaves the last count in place', async ($, on) => {
  engine(on, { reviewed: ['session-a'], failing: 'record_setup_progress' })
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'start_setup_run', 'toolu_run')
  await drawStart($, START)

  await recordReviewed($, 'toolu_add')

  expect(await band($)).toBe('1 of 77 sources reviewed')
})

test('a failed start_setup_run leaves the count at zero', async ($, on) => {
  engine(on, { failing: 'start_setup_run' })
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'start_setup_run', 'toolu_run')
  await drawStart($, START)

  expect(await band($)).toBe('0 of 77 sources reviewed')
})

for (const [why, end] of [
  ['the summary is shown', ($: Parameters<TestBody>[0]) => callSummary($, SAVED)],
  [
    'the operator submits a prompt of their own',
    ($: Parameters<TestBody>[0]) =>
      $.prompt.submit({ text: 'what else?', wait: false, origin: { kind: 'composer' } } as Parameters<
        typeof $.prompt.submit
      >[0]),
  ],
  [
    'a turn is interrupted',
    ($: Parameters<TestBody>[0]) =>
      $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' }),
  ],
  [
    'the session ends',
    ($: Parameters<TestBody>[0]) =>
      $.session.end({ reason: 'other', sessionId: 's1', resume: {} } as unknown as Parameters<
        typeof $.session.end
      >[0]),
  ],
] as const) {
  test(`the run ends, and the band and status line clear, when ${why}`, async ($, on) => {
    const seen = engine(on)
    engineRows(on)
    await $.command.run(TYPED_SETUP)
    await drawStart($, START)
    const before = await band($)

    await end($)

    expect(before).toBe('0 of 77 sources reviewed')
    expect(await band($)).toBe('')
    expect(seen.status.at(-1)).toBeUndefined()
  })
}

test("a fix-status read during a run leaves setup's line, and shows once the run ends", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { newFixes: 1 })
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await drawStart($, START)

  await $.turn.complete({ answer: 'waiting', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  const during = [...seen.status]
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })

  expect(during.every(text => text?.startsWith('setup'))).toBe(true)
  expect(seen.status.at(-1)).toBe('1 friction to fix · run /list-fixes')
})

for (const [why, keep] of [
  [
    'a turn ends on its own while subagents work',
    ($: Parameters<TestBody>[0]) =>
      $.turn.complete({ answer: 'waiting', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }),
  ],
  [
    'a subagent reports back',
    ($: Parameters<TestBody>[0]) =>
      $.prompt.submit({
        text: 'task done',
        wait: false,
        isMeta: true,
        origin: { kind: 'task-notification' },
      } as unknown as Parameters<typeof $.prompt.submit>[0]),
  ],
  [
    'the /quotient:setup prompt itself is submitted',
    ($: Parameters<TestBody>[0]) =>
      $.prompt.submit({
        text: '/quotient:setup',
        wait: false,
        command: { name: 'quotient:setup', args: '' },
        origin: { kind: 'composer' },
      } as Parameters<typeof $.prompt.submit>[0]),
  ],
] as const) {
  test(`the run goes on when ${why}`, async ($, on) => {
    engine(on)
    engineRows(on)
    await $.command.run(TYPED_SETUP)
    await drawStart($, START)

    await keep($)

    expect(await band($)).toBe('0 of 77 sources reviewed')
  })
}

/**
 * Draws one transcript row and returns its text.
 *
 * @param $ - The engine
 * @param component - The row's component
 * @param props - Its props
 * @param requestId - Its id
 * @returns The row's joined text: empty when hidden, the engine's row when passed on
 */
async function row(
  $: Parameters<TestBody>[0],
  component: 'ToolUse' | 'ToolResult' | 'ToolGroup' | 'UserMessage' | 'AssistantMessage',
  props: Record<string, unknown>,
  requestId = 'row',
) {
  const ui = await $.ui.mount({ plugin: 'quotient', surface: 'terminal', component, requestId, props } as Parameters<
    typeof $.ui.mount
  >[0])
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(text => text.text).join('\n')
}

/**
 * The props of a Bash call's row.
 *
 * @param id - The call's id
 * @param isExpanded - Whether the row is drawn in full, as in ctrl+o
 * @returns The props
 */
function bashRow(id: string, isExpanded = false) {
  return {
    tool_use_id: id,
    tool: 'Bash',
    input: { command: 'ls' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    isExpanded,
    output: { stdout: '', stderr: '' },
  }
}

/**
 * The props of a group of Bash calls.
 *
 * @param ids - The calls' ids
 * @returns The props
 */
function groupRow(ids: string[]) {
  return {
    calls: ids.map(id => ({ tool_use_id: id, tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false })),
    isActive: false,
    isExpanded: false,
    isCallsOnly: true,
  }
}

test("setup's own tool rows are hidden, and ctrl+o shows them", async ($, on) => {
  engine(on)
  engineRows(on)
  await callQuotient($, 'start_setup_run', 'toolu_before')
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'start_setup_run', 'toolu_mine')

  expect(await row($, 'ToolUse', bashRow('toolu_mine'), 'toolu_mine')).toBe('')
  expect(
    await row($, 'ToolResult', { tool_use_id: 'toolu_mine', tool: 'Bash', output: {}, isErrored: false, isExpanded: false }, 'toolu_mine'),
  ).toBe('')
  expect(await row($, 'ToolUse', bashRow('toolu_mine', true), 'toolu_mine')).toBe("the engine's row")
  expect(await row($, 'ToolUse', bashRow('toolu_before'), 'toolu_before')).toBe("the engine's row")
})

test('a group is hidden only when every call in it is setup’s and it holds nothing else', async ($, on) => {
  engine(on)
  engineRows(on)
  await callQuotient($, 'submit_frictions', 'toolu_before')
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'submit_frictions', 'toolu_a')
  await recordReviewed($, 'toolu_b')

  expect(await row($, 'ToolGroup', groupRow(['toolu_a', 'toolu_b']))).toBe('')
  expect(await row($, 'ToolGroup', groupRow(['toolu_before', 'toolu_a']))).toBe("the engine's row")
  expect(await row($, 'ToolGroup', { ...groupRow(['toolu_a']), isCallsOnly: false })).toBe("the engine's row")
  expect(await row($, 'ToolGroup', { ...groupRow(['toolu_a']), isExpanded: true })).toBe("the engine's row")
})

test("rows after the run ends aren't hidden, and setup's earlier rows stay hidden", async ($, on) => {
  engine(on)
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'submit_frictions', 'toolu_mine')
  await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind: 'composer' } } as Parameters<
    typeof $.prompt.submit
  >[0])
  await callQuotient($, 'submit_frictions', 'toolu_after')

  expect(await row($, 'ToolUse', bashRow('toolu_after'), 'toolu_after')).toBe("the engine's row")
  expect(await row($, 'ToolUse', bashRow('toolu_mine'), 'toolu_mine')).toBe('')
})

test("a setup subagent's report-back and finished rows are hidden, and others' aren't", async ($, on) => {
  engine(on)
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'toolu_agent',
    description: 'Review a batch',
    prompt: 'Review these sessions',
    subagent_type: 'general-purpose',
  })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_sub', command: 'ls', agentId: 'agent-1' })
  const message = (extra: Record<string, unknown>) => ({ text: 'ok', isExpanded: false, ...extra })

  expect(await row($, 'UserMessage', message({ origin: { kind: 'peer' }, from: { name: 'general-purpose' } }))).toBe('')
  expect(
    await row($, 'UserMessage', message({ origin: { kind: 'task-notification' }, task: { id: 'other', toolUseId: 'toolu_agent' } })),
  ).toBe('')
  expect(await row($, 'UserMessage', message({ origin: { kind: 'task-notification' }, task: { id: 'agent-1' } }))).toBe('')
  expect(
    await row($, 'UserMessage', message({ origin: { kind: 'task-notification' }, task: { id: 'agent-9', toolUseId: 'toolu_x' } })),
  ).toBe("the engine's row")
  expect(await row($, 'UserMessage', message({ origin: { kind: 'peer' }, from: { name: 'Explore' } }))).toBe(
    "the engine's row",
  )
  expect(await row($, 'UserMessage', message({ origin: { kind: 'composer' } }))).toBe("the engine's row")
  expect(
    await row($, 'UserMessage', message({ origin: { kind: 'peer' }, from: { name: 'general-purpose' }, isExpanded: true })),
  ).toBe("the engine's row")
})

for (const [what, call] of [
  ['a read of a session transcript', { tool: 'Read', file_path: `${PROJECTS}/-repo/abc.jsonl` }],
  ['a search of the transcripts', { tool: 'Grep', pattern: 'error', path: `${PROJECTS}/-repo` }],
  ['a glob of the transcripts', { tool: 'Glob', pattern: `${PROJECTS}/*/*.jsonl` }],
  ['a routine listing', { tool: 'RemoteTrigger', action: 'list' }],
  ['a tool search', { tool: 'ToolSearch', query: 'select:RemoteTrigger' }],
  ['a read of the user settings', { tool: 'Read', file_path: `${CONFIG}/settings.json` }],
  ['a read of the user CLAUDE.md through ~', { tool: 'Read', file_path: '~/.claude/CLAUDE.md' }],
  ['a search of the installed plugins', { tool: 'Grep', pattern: 'eslint', path: `${CONFIG}/plugins` }],
  ['a glob of the auto-memories', { tool: 'Glob', pattern: `${CONFIG}/projects/*/memory/*.md` }],
  ['a glob inside the installed skills', { tool: 'Glob', path: `${CONFIG}/skills`, pattern: '**/SKILL.md' }],
  ['the find-solutions skill call', { tool: 'Skill', skill: 'quotient:find-solutions' }],
  ...[
    'start_setup_run',
    'record_setup_progress',
    'submit_frictions',
    'finish_setup_run',
    'list_teammate_frictions',
    'submit_solutions',
    'submit_solution',
  ].flatMap(tool =>
    [AGEX, CONNECTOR].map(prefix => [`call to ${prefix}${tool}`, { tool: `${prefix}${tool}` }] as const),
  ),
] as const) {
  test(`setup's ${what} is hidden`, async ($, on) => {
    engine(on)
    engineRows(on)
    await $.command.run(TYPED_SETUP)
    await $.tool.call({ ...call, tool_use_id: 'toolu_x' } as unknown as Parameters<typeof $.tool.call>[0])

    expect(await row($, 'ToolUse', { ...bashRow('toolu_x'), tool: call.tool }, 'toolu_x')).toBe('')
  })
}

for (const [what, call] of [
  ['another shell command', { tool: 'Bash', command: 'rm -rf build' }],
  ['another Quotient tool', { tool: `${AGEX}list_my_frictions` }],
  ['a look-alike setup tool on another server', { tool: 'mcp__other__submit_frictions' }],
  ['a look-alike setup tool name', { tool: `${AGEX}submit_frictions_now` }],
  ['a read outside the transcripts', { tool: 'Read', file_path: '/home/op/.ssh/id_ed25519' }],
  ['a read that climbs out of the transcripts', { tool: 'Read', file_path: `${PROJECTS}/../../.ssh/id_ed25519` }],
  ['another skill', { tool: 'Skill', skill: 'commit-commands:commit' }],
  ['a read of the sign-in tokens', { tool: 'Read', file_path: `${CONFIG}/.credentials.json` }],
  ['a search of the sign-in tokens', { tool: 'Grep', pattern: 'token', path: `${CONFIG}/.credentials.json` }],
  ['a search of the whole config folder', { tool: 'Grep', pattern: 'token', path: CONFIG }],
  ['a search of the whole config folder through ~', { tool: 'Grep', pattern: 'token', path: '~/.claude/' }],
  ['a glob of the whole config folder', { tool: 'Glob', pattern: `${CONFIG}/*` }],
  ['a glob whose pattern climbs out of an expected folder', { tool: 'Glob', path: `${CONFIG}/plugins`, pattern: '../.credentials.json' }],
  ['a glob whose pattern is absolute under an expected folder', { tool: 'Glob', path: `${CONFIG}/plugins`, pattern: '/home/op/.ssh/*' }],
  ['a read of another file in the config folder', { tool: 'Read', file_path: `${CONFIG}/history.jsonl` }],
  ['a write to a repo file', { tool: 'Write', file_path: '/repo/src/app.ts', content: 'x' }],
  ['an edit of a repo file', { tool: 'Edit', file_path: '/repo/CLAUDE.md', old_string: 'a', new_string: 'b' }],
  ['a read of a probe session run from a temporary folder', { tool: 'Read', file_path: `${PROJECTS}/-private-tmp-claude-501-scratchpad-probe/a.jsonl` }],
  ['a read of one of quotient\'s own daily runs', { tool: 'Read', file_path: `${PROJECTS}/-home-op--local-share-quotient/a.jsonl` }],
  ['a search of every project folder at once', { tool: 'Grep', pattern: 'error', path: PROJECTS }],
  ['a fetch', { tool: 'WebFetch', url: 'https://example.com', prompt: 'read' }],
] as const) {
  test(`${what} during setup stays visible`, async ($, on) => {
    engine(on)
    engineRows(on)
    await $.command.run(TYPED_SETUP)
    await $.tool.call({ ...call, tool_use_id: 'toolu_y' } as unknown as Parameters<typeof $.tool.call>[0])

    expect(await row($, 'ToolUse', { ...bashRow('toolu_y'), tool: call.tool }, 'toolu_y')).toBe("the engine's row")
  })
}

test("when the folders can't be looked up, reads during setup stay visible", async ($, on) => {
  engine(on, { runFails: true })
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r', file_path: `${PROJECTS}/-repo/abc.jsonl` })

  expect(await row($, 'ToolUse', { ...bashRow('toolu_r'), tool: 'Read' }, 'toolu_r')).toBe("the engine's row")
})

test('the mod runs no CLI of its own', async ($, on) => {
  const seen = engine(on)
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'start_setup_run', 'toolu_run')

  // Only system tools: the shell that looks up its folders, and find and grep over the transcripts.
  expect(seen.argv.every(argv => ['sh', 'find', 'grep'].includes(argv[0] ?? ''))).toBe(true)
})

test("running setup again keeps the first run's rows hidden", async ($, on) => {
  engine(on)
  engineRows(on)
  await $.command.run(TYPED_SETUP)
  await callQuotient($, 'submit_frictions', 'toolu_first')
  await $.prompt.submit({ text: 'try again', wait: false, origin: { kind: 'composer' } } as Parameters<
    typeof $.prompt.submit
  >[0])

  await $.command.run(TYPED_SETUP)

  expect(await row($, 'ToolUse', bashRow('toolu_first'), 'toolu_first')).toBe('')
})
