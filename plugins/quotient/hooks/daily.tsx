// Quotient's daily runs: at the start of an interactive local session, claims
// each kind of daily run from Quotient's server, which decides whether one is
// due today, and starts each claimed run as a headless Claude Code session
// that outlives this one. Cloud sessions claim nothing.
import type { Hook, McpToolResult, Register } from 'claude-code'

import { callFailure, errorText, SERVER_KEY, serverFor } from './state'
import { DENIED_HELP } from './text'

type Api = Parameters<Hook<'session.start'>>[0]
export type Kind = (typeof KINDS)[number]

export const KINDS = ['find-solutions', 'review-frictions'] as const
// How long the session's start waits for the claims. Claude Code decides a
// call's permission as it's sent, so a claim still in flight after this
// finishes on its own; the wait counts toward the hook's 10-second budget.
const CLAIM_WAIT_MS = 3_000
// The only Quotient tools each run may call. A run reads teammates' text,
// which is untrusted, so it gets no Bash, Write or Edit either: --tools
// removes them, and guard.ts denies any other tool the operator's own allow
// rules would let through, and any read outside what the run needs.
export const TOOLS: Record<Kind, string[]> = {
  'find-solutions': ['list_teammate_frictions', 'submit_solutions', 'submit_solution', 'complete_daily_run'],
  'review-frictions': ['list_my_frictions', 'submit_friction', 'submit_review', 'complete_daily_run'],
}
// A child of the mod dies with the session, so the run starts under nohup.
// The folder is $1 and the run's command follows it, so nothing the server
// sends is ever read as shell. Exits non-zero when claude can't be found or
// the folder can't be used; a failure after the start shows no exit code.
const LAUNCH =
  'command -v "$2" >/dev/null || exit 127; mkdir -p "$1" && cd "$1" || exit 1; shift; nohup "$@" </dev/null >/dev/null 2>&1 &'
// Settings that outrank the operator's own for this run only.
const DEFAULT_OUTPUT_STYLE = JSON.stringify({ outputStyle: 'default' })
const DENIED = `Quotient's daily runs didn't start: Claude Code denied the call to Quotient. Why: ${DENIED_HELP}`
const SIGN_IN =
  "Quotient's daily runs didn't start: you're not signed in to Quotient. To sign in, run `/mcp`, select `plugin:quotient:agex`, and sign in."

/**
 * Reads the run id from a `claim_daily_run` reply.
 *
 * @param result - The tool's reply
 * @returns The run id when the run is due, or null when it isn't due or the
 *   reply is anything else
 */
function claimedRunId(result: McpToolResult): string | null {
  const text = result.content.find(block => block.type === 'text')
  if (result.isError || text?.type !== 'text' || typeof text.text !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(text.text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { due, runId } = parsed as Record<string, unknown>
    return due === true && typeof runId === 'string' && runId !== '' ? runId : null
  } catch {
    return null
  }
}

/**
 * Builds the argument list that starts one daily run in its folder.
 *
 * @param folder - Where the run starts
 * @param server - The server the tools come from, as `$.mcp.call` takes it
 * @param kind - Which daily run
 * @param runId - The claimed run's id
 * @returns The argument list for `$.process.run`
 */
function launchArgs(folder: string, server: string, kind: Kind, runId: string): string[] {
  // Claude Code names a server's tools mcp__<server>__<tool>, with each
  // character other than a letter, digit, _ or - in the server's name as _.
  const prefix = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`
  return [
    'sh',
    '-c',
    LAUNCH,
    'sh',
    folder,
    'claude',
    '-p',
    `/quotient:${kind} daily ${runId}`,
    '--tools',
    'Read',
    'Grep',
    'Glob',
    // Nobody reads a daily run's replies, so an output style's extra blocks,
    // such as the explanatory style's Insights, only cost tokens.
    '--settings',
    DEFAULT_OUTPUT_STYLE,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    ...TOOLS[kind].map(tool => prefix + tool),
  ]
}

/**
 * Starts one claimed run, or completes it as failed when it can't start.
 *
 * @param $ - The engine
 * @param folder - Where the run starts
 * @param server - The server the run was claimed on
 * @param kind - Which daily run
 * @param runId - The claimed run's id
 * @returns Whether the run started
 */
async function startRun($: Api, folder: string, server: string, kind: Kind, runId: string): Promise<boolean> {
  try {
    // Marks the run's session as a background run, so its requests aren't
    // counted as the operator's own, and names its kind, so guard.ts holds
    // it to that kind's tools and reads.
    const launched = await $.process.run(launchArgs(folder, server, kind, runId), {
      env: { QUOTIENT_DAILY_RUN: '1', QUOTIENT_DAILY_RUN_KIND: kind },
    })
    if (launched.exitCode === 0) return true
  } catch {
    // Completed as failed below, like a non-zero exit.
  }
  try {
    await $.mcp.call(server, 'complete_daily_run', { runId, outcome: 'failed' })
  } catch (error) {
    // The claim's lease runs out instead, and the next claim resumes the run.
    $.ui.log(`quotient daily: complete_daily_run ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
  }
  return false
}

