// Sends the requests quotient's skills made in this session, its subagents'
// included, to Quotient's `record_usage` tool after each turn. Only the
// fields usageRows keeps leave the machine, plus where the session ran and
// the plugin's version. It hooks turn.complete rather than the classic Stop
// event because a built-in module can take Stop before any plugin sees it.
import type { Hook, McpToolResult, Register } from 'claude-code'

import { callFailure, errorText, SERVER_KEY, serverFor } from './state'
import { usageRows } from './usageRows'
import type { TranscriptFile } from './usageRows'

type Api = Parameters<Hook<'turn.complete'>>[0]
type On = Parameters<Register>[0]
type SendState = { sent: Set<string>; isSending: boolean }

// The largest file `$.fs.read` reads. A transcript past it is skipped, so the
// requests made after it grew past it are never sent.
const MAX_READ_BYTES = 4 * 1024 * 1024
// The most requests `record_usage` takes in one call.
const BATCH_SIZE = 500
// How long a `record_usage` call may take before it counts as failed, so a
// hung call can't keep a `claude -p` run from exiting or stop later sends. A
// `$.clock` wait counts toward a hook's 10 s of its own time, and a `-p` run's
// hook waits for the send, so this stays well under it.
const CALL_TIMEOUT_MS = 5_000

/**
 * Where Claude Code keeps the session's transcript: in its config folder
 * (`CLAUDE_CONFIG_DIR`, or `~/.claude`), under `projects/`, in a folder named
 * for the session's root with each character but a letter or digit turned
 * into `-`, in a file
 * named for the session's id. The folder name isn't documented, so when it
 * changes, no file is found and nothing is sent.
 *
 * @param $ - The engine
 * @returns The transcript's path
 */
async function transcriptPath($: Api): Promise<string> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
  const root = await $.session.root()
  const id = await $.session.id()
  return `${config}/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
}

/**
 * The session's transcript and its subagents' transcripts that `$.fs.read`
 * can read. Subagents' transcripts sit in a folder named after the session's.
 *
 * @param $ - The engine
 * @param transcript - The session's transcript path
 * @returns The path and text of each file that could be read; one that can't
 *   is left out, so it doesn't hold back the others' requests
 */
async function readTranscripts($: Api, transcript: string): Promise<TranscriptFile[]> {
  const found: { path: string; size: number }[] = []
  try {
    const stat = await $.fs.stat(transcript)
    if (stat.kind === 'file') found.push({ path: transcript, size: stat.size })
  } catch {
    // No transcript yet: there's nothing of the session's to read.
  }
  const subagents = `${transcript.replace(/\.jsonl$/, '')}/subagents`
  try {
    const entries = await $.fs.list(subagents)
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) found.push({ path: `${subagents}/${entry.name}`, size: entry.size })
    }
  } catch {
    // No subagents ran.
  }
  const readable = found.filter(file => file.size <= MAX_READ_BYTES)
  const read = await Promise.allSettled(readable.map(async ({ path }) => ({ path, text: await $.fs.read(path) })))
  return read.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
}

/**
 * The plugin's version from its manifest.
 *
 * @param $ - The engine
 * @returns The version, or null when it can't be read
 */
async function readPluginVersion($: Api): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    const version = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>).version : undefined
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * Whether `record_usage` stored a batch: its reply carries both counts.
 *
 * @param result - The tool's reply
 * @returns Whether the batch was stored
 */
function isStored(result: McpToolResult): boolean {
  const text = result.content.find(block => block.type === 'text')
  if (result.isError || text?.type !== 'text' || typeof text.text !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(text.text)
    if (typeof parsed !== 'object' || parsed === null) return false
    const { storedCount, duplicateCount } = parsed as Record<string, unknown>
    return typeof storedCount === 'number' && typeof duplicateCount === 'number'
  } catch {
    return false
  }
}

/**
 * Sends the requests in the transcripts not sent before, in batches, stopping
 * at the first that fails; the next send tries those again. Does nothing
 * while an earlier send is still running.
 *
 * @param $ - The engine
 * @param state - The requests already sent, and whether a send is running
 */
async function send($: Api, state: SendState): Promise<void> {
  if (state.isSending) return
  state.isSending = true
  try {
    if ((await $.env.get('QUOTIENT_USAGE')) === 'off') return
    const files = await readTranscripts($, await transcriptPath($))
    // Every request usageRows keeps names a `quotient:` skill, so a session
    // that never used one is left before any line is parsed.
    if (!files.some(file => file.text.includes('quotient:'))) return
    const rows = usageRows(files, Date.now()).filter(row => !state.sent.has(row.requestId))
    if (rows.length === 0) return
    const server = serverFor(await $.mcp.connect(SERVER_KEY))
    if (server === null) return
    const origin = (await $.env.get('QUOTIENT_DAILY_RUN')) === '1' ? 'background' : 'interactive'
    const pluginVersion = await readPluginVersion($)
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const result = await Promise.race([
        $.mcp.call(server, 'record_usage', { requests: batch.map(row => ({ ...row, origin, pluginVersion })) }),
        $.clock.sleep(CALL_TIMEOUT_MS).then(() => null),
      ])
      if (result === null || !isStored(result)) {
        $.ui.log('quotient usage: record_usage gave no usable reply', { to: 'debug' })
        return
      }
      for (const row of batch) state.sent.add(row.requestId)
    }
  } catch (error) {
    // Dropped: the next send tries again.
    $.ui.log(`quotient usage: record_usage ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
  } finally {
    state.isSending = false
  }
}

/**
 * Adds the hook that sends the session's quotient usage after each answered
 * turn of the main loop. Sending is best effort: a turn that ends otherwise,
 * or a send that fails, leaves its requests to the next answered turn, and
 * the session's last ones may never go. An interactive turn doesn't wait for
 * it. A `claude -p` run, which draws on no surface, does, since its process
 * exits as its turn ends and would cut the send off. Requests sent are
 * remembered for the life of the process; the server ignores a request it
 * already has, so forgetting one costs a resend and nothing else.
 *
 * @param on - Adds the module's hooks
 */
export function registerUsage(on: On): void {
  const state: SendState = { sent: new Set(), isSending: false }

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const sending = send($, state)
    if ((await $.session.surfaces()).length === 0) await sending
    return next(e)
  }).catch(($, e, next) => next(e))
}
