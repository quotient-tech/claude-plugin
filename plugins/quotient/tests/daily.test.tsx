import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { CLAIMED_KEY, launchArgs, sideLoadedRoot } from '../hooks/daily'
import { denial } from './fixtures/denial'

type On = Parameters<TestBody>[1]
type Connect =
  | { isConnected: true; server: string }
  | { isConnected: false; reason: 'unlisted' | 'auth' | 'failed'; message: string }

type Kind = 'find-solutions' | 'review-frictions'

const SERVER = 'plugin:quotient:agex'
const CONNECTOR = 'claude.ai Quotient'
const INTERACTIVE = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const HEADLESS = { cwd: '/data', surface: null, isInteractive: false } as const
const NOT_DUE = '{"due":false}'
const HOUR_MS = 60 * 60 * 1000
const DENIED =
  "Quotient's daily runs didn't start: Claude Code denied the call to Quotient. Why: https://github.com/quotient-tech/claude-plugin#if-claude-code-denies-quotients-calls"
// Starts the run detached from the session, in its own folder, after
// checking that claude can be found; the run's arguments follow the folder.
const LAUNCH =
  'command -v "$2" >/dev/null || exit 127; mkdir -p "$1" && cd "$1" || exit 1; shift; nohup "$@" </dev/null >/dev/null 2>&1 &'

/**
 * A `claim_daily_run` reply that says the run is due.
 *
 * @param runId - The claimed run's id
 * @returns The reply's text
 */
function due(runId: string): string {
  return JSON.stringify({ due: true, runId, resumed: false })
}

/**
 * The argument list that starts one daily run.
 *
 * @param kind - Which daily run
 * @param runId - The claimed run's id
 * @param tools - The Quotient tools the run may call, by their full names
 * @param folder - Where the run starts
 * @param projects - The project folders the prompt names after the run id
 * @param config - The Claude Code config folder the prompt names on its own line
 * @returns What `$.process.run` should receive
 */
function launch(
  kind: Kind,
  runId: string,
  tools: string[],
  folder = '/home/op/.local/share/quotient',
  projects: string[] = [],
  config = '/home/op/.claude',
): string[] {
  const named = [`/quotient:${kind} daily ${runId}`, ...projects].join(' ')
  return [
    'sh',
    '-c',
    LAUNCH,
    'sh',
    folder,
    'claude',
    '-p',
    `${named}\n\nYour Claude Code config folder: \`${config}\``,
    '--tools',
    'Read',
    'Grep',
    'Glob',
    '--settings',
    '{"outputStyle":"default"}',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    ...tools,
  ]
}

/**
 * Answers the mod's calls the way the engine would, and records them.
 *
 * @param on - The test's hooks, which stand for the engine
 * @param opts.connect - What `$.mcp.connect("agex")` resolves to
 * @param opts.claims - The text of each kind's `claim_daily_run` reply; not due when absent
 * @param opts.callFails - Whether every tool call rejects
 * @param opts.denied - The tools Claude Code denies, and for `claim_daily_run` only these kinds' claims
 * @param opts.env - The environment the mod reads, over a home folder of `/home/op`
 * @param opts.wait - Holds each tool reply until the test moves the clock this far
 * @param opts.launchExit - Each run's launch exit code, by the first line of the prompt it starts; 0 when absent
 * @param opts.launchRejects - Whether every launch rejects
 * @param opts.transcripts - What `find` lists as the recent transcripts, or `rejects`
 * @param opts.findExit - The exit code of that `find`, 0 when absent
 * @param opts.isFindTruncated - Whether that `find`'s output was cut off
 * @param opts.store - What the plugin's store holds at the start
 * @returns What the mod connected, called, launched and logged to the transcript and to
 *   the debug log, how many calls were answered, and how many reads the fix-status
 *   part, the invite reminder and the thank-yous check made
 */