/**
 * Claims each kind of daily run and starts the ones that are due, unless the
 * operator isn't signed in, in which case it says how to sign in. One kind's
 * failure leaves the other kind's run alone. When Claude Code denied a claim
 * and no run started, one line says so.
 *
 * @param $ - The engine
 */
async function claimRuns($: Api): Promise<void> {
  const home = await $.env.get('HOME')
  if (home === undefined) return
  const folder = `${(await $.env.get('XDG_DATA_HOME')) || `${home}/.local/share`}/quotient`

  const connected = await $.mcp.connect(SERVER_KEY)
  if (!connected.isConnected && connected.reason === 'auth') {
    $.ui.log(SIGN_IN)
    return
  }
  const server = serverFor(connected)
  if (server === null) return

  // Both claims go out at once, so both are sent while the session's start
  // still waits, and each run starts as soon as its own claim returns, so a
  // slow claim never holds up the other kind's run.
  let isDenied = false
  const claims = await Promise.all(
    KINDS.map(async kind => {
      let runId: string | null
      try {
        runId = claimedRunId(await $.mcp.call(server, 'claim_daily_run', { kind, source: 'local' }))
      } catch (error) {
        // The server decides again at the next session's start.
        const failure = callFailure(error)
        $.ui.log(`quotient daily: claim_daily_run ${failure}: ${errorText(error)}`, { to: 'debug' })
        if (failure === 'denied') isDenied = true
        return { kind, isStarted: false }
      }
      return { kind, isStarted: runId !== null && (await startRun($, folder, server, kind, runId)) }
    }),
  )
  const started: Kind[] = claims.filter(claim => claim.isStarted).map(claim => claim.kind)
  if (started.length > 0) {
    const runs = started.length === 1 ? 'run' : 'runs'
    $.ui.log(`Quotient started today's ${started.join(' and ')} ${runs} in the background.`)
  } else if (isDenied) {
    $.ui.log(DENIED)
  }
}

/**
 * Claims and starts the daily runs when an interactive local session starts.
 *
 * @param on - Adds the module's hooks
 */
export const registerDaily: Register = on => {
  // A daily run is itself a headless session, and must not start another.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    if ((await $.env.get('CLAUDE_CODE_REMOTE')) === 'true') return started
    // Claude Code asks quotient's tool.check about its own calls only while
    // one of its hooks is running, so the claims are sent before this
    // returns. It holds the first prompt for at most CLAIM_WAIT_MS.
    await Promise.race([claimRuns($).catch(() => {}), $.clock.sleep(CLAIM_WAIT_MS)])
    return started
  }).catch(($, e, next) => next(e))
}
