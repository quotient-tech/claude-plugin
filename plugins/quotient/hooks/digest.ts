// Turns a Claude Code transcript into a short digest a reviewer can read in
// place of the raw lines, which run to tens of thousands of tokens each. It
// keeps what shows friction (prompts, errors, refusals, interrupts, repeated
// calls, large results) and drops what doesn't (thinking, file contents,
// hook context, duplicated results). Pure: the caller reads the lines.

/** One transcript line: its number from 1, and its text, or null when it was too large to read. */
export type TranscriptLine = { n: number; text: string | null; bytes: number }

// How a digest entry is kept when the digest runs over its budget: `keep`
// entries stay, `call` (a plain successful tool call) goes first, then
// `text` (the agent's own words), then `repeat` (a call that repeats an
// earlier one, which a run log can hold by the hundred).
type Tier = 'keep' | 'repeat' | 'text' | 'call'
type Entry = { n: number; tier: Tier; text: string }
type Call = { n: number; name: string; input: string }
// How a digest marks and names what its entries are numbered by.
type Unit = { mark: string; name: string }
const LINE: Unit = { mark: 'L', name: 'line' }
const EVENT: Unit = { mark: 'E', name: 'event' }

/** The most characters a digest holds: about 4K tokens, so a reviewer can hold ten. */
export const DIGEST_BUDGET = 16_000
// A result at least this long is shown as large: reading it whole is itself a sign.
const LARGE_RESULT = 20_000
const PROMPT_CHARS = 600
const TEXT_CHARS = 300
const INPUT_CHARS = 200
const ERROR_CHARS = 400
const HEAD_CHARS = 100
const CUT_CHARS = 200

/**
 * Shortens text to one line of at most `max` characters.
 *
 * @param text - The text
 * @param max - The most characters to keep
 * @returns The text on one line, ending in `…` when cut
 */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * Reads a tool result's or message's text, whether a string or a list of blocks.
 *
 * @param content - The content
 * @returns Its text blocks joined
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block !== null && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * Builds a transcript's digest.
 *
 * @param source - The transcript's name without `.jsonl`
 * @param lines - Its lines, in order
 * @param budget - The most characters the digest may hold
 * @returns The digest
 */
export function digest(source: string, lines: readonly TranscriptLine[], budget = DIGEST_BUDGET): string {
  const entries: Entry[] = []
  const pending = new Map<string, Call>()
  const seen = new Map<string, number>()
  let cwd = ''
  let first = ''
  let last = ''
  for (const line of lines) {
    if (line.text === null) {
      entries.push({ n: line.n, tier: 'keep', text: `(line of ${line.bytes.toLocaleString('en-US')} bytes, too large to read)` })
      continue
    }
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line.text) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof row.timestamp === 'string') {
      first ||= row.timestamp
      last = row.timestamp
    }
    if (typeof row.cwd === 'string') cwd ||= row.cwd
    const message = (row.message ?? {}) as { content?: unknown }
    if (row.type === 'system' && (row.level === 'error' || row.level === 'warning')) {
      entries.push({ n: line.n, tier: 'keep', text: `system ${String(row.subtype ?? '')}: ${clip(textOf(row.content), ERROR_CHARS)}` })
    }
    if (row.type === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          entries.push({ n: line.n, tier: 'text', text: `agent: ${clip(block.text, TEXT_CHARS)}` })
        }
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          pending.set(block.id, { n: line.n, name: String(block.name), input: clip(JSON.stringify(block.input ?? {}), INPUT_CHARS) })
        }
      }
    }
    if (row.type !== 'user' || row.isMeta === true) continue
    if (typeof message.content === 'string') {
      entries.push(prompt(line.n, message.content))
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string') entries.push(prompt(line.n, block.text))
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const call = pending.get(block.tool_use_id)
      if (call === undefined) continue
      pending.delete(block.tool_use_id)
      entries.push(called(call, textOf(block.content), block.is_error === true, seen))
    }
  }
  for (const call of pending.values()) entries.push({ n: call.n, tier: 'keep', text: `${call.name} ${call.input} → no result` })
  entries.sort((a, b) => a.n - b.n)
  const header = `Session ${source}: ${lines.length} lines, ${cwd || 'unknown folder'}, ${first.slice(0, 16) || '?'} to ${last.slice(0, 16) || '?'}`
  return fit(header, entries, budget, lines.length)
}

/**
 * Makes an entry for something the operator typed.
 *
 * @param n - Its line number
 * @param text - What they typed
 * @returns The entry
 */
function prompt(n: number, text: string): Entry {
  return { n, tier: 'keep', text: `${/\[Request interrupted by user/.test(text) ? 'interrupted' : 'operator'}: ${clip(text, PROMPT_CHARS)}` }
}