function engine(
  on: On,
  opts: {
    connect?: Connect
    claims?: Partial<Record<Kind, string>>
    callFails?: boolean
    denied?: { claims?: Kind[]; completes?: boolean }
    env?: Record<string, string>
    wait?: { clock: ReturnType<typeof mock.clock>; ms: number; kind?: Kind }
    launchExit?: Record<string, number>
    launchRejects?: boolean
    transcripts?: string[] | 'rejects'
    findExit?: number
    isFindTruncated?: boolean
    store?: Record<string, unknown>
  } = {},
) {
  const seen = {
    connected: [] as string[],
    found: [] as (readonly string[])[],
    calls: [] as { server: string; tool: string; args: Record<string, unknown> }[],
    launched: [] as (readonly string[])[],
    pluginDirs: [] as string[],
    launchEnv: [] as (Record<string, string> | undefined)[],
    logs: [] as string[],
    debugged: [] as string[],
    answered: 0,
    otherReads: 0,
    store: { ...opts.store } as Record<string, unknown>,
  }
  mock.env(on, { HOME: '/home/op', ...opts.env })
  on('store.get', (_, e) => ({ value: seen.store[e.key] }))
  on('store.set', (_, e) => {
    seen.store[e.key] = e.value
    return { value: undefined }
  })
  on('mcp.connect', (_, e) => {
    seen.connected.push(e.server)
    return { value: opts.connect ?? { isConnected: true, server: SERVER } }
  })
  on('mcp.call', async (_, e) => {
    // The fix-status part, the invite reminder and the thank-yous check read
    // on their own; their reads are counted apart, so these tests see only the daily runs' calls.
    if (e.tool === 'list_my_frictions') {
      seen.otherReads += 1
      return { value: { content: [{ type: 'text', text: '{"frictions":[],"nextCursor":null}' }], isError: false } }
    }
    if (e.tool === 'list_thank_yous') {
      seen.otherReads += 1
      return { value: { content: [{ type: 'text', text: '{"thankYous":[]}' }], isError: false } }
    }
    if (e.tool === 'get_invite_link') {
      seen.otherReads += 1
      return { value: { content: [{ type: 'text', text: '{"remindToInvite":false}' }], isError: false } }
    }
    seen.calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (opts.wait !== undefined && (opts.wait.kind ?? e.args.kind) === e.args.kind) await opts.wait.clock.sleep(opts.wait.ms)
    seen.answered += 1
    if (opts.callFails) throw new Error('call failed')
    const isDenied =
      e.tool === 'claim_daily_run'
        ? (opts.denied?.claims ?? []).includes(e.args.kind as Kind)
        : e.tool === 'complete_daily_run' && opts.denied?.completes === true
    if (isDenied) return { deny: denial(e.server, e.tool) }
    const text =
      e.tool === 'claim_daily_run'
        ? (opts.claims?.[e.args.kind as Kind] ?? NOT_DUE)
        : JSON.stringify({ completedAt: '2026-11-05T12:00:00Z' })
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'find') {
      seen.found.push(e.argv)
      if (opts.transcripts === 'rejects') throw new Error('find failed')
      const stdout = (opts.transcripts ?? []).map(file => `${file}\n`).join('')
      const isStdoutTruncated = opts.isFindTruncated === true
      return { value: { exitCode: opts.findExit ?? 0, stdout, stderr: '', isStdoutTruncated, isStderrTruncated: false } }
    }
    // The harness loads quotient from its own folder, as --plugin-dir does,
    // so each run is told to load that folder. That last pair is kept apart
    // here, so each launch reads the same as an installed session's.
    const isSideLoaded = e.argv.at(-2) === '--plugin-dir'
    if (isSideLoaded) seen.pluginDirs.push(e.argv.at(-1) ?? '')
    seen.launched.push(isSideLoaded ? e.argv.slice(0, -2) : e.argv)
    seen.launchEnv.push(e.init?.env)
    if (opts.launchRejects) throw new Error('launch failed')
    const exitCode = opts.launchExit?.[(e.argv[7] ?? '').split('\n')[0] ?? ''] ?? 0
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', (_, e) => {
    if (e.to === 'debug') seen.debugged.push(e.text)
    else seen.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quotient__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return seen
}

test('a headless session claims nothing, so a daily run never starts another', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(HEADLESS)
  await clock.settle()

  expect(seen.connected).toEqual([])
  expect(seen.calls).toEqual([])
})

test('a cloud session claims nothing', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { env: { CLAUDE_CODE_REMOTE: 'true' } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  // Each connect left was the fix-status part's, the invite reminder's or the
  // thank-yous check's own.
  expect(seen.connected.length).toBe(seen.otherReads)
  expect(seen.calls).toEqual([])
})

test('a local session claims each kind of daily run as local', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()

  // One connect for the claims; the rest were the fix-status part's, the
  // invite reminder's and the thank-yous check's own.
  expect(seen.connected.length - seen.otherReads).toBe(1)
  expect(seen.connected.every(server => server === 'agex')).toBe(true)
  expect(seen.calls).toEqual([
    { server: SERVER, tool: 'claim_daily_run', args: { kind: 'find-solutions', source: 'local' } },
    { server: SERVER, tool: 'claim_daily_run', args: { kind: 'review-frictions', source: 'local' } },
  ])
})

