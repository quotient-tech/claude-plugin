/**
 * Turns Claude Code transcripts into the requests quotient's skills made, in
 * the shape the usage API takes. Only these fields are kept: no prompt or
 * response text, tool input, file path or working directory.
 */

/** One transcript file: its path, used only to order copies of a request, and its text. */
export type TranscriptFile = { path: string; text: string }

/** One request a quotient skill made, as the usage API takes it, less `origin` and `pluginVersion`. */
export type UsageRow = {
  requestId: string
  sessionId: string
  invocationId: string | null
  occurredAt: string
  skill: string
  model: string
  isSubagent: boolean
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputTokens: number
}

type Json = Record<string, unknown>

type Request = {
  path: string
  requestId: string
  sessionId: string
  at: string
  skill: string
  model: string
  isSubagent: boolean
  usage: unknown
}

type Marker = { sessionId: string; at: string; skill: string; id: string }

const SKILL = /^quotient:[a-z0-9-]{1,64}$/
const COMMAND = /<command-message>(quotient:[a-z0-9-]+)<\/command-message>/g
const WINDOW_MS = 7 * 86_400_000

/**
 * Whether a value is a JSON object, not an array or null.
 *
 * @param value - Any value
 * @returns Whether it is an object
 */
function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A value when it is a non-empty string.
 *
 * @param value - Any value
 * @returns The string, or undefined
 */
function known(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A value when it names a quotient skill.
 *
 * @param value - Any value
 * @returns The skill name, or undefined
 */
function skillName(value: unknown): string | undefined {
  return typeof value === 'string' && SKILL.test(value) ? value : undefined
}

/**
 * A message's text: a string as is, or an array's text parts joined by newlines.
 *
 * @param content - A message's `content`
 * @returns Its text, or '' for anything else
 */
function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as Json).text)
    .join('\n')
}

/**
 * One token count from a request's usage: a number of 0 or more, rounded down.
 *
 * @param usage - The request's `message.usage`
 * @param name - The count's key
 * @returns The count, or 0 when missing or invalid
 */
function tokens(usage: unknown, name: string): number {
  const value = isObject(usage) ? usage[name] : undefined
  return typeof value === 'number' && value >= 0 ? Math.floor(value) : 0
}

/**
 * Compares two strings by code unit, as jq orders them.
 *
 * @param a - One string
 * @param b - The other
 * @returns A negative number, 0 or a positive number
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The cutoff 7 days before `now`, written as jq's `todate` writes it, so
 * timestamps compare with it the way they did in jq.
 *
 * @param now - The current time, in milliseconds
 * @returns The cutoff, as an ISO 8601 string without fractional seconds
 */
function since(now: number): string {
  return new Date(Math.floor((now - WINDOW_MS) / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * Reads each JSON object line of the files, skipping any line that isn't one,
 * such as the half-written last line of a running session.
 *
 * @param files - The transcripts
 * @returns Each line's object, with the path of the file it came from
 */
function lines(files: readonly TranscriptFile[]): { path: string; line: Json }[] {
  const out: { path: string; line: Json }[] = []
  for (const { path, text: body } of files) {
    for (const raw of body.split('\n')) {
      let line: unknown
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      if (isObject(line)) out.push({ path, line })
    }
  }
  return out
}

/**
 * The request a line records, when a quotient skill made it.
 *
 * @param path - The line's file
 * @param line - The line
 * @returns The request, or undefined
 */
function request(path: string, line: Json): Request | undefined {
  if (line.type !== 'assistant' || line.attributionPlugin !== 'quotient') return undefined
  const skill = skillName(line.attributionSkill)
  const requestId = known(line.requestId)
  const sessionId = known(line.sessionId)
  const at = known(line.timestamp)
  const message = isObject(line.message) ? line.message : {}
  const model = known(message.model)
  if (!skill || !requestId || !sessionId || !at || !model) return undefined
  return { path, requestId, sessionId, at, skill, model, isSubagent: line.isSidechain === true, usage: message.usage }
}

/**
 * Where a line invoked a quotient skill: by a slash command in a user line, or
 * through the Skill tool in an assistant line. A marker's id is the line's uuid.
 *
 * @param line - The line
 * @returns The line's markers, possibly none
 */
function markers(line: Json): Marker[] {
  const sessionId = known(line.sessionId)
  const at = known(line.timestamp)
  const id = known(line.uuid)
  if (!sessionId || !at || !id) return []
  const content = isObject(line.message) ? line.message.content : undefined
  let skills: (string | undefined)[] = []
  if (line.type === 'user') {
    skills = [...text(content).matchAll(COMMAND)].map((match) => skillName(match[1]))
  } else if (line.type === 'assistant' && Array.isArray(content)) {
    skills = content
      .filter((part) => isObject(part) && part.type === 'tool_use' && part.name === 'Skill')
      .map((part) => {
        const input = (part as Json).input
        return skillName(isObject(input) ? input.skill : undefined)
      })
  }
  return skills.filter((skill) => skill !== undefined).map((skill) => ({ sessionId, at, skill, id }))
}

/**
 * The requests quotient's skills made in the last 7 days, one row each.
 *
 * A response written over several lines, or copied into a resumed or forked
 * session, keeps its earliest copy, ordered by time and then by file path. A
 * request belongs to the latest invocation of its skill in its session at or
 * before it, or to none.
 *
 * @param files - The transcripts, in a fixed order
 * @param now - The current time, in milliseconds
 * @returns The rows, ordered by time and then by request id
 */
export function usageRows(files: readonly TranscriptFile[], now: number): UsageRow[] {
  const requests: Request[] = []
  const invocations = new Map<string, Marker[]>()
  for (const { path, line } of lines(files)) {
    const found = request(path, line)
    if (found) requests.push(found)
    for (const marker of markers(line)) {
      const key = `${marker.sessionId} ${marker.skill}`
      invocations.set(key, [...(invocations.get(key) ?? []), marker])
    }
  }

  const earliest = new Map<string, Request>()
  for (const r of requests) {
    const seen = earliest.get(r.requestId)
    if (!seen || compare(r.at, seen.at) < 0 || (r.at === seen.at && compare(r.path, seen.path) < 0)) {
      earliest.set(r.requestId, r)
    }
  }

  const cutoff = since(now)
  return [...earliest.values()]
    .filter((r) => r.at >= cutoff)
    .map((r) => {
      let invocation: Marker | undefined
      for (const m of invocations.get(`${r.sessionId} ${r.skill}`) ?? []) {
        if (m.at <= r.at && (!invocation || m.at >= invocation.at)) invocation = m
      }
      return {
        requestId: r.requestId,
        sessionId: r.sessionId,
        invocationId: invocation?.id ?? null,
        occurredAt: r.at,
        skill: r.skill,
        model: r.model,
        isSubagent: r.isSubagent,
        inputTokens: tokens(r.usage, 'input_tokens'),
        cacheCreationTokens: tokens(r.usage, 'cache_creation_input_tokens'),
        cacheReadTokens: tokens(r.usage, 'cache_read_input_tokens'),
        outputTokens: tokens(r.usage, 'output_tokens'),
      }
    })
    .sort((a, b) => compare(a.occurredAt, b.occurredAt) || compare(a.requestId, b.requestId))
}