/**
 * Makes an entry for a tool call and its result. A failed call, a large
 * result and a call that repeats an earlier one are kept over budget.
 *
 * @param call - The call
 * @param result - Its result's text
 * @param isError - Whether it failed or was refused
 * @param seen - Each earlier call's name and input, with its line number
 * @returns The entry
 */
function called(call: Call, result: string, isError: boolean, seen: Map<string, number>): Entry {
  const key = `${call.name} ${call.input}`
  const earlier = seen.get(key)
  if (earlier === undefined) seen.set(key, call.n)
  const size = `${result.length.toLocaleString('en-US')} chars`
  const outcome = isError ? `ERROR: ${clip(result, ERROR_CHARS)}` : `ok, ${size}${result.trim() === '' ? '' : `: ${clip(result, HEAD_CHARS)}`}`
  const isLarge = result.length >= LARGE_RESULT
  const notes = [earlier === undefined ? '' : ` (repeats L${earlier})`, isLarge && !isError ? ' (large result)' : ''].join('')
  const tier: Tier = isError || isLarge || earlier !== undefined ? 'keep' : 'call'
  return { n: call.n, tier, text: `${key} → ${outcome}${notes}` }
}

/**
 * Fits the entries in the budget: it drops plain tool calls first, then the
 * agent's text, then shortens what's left, and says what it cut.
 *
 * @param header - The digest's first line
 * @param entries - The entries, in line order
 * @param budget - The most characters
 * @param total - How many lines the transcript has
 * @param unit - How an entry's number is marked and named, a transcript line by default
 * @returns The digest
 */
function fit(header: string, entries: readonly Entry[], budget: number, total: number, unit: Unit = LINE): string {
  const render = (kept: readonly Entry[], note: string) =>
    [header, ...kept.map(entry => `${unit.mark}${entry.n} ${entry.text}`), note].filter(Boolean).join('\n')
  let kept = [...entries]
  const cut = { call: 0, text: 0, repeat: 0 }
  const note = () => {
    const parts = [
      cut.call > 0 ? `${cut.call} plain tool calls` : '',
      cut.text > 0 ? `${cut.text} agent messages` : '',
      cut.repeat > 0 ? `${cut.repeat} repeated calls` : '',
    ].filter(Boolean)
    return parts.length === 0 ? '' : `(cut to fit: ${parts.join(' and ')})`
  }
  for (const tier of ['call', 'text', 'repeat'] as const) {
    if (render(kept, note()).length <= budget) return render(kept, note())
    cut[tier] = kept.filter(entry => entry.tier === tier).length
    kept = kept.filter(entry => entry.tier !== tier)
  }
  kept = kept.map(entry => ({ ...entry, text: clip(entry.text, CUT_CHARS) }))
  if (render(kept, note()).length <= budget) return render(kept, note())
  // Room for the closing note, which names at most two line numbers.
  let size = header.length + note().length + 60
  let end = 0
  for (const entry of kept) {
    size += `${unit.mark}${entry.n} ${entry.text}`.length + 1
    if (size > budget) break
    end += 1
  }
  const stop = kept[end - 1]?.n ?? 0
  return render(kept.slice(0, end), `${note()} (digest stops at ${unit.name} ${stop} of ${total})`.trim())
}

// Shortens what RemoteTrigger returns while /quotient:setup reads cloud
// routines. A routine list carries each routine's whole job config and
// session request, and a run log each tool's whole output, so a reply runs to
// tens of thousands of characters. Claude Code then saves it to a file the
// model can't read in pieces, since quotient refuses shell reads of the
// projects folder. Pure: setup.tsx decides when to use these.

// How much of a routine's saved prompt a list keeps; `get` keeps far more.
const LIST_PROMPT = 600
const GET_PROMPT = 20_000
// How long each run-log event's text may be, by its kind.
const EVENT_CHARS = { error: 400, user: 600, result: 400, assistant: 200, toolUse: 160, toolResult: 100, other: 200 }
// How many lines above a log's first event it keeps, such as the line that says how many events it shows.
const MAX_PREAMBLE = 2
const LIST_NOTE = 'quotient shortened this reply for setup: each routine keeps the fields setup reads'
const LOG_NOTE =
  "(quotient digested this log for setup: errors, the operator's prompts and the result stay; when it runs long, plain tool events go first, then the agent's text, then repeated calls)"

type Routine = Record<string, unknown>

/**
 * Keeps a routine's fields setup reads: its schedule, last run, connectors and saved prompt.
 *
 * @param routine - The routine as RemoteTrigger returns it
 * @param promptChars - The most characters of its prompt to keep
 * @returns The shorter routine
 */