test('where the host runs the plugin servers itself, it claims through the Quotient connector', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { connect: { isConnected: false, reason: 'unlisted', message: 'run by the host' } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.calls.map(call => call.server)).toEqual([CONNECTOR, CONNECTOR])
})

test('not signed in: it claims nothing and logs one line with the sign-in steps', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { connect: { isConnected: false, reason: 'auth', message: 'needs sign-in' } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.calls).toEqual([])
  expect(seen.logs).toHaveLength(1)
  expect(seen.logs[0]).toContain('not signed in to Quotient')
  expect(seen.logs[0]).toContain('run `/mcp`, select `plugin:quotient:agex`, and sign in')
})

test("a server that won't connect for another reason: it claims nothing and doesn't mention sign-in", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { connect: { isConnected: false, reason: 'failed', message: 'connection refused' } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.calls).toEqual([])
  expect(seen.logs).toEqual([])
})

test("the session's start waits for claims that answer quickly, so quotient's own tool.check decides them", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { wait: { clock, ms: 1_000 } })
  let isStarted = false

  const starting = $.session.start(INTERACTIVE).then(started => {
    isStarted = true
    return started
  })
  await clock.advance(500)
  expect(isStarted).toBe(false)
  await clock.advance(500)

  expect(await starting).toEqual({ cwd: '/repo' })
  expect(seen.answered).toBe(2)
})

test("the session's start sends both claims, then waits for them at most 3 seconds", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { wait: { clock, ms: 20_000 } })
  let isStarted = false

  const starting = $.session.start(INTERACTIVE).then(started => {
    isStarted = true
    return started
  })
  await clock.advance(3_000)

  expect(await starting).toEqual({ cwd: '/repo' })
  expect(isStarted).toBe(true)
  expect(seen.calls.map(call => call.args.kind)).toEqual(['find-solutions', 'review-frictions'])
  expect(seen.answered).toBe(0)
  await clock.advance(17_000)
  expect(seen.answered).toBe(2)
})

test('a server that is down leaves the session starting as usual', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { callFails: true })

  const started = await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(started).toEqual({ cwd: '/repo' })
  expect(seen.logs).toEqual([])
})

test('a server that is down logs each failed claim with its reason to the debug log only', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { callFails: true })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.logs).toEqual([])
  expect(seen.debugged.filter(line => line.startsWith('quotient daily: claim_daily_run failed: '))).toHaveLength(2)
})

test('claims Claude Code denied: one line says the runs did not start and why, and the debug log has each reason', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { denied: { claims: ['find-solutions', 'review-frictions'] } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.logs).toEqual([DENIED])
  expect(seen.debugged.filter(line => line.startsWith('quotient daily: claim_daily_run denied: '))).toHaveLength(2)
})

test('one claim denied while the other kind was not due still says the runs did not start', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { denied: { claims: ['find-solutions'] } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.logs).toEqual([DENIED])
})

test('one claim denied while the other kind started says only which run started', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { denied: { claims: ['find-solutions'] }, claims: { 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.logs).toEqual(["Quotient started today's review-frictions run in the background."])
  expect(seen.debugged.filter(line => line.startsWith('quotient daily: claim_daily_run denied: '))).toHaveLength(1)
})

test('completing a run that could not start, when Claude Code denies it, logs the reason to the debug log only', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1') }, launchRejects: true, denied: { completes: true } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.logs).toEqual([])
  expect(seen.debugged.filter(line => line.startsWith('quotient daily: complete_daily_run denied: '))).toHaveLength(1)
})

/**
 * The kinds the mod claimed, in the order it claimed them.
 *
 * @param seen - What the mod called
 * @returns Each claim's kind
 */
function claimedKinds(seen: { calls: { tool: string; args: Record<string, unknown> }[] }): unknown[] {
  return seen.calls.filter(call => call.tool === 'claim_daily_run').map(call => call.args.kind)
}

test('a run this machine claimed is not claimed again for a day, so its permission prompt shows at most once a day', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()
  await clock.advance(23 * HOUR_MS)
  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(claimedKinds(seen)).toEqual(['find-solutions', 'review-frictions'])
  expect(seen.launched).toHaveLength(2)
})

test('a day after this machine claimed a run, the next session claims it again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()
  await clock.advance(24 * HOUR_MS)
  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(claimedKinds(seen)).toEqual(['find-solutions', 'review-frictions', 'find-solutions', 'review-frictions'])
})

test('only the kind this machine claimed is skipped; a kind that was not due is claimed again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()
  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(claimedKinds(seen)).toEqual(['find-solutions', 'review-frictions', 'review-frictions'])
})

test('with both kinds claimed in the last day, the session does not connect for the claims', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()
  const connects = seen.connected.length - seen.otherReads
  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.connected.length - seen.otherReads).toBe(connects)
  expect(seen.logs).toEqual(["Quotient started today's find-solutions and review-frictions runs in the background."])
})

test("a due claim is kept as soon as it returns, while the other kind's claim still waits on its prompt", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') },
    wait: { clock, ms: HOUR_MS, kind: 'review-frictions' },
  })

  const starting = $.session.start(INTERACTIVE)
  await clock.advance(5_000)
  await starting

  expect(Object.keys(seen.store[CLAIMED_KEY] ?? {})).toEqual(['find-solutions'])
  await clock.advance(HOUR_MS)
  expect(Object.keys(seen.store[CLAIMED_KEY] ?? {}).sort()).toEqual(['find-solutions', 'review-frictions'])
})

test('a claim Claude Code denied is not kept, so the next session claims again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { denied: { claims: ['find-solutions', 'review-frictions'] } })

  await $.session.start(INTERACTIVE)
  await clock.settle()
  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(claimedKinds(seen)).toHaveLength(4)
  expect(seen.store[CLAIMED_KEY]).toBeUndefined()
})

test('a run claimed but unable to start is still kept, since the server marks it failed and waits a day', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1') }, launchRejects: true })

  await $.session.start(INTERACTIVE)
  await clock.settle()
  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(claimedKinds(seen)).toEqual(['find-solutions', 'review-frictions', 'review-frictions'])
})

const UNREADABLE_CLAIM_TIMES = [
  { scenario: 'anything but an object of times', stored: ['find-solutions'] },
  { scenario: 'a time that is not a number', stored: { 'find-solutions': '2026-11-24', 'review-frictions': null } },
  {
    scenario: 'a time ahead of the clock',
    stored: { 'find-solutions': Number.MAX_SAFE_INTEGER, 'review-frictions': Number.MAX_SAFE_INTEGER },
  },
]
for (const { scenario, stored } of UNREADABLE_CLAIM_TIMES) {
  test(`a store holding ${scenario} claims both kinds`, async ($, on) => {
    const clock = mock.clock(on)
    const seen = engine(on, { store: { [CLAIMED_KEY]: stored } })

    await $.session.start(INTERACTIVE)
    await clock.settle()

    expect(claimedKinds(seen)).toEqual(['find-solutions', 'review-frictions'])
  })
}

const FIND_TOOLS = [
  'mcp__plugin_quotient_agex__list_teammate_frictions',
  'mcp__plugin_quotient_agex__submit_solutions',
  'mcp__plugin_quotient_agex__submit_solution',
  'mcp__plugin_quotient_agex__complete_daily_run',
]
const REVIEW_TOOLS = [
  'mcp__plugin_quotient_agex__list_my_frictions',
  'mcp__plugin_quotient_agex__submit_friction',
  'mcp__plugin_quotient_agex__submit_review',
  'mcp__plugin_quotient_agex__complete_daily_run',
  'mcp__quotient__review_sessions',
  'mcp__quotient__review_digest',
]

test('a due run starts detached, in its own folder, with only its own tools', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS)])
})