function compactRoutine(routine: Routine, promptChars: number): Routine {
  const state = (routine.derived_state ?? {}) as Record<string, unknown>
  const prompt = typeof state.prompt === 'string' ? state.prompt : ''
  const connections = Array.isArray(routine.mcp_connections) ? routine.mcp_connections : []
  return {
    id: routine.id,
    name: routine.name,
    cron_expression: routine.cron_expression,
    enabled: routine.enabled,
    created_at: routine.created_at,
    updated_at: routine.updated_at,
    last_run: routine.last_run,
    mcp_connections: connections.map(connection => (connection as Record<string, unknown>)?.name),
    prompt:
      prompt.length <= promptChars
        ? prompt
        : `${prompt.slice(0, promptChars)}… (prompt cut at ${promptChars} of ${prompt.length.toLocaleString('en-US')} characters; RemoteTrigger get has it whole)`,
  }
}

/**
 * Tells whether a value is a routine as RemoteTrigger returns one.
 *
 * @param value - The value
 * @returns Whether it has a routine's id and saved state
 */
function isRoutine(value: unknown): value is Routine {
  return value !== null && typeof value === 'object' && typeof (value as Routine).id === 'string' && 'derived_state' in value
}

/**
 * Shortens a `list` or `get` reply's JSON.
 *
 * @param json - The reply's `json` string
 * @returns The shorter JSON, or null when it isn't a routine or a list of them
 */
export function compactRoutines(json: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (isRoutine(parsed)) return JSON.stringify({ note: LIST_NOTE, ...compactRoutine(parsed, GET_PROMPT) })
  const { data, ...rest } = (parsed ?? {}) as Record<string, unknown>
  if (!Array.isArray(data) || data.length === 0 || !data.every(isRoutine)) return null
  return JSON.stringify({ note: LIST_NOTE, ...rest, data: data.map(routine => compactRoutine(routine, LIST_PROMPT)) })
}

/**
 * Says how long one run-log event's text may be.
 *
 * @param kind - The event's kind, such as `tool_result ERROR` or `tool_use Bash`
 * @returns The most characters
 */
function eventChars(kind: string): number {
  if (/ERROR/.test(kind)) return EVENT_CHARS.error
  if (kind === 'user') return EVENT_CHARS.user
  if (kind === 'result') return EVENT_CHARS.result
  if (kind === 'assistant') return EVENT_CHARS.assistant
  if (kind.startsWith('tool_use')) return EVENT_CHARS.toolUse
  if (kind.startsWith('tool_result')) return EVENT_CHARS.toolResult
  return EVENT_CHARS.other
}

/**
 * Tells how a run-log event is kept when its digest runs over budget:
 * errors, the operator's prompts and the run's result always stay.
 *
 * @param kind - The event's kind, such as `tool_result ERROR` or `tool_use Bash`
 * @returns Its tier
 */
function eventTier(kind: string): Tier {
  if (/ERROR/.test(kind) || kind === 'user' || kind === 'result') return 'keep'
  return kind === 'assistant' ? 'text' : 'call'
}

/**
 * Builds a digest of a `get_run_log` reply's event lines, `[time] kind: text`,
 * numbering each event from 1, as a session's digest numbers its lines. Lines
 * before the first event stay as they are; a line that isn't an event joins
 * the event above it.
 *
 * @param summary - The reply's `summary`
 * @param budget - The most characters the digest may hold
 * @returns The digest, with a first line saying it was digested
 */
export function runLogDigest(summary: string, budget = DIGEST_BUDGET): string {
  const preamble: string[] = []
  const events: { time: string; kind: string; text: string }[] = []
  for (const line of summary.split('\n')) {
    const event = /^\[\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)[^\]]*\] ([^:]{1,60}): ?(.*)$/.exec(line)
    const last = events.at(-1)
    if (event !== null) events.push({ time: event[1] as string, kind: event[2] as string, text: event[3] as string })
    else if (last !== undefined) last.text += `\n${line}`
    else if (line.trim() !== '' && preamble.length < MAX_PREAMBLE) preamble.push(clip(line, EVENT_CHARS.other))
  }
  const seen = new Map<string, number>()
  const entries: Entry[] = events.map(({ time, kind, text }, i) => {
    const n = i + 1
    // A repeat is the same call in full; only what's shown is clipped.
    const key = `${kind}: ${text}`
    const earlier = kind.startsWith('tool_use') ? seen.get(key) : undefined
    if (kind.startsWith('tool_use') && earlier === undefined) seen.set(key, n)
    const tier: Tier = earlier === undefined ? eventTier(kind) : 'repeat'
    const shown = `${kind}: ${clip(text, eventChars(kind))}`
    return { n, tier, text: `[${time}] ${shown}${earlier === undefined ? '' : ` (repeats E${earlier})`}` }
  })
  return fit([LOG_NOTE, ...preamble].join('\n'), entries, budget, events.length, EVENT)
}