test('a run started from a session that loaded quotient from outside the plugin cache loads that same folder', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toHaveLength(2)
  expect(seen.pluginDirs).toHaveLength(2)
  expect(seen.pluginDirs[0]).toMatch(/^\//)
  expect(seen.pluginDirs[1]).toBe(seen.pluginDirs[0])
  expect(seen.pluginDirs[0]).not.toMatch(/^\/home\/op\/\.claude\/plugins\/cache\//)
})

test('an installed plugin, in the plugin cache, is not passed on', () => {
  expect(sideLoadedRoot('/home/op/.claude/plugins/cache/quotient/quotient/0.1.2', '/home/op/.claude')).toBeNull()
  expect(sideLoadedRoot('/cfg/plugins/cache/quotient/quotient/0.1.2', '/cfg/')).toBeNull()
})

test('a plugin loaded from anywhere outside the plugin cache is passed on as it is', () => {
  expect(sideLoadedRoot('/src/claude-plugin/plugins/quotient', '/home/op/.claude')).toBe('/src/claude-plugin/plugins/quotient')
  expect(sideLoadedRoot('/home/op/.claude/plugins/cache-old/quotient', '/home/op/.claude')).toBe('/home/op/.claude/plugins/cache-old/quotient')
  expect(sideLoadedRoot('/home/op/.claude/plugins/cache/quotient/quotient/0.1.2', '/cfg')).toBe(
    '/home/op/.claude/plugins/cache/quotient/quotient/0.1.2',
  )
})

test("an installed plugin's run gets the same arguments as before, and a side-loaded one's adds only --plugin-dir at the end", () => {
  const folder = '/home/op/.local/share/quotient'
  expect(launchArgs(folder, SERVER, 'find-solutions', 'run-1', [], '/home/op/.claude', null)).toEqual(launch('find-solutions', 'run-1', FIND_TOOLS))
  expect(launchArgs(folder, SERVER, 'review-frictions', 'run-2', [], '/home/op/.claude', '/src/plugins/quotient')).toEqual([
    ...launch('review-frictions', 'run-2', REVIEW_TOOLS),
    '--plugin-dir',
    '/src/plugins/quotient',
  ])
})

test("each run uses the default output style, whatever the operator's own settings choose", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  for (const argv of seen.launched) {
    const at = argv.indexOf('--settings')
    expect(JSON.parse(argv[at + 1] ?? '')).toEqual({ outputStyle: 'default' })
    expect(at).toBeLessThan(argv.indexOf('--allowedTools'))
  }
  expect(seen.launched).toHaveLength(2)
})

test('each kind that is due starts, with its own tools', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  // Each run starts as soon as it's ready, in no set order.
  expect([...seen.launched].sort((a, b) => (a[7] ?? '').localeCompare(b[7] ?? ''))).toEqual([
    launch('find-solutions', 'run-1', FIND_TOOLS),
    launch('review-frictions', 'run-2', REVIEW_TOOLS),
  ])
})

test("a slow claim doesn't hold up the other kind's run, and one line names both once both settle", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') },
    wait: { clock, ms: 20_000, kind: 'review-frictions' },
  })

  const starting = $.session.start(INTERACTIVE)
  await clock.advance(3_000)
  await starting

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS)])
  expect(seen.logs).toEqual([])
  await clock.advance(17_000)

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS), launch('review-frictions', 'run-2', REVIEW_TOOLS)])
  expect(seen.logs).toEqual(["Quotient started today's find-solutions and review-frictions runs in the background."])
})

test('no run starts that the server did not claim', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on)

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([])
  expect(seen.logs).toEqual([])
})

test('a claim reply that is malformed starts no run', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': '{"due":true}', 'review-frictions': 'not json' },
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([])
})

test("through the Quotient connector, the run's tools carry the connector's prefix", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    connect: { isConnected: false, reason: 'unlisted', message: 'run by the host' },
    claims: { 'review-frictions': due('run-2') },
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([
    launch('review-frictions', 'run-2', [
      'mcp__claude_ai_Quotient__list_my_frictions',
      'mcp__claude_ai_Quotient__submit_friction',
      'mcp__claude_ai_Quotient__submit_review',
      'mcp__claude_ai_Quotient__complete_daily_run',
      'mcp__quotient__review_sessions',
      'mcp__quotient__review_digest',
    ]),
  ])
})

test('the run starts under XDG_DATA_HOME when it is set', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { env: { XDG_DATA_HOME: '/xdg' }, claims: { 'find-solutions': due('run-1') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS, '/xdg/quotient')])
})

test('a run id holding shell characters reaches claude as one argument, unchanged', async ($, on) => {
  const clock = mock.clock(on)
  const runId = '$(touch /tmp/x); rm -rf ~ "`'
  const seen = engine(on, { claims: { 'find-solutions': due(runId) } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('find-solutions', runId, FIND_TOOLS)])
})

test('one line says which runs started', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.logs).toEqual(["Quotient started today's find-solutions and review-frictions runs in the background."])
})

test('a run whose launch fails is completed as failed, and the other kind still starts', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') },
    launchExit: { '/quotient:find-solutions daily run-1': 127 },
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toHaveLength(2)
  expect(seen.calls.filter(call => call.tool === 'complete_daily_run')).toEqual([
    { server: SERVER, tool: 'complete_daily_run', args: { runId: 'run-1', outcome: 'failed' } },
  ])
  expect(seen.logs).toEqual(["Quotient started today's review-frictions run in the background."])
})

test('a launch that rejects completes its run as failed', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1') }, launchRejects: true })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.calls.filter(call => call.tool === 'complete_daily_run')).toEqual([
    { server: SERVER, tool: 'complete_daily_run', args: { runId: 'run-1', outcome: 'failed' } },
  ])
  expect(seen.logs).toEqual([])
})

// The variable marks the run's session as a background run.
test('each run starts with QUOTIENT_DAILY_RUN=1 and its kind in its environment', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1'), 'review-frictions': due('run-2') } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  const kindOf = (env: Record<string, string> | undefined): string => env?.QUOTIENT_DAILY_RUN_KIND ?? ''
  expect([...seen.launchEnv].sort((a, b) => kindOf(a).localeCompare(kindOf(b)))).toEqual([
    { QUOTIENT_DAILY_RUN: '1', QUOTIENT_DAILY_RUN_KIND: 'find-solutions' },
    { QUOTIENT_DAILY_RUN: '1', QUOTIENT_DAILY_RUN_KIND: 'review-frictions' },
  ])
})

// Glob lists files oldest first and stops at 100, so a run can't find the
// recent sessions itself: the prompt names their project folders.
test("a find-solutions run's prompt names each project folder with a session from the last 14 days, once", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': due('run-1') },
    transcripts: [
      '/home/op/.claude/projects/-home-op-api/a.jsonl',
      '/home/op/.claude/projects/-home-op-web/b.jsonl',
      '/home/op/.claude/projects/-home-op-api/c.jsonl',
    ],
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.found).toEqual([
    ['find', '/home/op/.claude/projects', '-mindepth', '2', '-maxdepth', '2', '-type', 'f', '-name', '*.jsonl', '-mtime', '-14'],
  ])
  expect(seen.launched).toEqual([
    launch('find-solutions', 'run-1', FIND_TOOLS, undefined, ['-home-op-api', '-home-op-web']),
  ])
})

test("a find-solutions run's prompt leaves out temporary folders and the daily runs' own", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': due('run-1') },
    transcripts: [
      '/home/op/.claude/projects/-private-tmp-probe/a.jsonl',
      '/home/op/.claude/projects/-home-op--local-share-quotient/b.jsonl',
      '/home/op/.claude/projects/-home-op-api/c.jsonl',
    ],
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS, undefined, ['-home-op-api'])])
})

test('the transcripts are looked up under CLAUDE_CONFIG_DIR when it is set', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1') }, env: { CLAUDE_CONFIG_DIR: '/cfg' } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.found.map(argv => argv[1])).toEqual(['/cfg/projects'])
  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS, undefined, [], '/cfg')])
})

test("a review-frictions run's prompt names the config folder CLAUDE_CONFIG_DIR sets", async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'review-frictions': due('run-2') }, env: { CLAUDE_CONFIG_DIR: '/cfg' } })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('review-frictions', 'run-2', REVIEW_TOOLS, undefined, [], '/cfg')])
})

test('a review-frictions run lists its own sessions, so its prompt names no folders', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'review-frictions': due('run-2') },
    transcripts: ['/home/op/.claude/projects/-home-op-api/a.jsonl'],
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.found).toEqual([])
  expect(seen.launched).toEqual([launch('review-frictions', 'run-2', REVIEW_TOOLS)])
})

test('a find-solutions run still starts, naming no folders, when the transcripts cannot be listed', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { claims: { 'find-solutions': due('run-1') }, transcripts: 'rejects' })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS)])
})

// find exits non-zero when part of the folder can't be read, so its list may
// be missing folders: the run is told none, and searches as if it had none.
test('a find-solutions run whose transcript listing exits non-zero names no folders', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': due('run-1') },
    transcripts: ['/home/op/.claude/projects/-home-op-api/a.jsonl'],
    findExit: 1,
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS)])
})

// Output cut off short can still exit 0, and the folders past the cut would be
// missing from a list the run takes as complete.
test('a find-solutions run whose transcript listing was cut off names no folders', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, {
    claims: { 'find-solutions': due('run-1') },
    transcripts: ['/home/op/.claude/projects/-home-op-api/a.jsonl'],
    isFindTruncated: true,
  })

  await $.session.start(INTERACTIVE)
  await clock.settle()

  expect(seen.launched).toEqual([launch('find-solutions', 'run-1', FIND_TOOLS)])
})
