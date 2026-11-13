// /quotient:setup's start message, quiet run and summary, drawn by the mod.
// The skill needs setup_start and setup_summary, and stops without them.
import { atom, read, update } from 'claude-code'
import type { Elements, Hook, Register } from 'claude-code'

import type {
  SetupAnswer,
  SetupDrawn,
  SetupInvite,
  SetupRun,
  SetupSolved,
  SetupStart,
  SetupSummary,
  SetupTeammateCheck,
  FrictionImpact,
  SetupTopFriction,
  StatusParts,
} from '../types'
import { fullPath, globRoot, isConfigPath, isQuotientSkill, isSkippedProject, QUOTIENT_PREFIXES, TEAMMATE_TOOL_USE } from './sandbox'
import { callFailure, errorText, SERVER_KEY, serverFor, statusLine } from './state'
import { cleanText, MAX_TEXT, plural, textError } from './text'
import { IMPACTS, impactLabel } from './impact'
import { compactRoutines, digest, runLogDigest } from './digest'
import type { TranscriptLine } from './digest'
import { heldVerdict, holdsTeammateText, LINES_PER_READ, projectFolders, QUOTIENT_STARTED, transcriptFindArgs } from './sessions'

type Api = Parameters<Hook<'tool.call'>>[0]
// The elements the drawings use, which the terminal and the desktop app share.
type Els = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text'>

const SETUP_COMMAND = 'quotient:setup'
const SUMMARY_TOOL = 'mcp__quotient__setup_summary'
const START_TOOL = 'mcp__quotient__setup_start'
const DIGEST_TOOL = 'mcp__quotient__setup_digest'
// The subagent setup reviews each batch with.
const REVIEWER_AGENT = 'quotient:setup-reviewer'
const TEAMMATE_CHECK_AGENT = 'quotient:teammate-check'
const RECENT_FOLDERS = 'The project folders with a session from the last two weeks, under `~/.claude/projects/`:'
// A subagent that hasn't reported back yet.
const ACTIVE: readonly string[] = ['pending', 'running', 'waiting']
const GO_ON = 'The start message is shown to the operator. Go on with the review, and write no text until the summary.'
const DAY = /^[A-Z][a-z]{2} [1-9]\d?$/
const TEAMMATES_CLAUSE = ", and checking your setup for fixes to your teammates' frictions"
const SETUP_RUN_TOOLS = ['start_setup_run', 'record_setup_progress', 'submit_frictions', 'finish_setup_run']
const TEAMMATE_CHECK_TOOLS = ['list_teammate_frictions', 'submit_solutions', 'submit_solution']
const FIND_SOLUTIONS_SKILL = 'quotient:find-solutions'
// Tools setup uses whose rows say nothing the operator needs to check: its
// own, and Quotient's setup and teammate-check tools by their exact names.
const QUIET_TOOLS = [
  'Agent',
  'RemoteTrigger',
  'ToolSearch',
  START_TOOL,
  SUMMARY_TOOL,
  DIGEST_TOOL,
  ...QUOTIENT_PREFIXES.flatMap(prefix => [...SETUP_RUN_TOOLS, ...TEAMMATE_CHECK_TOOLS].map(tool => `${prefix}${tool}`)),
]
// The type the Agent tool starts when the model names none.
const DEFAULT_AGENT = 'general-purpose'
const END_TURN = 'The summary is shown to the operator. End your turn now without writing anything else.'
const INVITE_TOOL = 'get_invite_link'
const SIGNUP_LINE = 'signup + install here:'
const INVITE_QUESTION = 'Copy to share'
const COPY_MESSAGE = 'Copy message'
const COPY_LINK = 'Copy link'
// The message to paste, in the operator's own voice; a team with members
// already asks rather than announces.
const FIRST_MESSAGE = 'hey this plugin lets our agents talk to each other / suggest fixes for problems.'
const MORE_MESSAGE = "hey are you using this yet? it's a plugin that lets our agents talk to each other and suggest fixes."
const LIST_FIXES_HINT = "When your teammates' agents find fixes, run /list-fixes to see them."
// The model never sees the drawn summary, so the result repeats its last line:
// the conversation is what Claude Code suggests the operator's next prompt from.
const END_TURN_WITH_HINT = `The summary is shown to the operator. Its last line reads: "${LIST_FIXES_HINT}" End your turn now without writing anything else.`
const MAX_ITEMS = 3
// textError counts JavaScript string length, where an emoji takes 2 or more.
const TEXT_LIMIT = `At most ${MAX_TEXT} characters, counting an emoji as 2 or more`
const SEVERITY_WIDTH = 10
// The card's inner width: the skill's text sample is 72 columns inside its box.
const CARD_WIDTH = 72
const SEVERITIES = ['high', 'medium', 'low'] as const
const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string', description: "The source's name, as setup_start's batches give it, without its folder or `.jsonl`" },
  },
  required: ['source'],
} as const

const START_SCHEMA = {
  type: 'object',
  properties: {
    sessions: { type: 'integer', minimum: 0, description: "Only when quotient couldn't count them: its reply says" },
    automatedRuns: { type: 'integer', minimum: 0, description: "Only when quotient couldn't count them: its reply says" },
    cloudRuns: { type: 'integer', minimum: 0, description: 'The routine runs this setup will review' },
    firstDay: { type: 'string', description: 'Like Oct 15' },
    lastDay: { type: 'string', description: 'Like Oct 29' },
    checksTeammates: { type: 'boolean', description: "Whether setup also checks the operator's setup for teammates' fixes" },
  },
  required: ['cloudRuns', 'firstDay', 'lastDay'],
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    frictions: { type: 'integer', minimum: 0, description: 'The new frictions the run stored' },
    working: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string', maxLength: MAX_TEXT, description: TEXT_LIMIT } },
    top: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        properties: {
          severity: { enum: SEVERITIES },
          description: { type: 'string', maxLength: MAX_TEXT, description: TEXT_LIMIT },
          impact: { enum: IMPACTS },
          sessions: { type: 'integer', minimum: 1 },
        },
        required: ['severity', 'description', 'impact', 'sessions'],
      },
    },
    remainingHigh: { type: 'integer', minimum: 0 },
    inCommon: {
      type: 'string',
      maxLength: MAX_TEXT,
      description: `What the top frictions have in common, when frictions were found and setup didn't check for teammates' fixes. ${TEXT_LIMIT}`,
    },
  },
  required: ['frictions', 'working', 'top', 'remainingHigh'],
}

const SEVERITY_LABELS = {
  high: { label: '▲ high', color: 'error' },
  medium: { label: '◆ medium', color: 'warning' },
  low: { label: '▼ low', color: undefined },
} as const

// The sample fix card. It's fixed text, and its teammate is made up: no tool
// field ever reaches it.
const CARD = {
  sample: 'SAMPLE',
  notReal: '· not a real fix',
  frictionTitle: 'YOUR FRICTION',
  friction: 'Lint passes on commit but fails in CI',
  frictionImpact: 'Blocked',
  frictionSeen: ' · in 14% of your sessions',
  solutionTitle: 'SOLUTION FROM A TEAMMATE',
  teammate: '· Ron Burgundy',
  solution: 'Run ESLint from the repo root in the pre-commit hook, so commits use the same rules as CI.',
  change: '+ cd "$(git rev-parse --show-toplevel)" && npx eslint --cache $FILES',
  changeFile: '  .husky/pre-commit · 1 line',
  worked: "Worked in 14 of Ron's sessions",
  actions: 'Apply it · Ask Ron · Not now',
} as const

// The solved block's fixed text. The teammate stays unnamed: Quotient never
// says who raised a friction.
const SOLVED_CARD = {
  frictionTitle: "A TEAMMATE'S FRICTION",
  fixTitle: 'YOUR FIX',
  anonymous: '(you both stay anonymous)',
} as const

// The summary row whose invite is asked about once the turn ends, and
// whether that question was answered for the operator while they were away.
let inviteRowId: string | null = null
let answeredWhileAway = false

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const drawn = atom({ plugin: 'quotient', key: 'setupDrawn' } as const, {} as SetupDrawn, { shape: 'drawn-4' })
const NO_RUN: SetupRun = {
  isRunning: false,
  toolUseIds: [],
  agentIds: [],
  agentNames: [],
  start: null,
  dirs: null,
  reviewedIds: [],
  listed: {},
  teammateTitles: {},
  teammateAnswers: [],
  joinedCompany: null,
}
// The guard reads the run's state by its key, so it checks this tag itself.
export const RUN_SHAPE = 'run-9'
const run = atom({ plugin: 'quotient', key: 'setupRun' } as const, NO_RUN, { shape: RUN_SHAPE })
// Shared with fix.tsx, which declares it with the same key.
const statusParts = atom(
  { plugin: 'quotient', key: 'statusParts' } as const,
  { setup: null, fixes: null } as StatusParts,
)

type SourceCounts = { sessions: number; automatedRuns: number }

/** A review window pinned to fixed days, for measuring setup the same way twice. */
type PinnedWindow = { start: string; end: string; firstDay: string; lastDay: string }

const WINDOW_DAYS = 14
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Reads a pinned review window from its end date: the 14 days before it,
 * leaving the end date out.
 *
 * @param end - The window's end as `YYYY-MM-DD`, or undefined when none is pinned
 * @returns The window, or undefined when none is pinned or the end isn't a date
 */
export function pinnedWindow(end: string | undefined): PinnedWindow | undefined {
  if (end === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return undefined
  const endMs = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(endMs) || new Date(endMs).toISOString().slice(0, 10) !== end) return undefined
  const day = (offset: number) => new Date(endMs + offset * 86_400_000)
  const shown = (date: Date) => `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
  return {
    start: day(-WINDOW_DAYS).toISOString().slice(0, 10),
    end,
    firstDay: shown(day(-WINDOW_DAYS)),
    lastDay: shown(day(-1)),
  }
}

type Checked<T> = { value: T; error?: undefined } | { error: string; value?: undefined }

/**
 * Tells whether a value is a whole number at least as large as a minimum.
 *
 * @param value - The value
 * @param min - The smallest allowed
 * @returns Whether it qualifies
 */
function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
}

/**
 * Checks a `setup_start` call.
 *
 * @param input - The call's input
 * @param counted - The local sessions and automated runs quotient counted, in
 *   place of the call's own, or undefined when it couldn't count them
 * @returns The start values, or the first refusal as one line naming the field
 */
export function checkStart(input: Record<string, unknown>, counted?: SourceCounts): Checked<SetupStart> {
  const { cloudRuns, firstDay, lastDay, checksTeammates } = input
  const { sessions, automatedRuns } = counted ?? input
  for (const [field, value] of Object.entries({ sessions, automatedRuns, cloudRuns })) {
    if (!isCount(value, 0)) return { error: `${field}: must be a whole number of at least 0` }
  }
  for (const [field, value] of Object.entries({ firstDay, lastDay })) {
    if (typeof value !== 'string' || !DAY.test(value)) return { error: `${field}: must be a day like Oct 15` }
  }
  if (checksTeammates !== undefined && typeof checksTeammates !== 'boolean') {
    return { error: 'checksTeammates: must be true or false' }
  }
  return {
    value: {
      sessions: sessions as number,
      automatedRuns: automatedRuns as number,
      cloudRuns: cloudRuns as number,
      firstDay: firstDay as string,
      lastDay: lastDay as string,
      checksTeammates: checksTeammates === true,
    },
  }
}

/**
 * Cuts text a teammate's agent wrote to fit a card: clean of escapes and
 * control characters, within the text limit, and holding no id or email.
 *
 * @param value - The text
 * @param reviewedIds - The sources this run reviewed
 * @returns The text, or null when nothing fit to show is left
 */
function cardText(value: string | null, reviewedIds: readonly string[]): string | null {
  const clean = cleanText(value)
  if (clean === null) return null
  const text = clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1).trimEnd()}…` : clean
  return textError('card', text, reviewedIds) === undefined ? text : null
}

/**
 * Reads the teammate frictions' titles from a `list_teammate_frictions` reply.
 *
 * @param text - The reply as the model read it
 * @returns Each title, cleaned, by its friction's id, or null when the reply isn't a page of frictions
 */
export function teammateTitlesFrom(text: string | undefined): Record<string, string> | null {
  let page: unknown
  try {
    page = JSON.parse(text ?? '')
  } catch {
    return null
  }
  const frictions = typeof page === 'object' && page !== null ? (page as Record<string, unknown>).frictions : undefined
  if (!Array.isArray(frictions)) return null
  const titles: Record<string, string> = {}
  for (const friction of frictions) {
    const { id, title } = (typeof friction === 'object' && friction !== null ? friction : {}) as Record<string, unknown>
    const clean = cleanText(typeof title === 'string' ? title : null)
    if (typeof id === 'string' && clean !== null) titles[id] = clean
  }
  return titles
}

/**
 * Reads which answers a `submit_solutions` reply says Quotient refused.
 *
 * @param text - The reply as the model read it
 * @returns The refused answers' friction ids, none when the reply can't be read
 */
export function refusedAnswerIds(text: string | undefined): Set<string> {
  let reply: unknown
  try {
    reply = JSON.parse(text ?? '')
  } catch {
    return new Set()
  }
  const answers = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>).answers : undefined
  if (!Array.isArray(answers)) return new Set()
  return new Set(
    answers.flatMap(answer => {
      const { frictionId, status } = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>
      return status === 'refused' && typeof frictionId === 'string' ? [frictionId] : []
    }),
  )
}

/**
 * Lists the answers a teammate-check call sent: one for `submit_solution`,
 * each one Quotient didn't refuse for `submit_solutions`.
 *
 * @param name - The tool's name on the server
 * @param input - The call's input
 * @param replyText - The reply as the model read it
 * @returns Each answer's friction id and its description, if any
 */
function sentAnswers(name: string | undefined, input: Record<string, unknown>, replyText: string | undefined): { frictionId: string; description: unknown }[] {
  if (name === 'submit_solution') {
    return typeof input.frictionId === 'string' ? [{ frictionId: input.frictionId, description: input.description }] : []
  }
  if (name !== 'submit_solutions' || !Array.isArray(input.answers)) return []
  const refused = refusedAnswerIds(replyText)
  return input.answers.flatMap(answer => {
    const { frictionId, description } = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>
    return typeof frictionId === 'string' && !refused.has(frictionId) ? [{ frictionId, description }] : []
  })
}

/**
 * Names a Quotient tool a call went to, by the plugin's server or the connector.
 *
 * @param tool - The called tool's full name
 * @returns The tool's name on the server, or undefined for any other tool
 */
function quotientTool(tool: string): string | undefined {
  const prefix = QUOTIENT_PREFIXES.find(one => tool.startsWith(one))
  return prefix === undefined ? undefined : tool.slice(prefix.length)
}

/**
 * Builds what setup's check for teammates' fixes found from the calls the
 * check actually made, so no text the subagent wrote reaches setup's own
 * session: each card is a friction's title as Quotient listed it and the fix
 * as it was sent. An answer whose text isn't fit to show still counts.
 *
 * @param titles - Each teammate friction's title by its id
 * @param answers - The answers sent, in order
 * @param reviewedIds - The sources this run reviewed
 * @returns The count of answers with a fix, and up to three cards
 */
export function teammateCheckFrom(
  titles: Readonly<Record<string, string>>,
  answers: readonly SetupAnswer[],
  reviewedIds: readonly string[],
): SetupTeammateCheck {
  const withFix = answers.filter(answer => answer.fix !== null)
  const solved = withFix
    .flatMap((answer): SetupSolved[] => {
      const friction = cardText(titles[answer.frictionId] ?? null, reviewedIds)
      const fix = cardText(answer.fix, reviewedIds)
      return friction === null || fix === null ? [] : [{ friction, fix }]
    })
    .slice(0, MAX_ITEMS)
  return { solvedCount: withFix.length, solved }
}

/**
 * Checks a `setup_summary` call against the rules its drawing relies on.
 *
 * @param input - The call's input
 * @param reviewedIds - The sources this run reviewed
 * @param teammateCheck - What the run's check for teammates' fixes found, or
 *   undefined when it didn't check
 * @returns The summary, or the first refusal as one line naming the field
 */
export function checkSummary(
  input: Record<string, unknown>,
  reviewedIds: readonly string[],
  teammateCheck?: SetupTeammateCheck,
): Checked<SetupSummary> {
  const { frictions, working, top, remainingHigh, inCommon } = input
  if (input.teammateCheck !== undefined) return { error: 'teammateCheck: leave it out, quotient adds it' }
  if (!isCount(frictions, 0)) return { error: 'frictions: must be a whole number of at least 0' }

  if (!Array.isArray(working)) return { error: 'working: must be a list' }
  if (working.length > MAX_ITEMS) return { error: `working: must hold at most ${MAX_ITEMS} items` }
  for (const [i, item] of working.entries()) {
    const error = textError(`working[${i}]`, item, reviewedIds)
    if (error !== undefined) return { error }
  }

  const wanted = Math.min(frictions, MAX_ITEMS)
  if (!Array.isArray(top) || top.length !== wanted) {
    return { error: `top: must hold ${wanted} items when frictions is ${frictions}` }
  }
  for (const [i, item] of top.entries()) {
    const friction = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    if (!SEVERITIES.includes(friction.severity as SetupTopFriction['severity'])) {
      return { error: `top[${i}].severity: must be high, medium or low` }
    }
    const error = textError(`top[${i}].description`, friction.description, reviewedIds)
    if (error !== undefined) return { error }
    if (!IMPACTS.includes(friction.impact as FrictionImpact)) {
      return { error: `top[${i}].impact: must be one of ${IMPACTS.slice(0, -1).join(', ')} or ${IMPACTS.at(-1)}` }
    }
    if (!isCount(friction.sessions, 1)) return { error: `top[${i}].sessions: must be a whole number of at least 1` }
  }

  const remaining = frictions - wanted
  if (!isCount(remainingHigh, 0) || remainingHigh > remaining) {
    return { error: `remainingHigh: must be at most ${remaining}` }
  }

  if (teammateCheck !== undefined) {
    if (inCommon !== undefined) return { error: "inCommon: leave it out when setup checked for teammates' fixes" }
  } else if (frictions > 0) {
    if (inCommon === undefined) return { error: 'inCommon: required when frictions were found' }
    const error = textError('inCommon', inCommon, reviewedIds)
    if (error !== undefined) return { error }
  } else if (inCommon !== undefined) {
    return { error: 'inCommon: only when frictions were found' }
  }

  return {
    value: {
      frictions,
      working: working as string[],
      top: (top as SetupTopFriction[]).map(({ severity, description, impact, sessions }) => ({
        severity,
        description,
        impact,
        sessions,
      })),
      remainingHigh,
      ...(inCommon === undefined ? {} : { inCommon: inCommon as string }),
      ...(teammateCheck === undefined ? {} : { teammateCheck }),
    },
  }
}

/**
 * Joins items into an English list: "a", "a and b", "a, b and c".
 *
 * @param items - At least one item
 * @returns The list
 */
function listed(items: readonly string[]): string {
  const rest = items.slice(0, -1)
  const last = items.at(-1) ?? ''
  return rest.length === 0 ? last : `${rest.join(', ')} and ${last}`
}

/**
 * Draws setup's two start lines, under the company the operator joined when
 * this is their first setup since joining it.
 *
 * @param els - The surface's elements
 * @param start - The checked start values
 * @param joinedCompany - The company's name, or null
 * @returns The start message
 */
function startTree({ Box, Text }: Els, start: SetupStart, joinedCompany: string | null) {
  const { sessions, automatedRuns, cloudRuns, firstDay, lastDay, checksTeammates } = start
  const teammates = checksTeammates ? TEAMMATES_CLAUSE : ''
  const counts = [
    [sessions, 'session'],
    [automatedRuns, 'automated run'],
    [cloudRuns, 'cloud routine run'],
  ] as const
  const clauses = counts.filter(([count]) => count > 0).map(([count, noun]) => plural(count, noun))
  const reviewed = clauses.length === 0 ? 'no sessions' : listed(clauses)
  return (
    <Box flexDirection="column">
      {joinedCompany !== null && (
        <Text>
          <Text color="success">✓</Text> {`Joined ${joinedCompany}`}
        </Text>
      )}
      <Text>{`Reviewing ${reviewed} from ${firstDay} to ${lastDay}${teammates}`}</Text>
      <Text dimColor>This can take some time. You can keep working in another session while it runs.</Text>
    </Box>
  )
}

/**
 * Draws the sample fix card from its fixed text, bordered as the mockup is.
 *
 * @param els - The surface's elements
 * @returns The card
 */
function cardTree({ Box, Text }: Els) {
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={CARD_WIDTH + 4}>
      <Text>
        <Text color="warning">{CARD.sample}</Text> <Text dimColor>{CARD.notReal}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="error">
          {CARD.frictionTitle}
        </Text>
        <Text bold>{CARD.friction}</Text>
        <Text dimColor>
          <Text color="suggestion">{CARD.frictionImpact}</Text>
          {CARD.frictionSeen}
        </Text>
      </Box>
      <Text dimColor>{'╌'.repeat(CARD_WIDTH)}</Text>
      <Text>
        <Text bold color="success">
          {CARD.solutionTitle}
        </Text>{' '}
        <Text dimColor>{CARD.teammate}</Text>
      </Text>
      <Text>{CARD.solution}</Text>
      <Text color="success">{CARD.change}</Text>
      <Text dimColor>{CARD.changeFile}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{CARD.worked}</Text>
        <Text dimColor>{CARD.actions}</Text>
      </Box>
    </Box>
  )
}

/**
 * Draws one teammate's friction the operator's setup solves, bordered like
 * the sample card.
 *
 * @param els - The surface's elements
 * @param solved - The checked item
 * @returns The card
 */
function solvedCardTree({ Box, Text }: Els, solved: SetupSolved) {
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={CARD_WIDTH + 4}>
      <Text bold color="error">
        {SOLVED_CARD.frictionTitle}
      </Text>
      <Text bold>{solved.friction}</Text>
      <Text dimColor>{'╌'.repeat(CARD_WIDTH)}</Text>
      <Text bold color="success">
        {SOLVED_CARD.fixTitle}
      </Text>
      <Text>{solved.fix}</Text>
    </Box>
  )
}

/**
 * Draws the teammates' problems the operator's setup already solves, which
 * an invited operator sees after their own frictions.
 *
 * @param els - The surface's elements
 * @param check - The checked findings, with at least one fix
 * @returns The solved block
 */
function solvedTree(els: Els, check: SetupTeammateCheck) {
  const { Box, Text } = els
  const example = check.solved[0]
  const delivery =
    check.solvedCount === 1
      ? "They'll get it as an anonymous suggestion in their next session."
      : "They'll get these as anonymous suggestions in their next session."
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{`Your setup solves ${check.solvedCount} of your teammates' frictions.`}</Text>
      <Text>{delivery}</Text>
      {example !== undefined && solvedCardTree(els, example)}
    </Box>
  )
}

/**
 * Draws what happens after an invited operator's setup and what they can do
 * now. The suggestion item shows only when their setup solves a teammate's
 * friction, and the list is numbered from what's shown.
 *
 * @param els - The surface's elements
 * @param solvedCount - How many teammates' frictions the operator's setup solves
 * @returns The closing sections
 */
function nextTree({ Box, Text }: Els, solvedCount: number) {
  const suggestion = solvedCount === 1 ? 'it to your teammate' : `all ${solvedCount} to your teammates`
  const notifyNumber = solvedCount > 0 ? 2 : 1
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        <Text bold>What's next</Text>
        {solvedCount > 0 && (
          <Text>
            {`1. Quotient will suggest ${suggestion} in their next session`} <Text dimColor>{SOLVED_CARD.anonymous}</Text>
          </Text>
        )}
        <Text>{`${notifyNumber}. I'll notify you when I have some proven solutions for you to consider`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>What you can do now</Text>
        <Text>Invite more teammates. The more the merrier.</Text>
      </Box>
    </Box>
  )
}

/**
 * Checks a `get_invite_link` reply. Any missing or mistyped field makes the
 * whole reply unusable, and a trial with no seat left has no one to invite.
 *
 * @param text - The reply's text
 * @returns The invite, or null when it can't be used
 */
function inviteFrom(text: string | undefined): SetupInvite | null {
  let reply: unknown
  try {
    reply = JSON.parse(text ?? '')
  } catch {
    return null
  }
  if (typeof reply !== 'object' || reply === null) return null
  const { companyName, inviteUrl, emailDomain, memberCount, maxSeats } = reply as Record<string, unknown>
  const name = typeof companyName === 'string' ? cleanText(companyName) : null
  if (name === null || !isWebLink(inviteUrl) || typeof emailDomain !== 'string' || emailDomain === '') return null
  if (!isCount(memberCount, 1) || !(maxSeats === null || isCount(maxSeats, 0))) return null
  if (maxSeats !== null && memberCount >= maxSeats) return null
  return { companyName: name, inviteUrl, memberCount }
}

/**
 * Tells whether a value is a web address that can be drawn and pasted as it
 * is: http or https, with nothing a terminal would act on.
 *
 * @param value - The value
 * @returns Whether it's a safe web address
 */
function isWebLink(value: unknown): value is string {
  if (typeof value !== 'string' || cleanText(value) !== value) return false
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * Asks Quotient for the company's invite link. Any failure shows no invite,
 * with a debug line saying why.
 *
 * @param $ - The engine
 * @returns The invite, or null
 */
async function fetchInvite($: Api): Promise<SetupInvite | null> {
  try {
    const server = serverFor(await $.mcp.connect(SERVER_KEY))
    if (server === null) return null
    const result = await $.mcp.call(server, INVITE_TOOL, {})
    const text = result.content.find(block => block.type === 'text')
    const reply = text?.type === 'text' ? text.text : undefined
    const invite = result.isError ? null : inviteFrom(reply)
    if (invite === null) $.ui.log(`quotient setup: ${INVITE_TOOL} gave no invite to show`, { to: 'debug' })
    return invite
  } catch (error) {
    $.ui.log(`quotient setup: ${INVITE_TOOL} ${callFailure(error)}: ${errorText(error)}`, { to: 'debug' })
    return null
  }
}

/**
 * Draws the invite: a heading for the team's size, who joins, and the
 * message to paste with the link.
 *
 * @param els - The surface's elements
 * @param invite - The checked invite
 * @returns The invite block
 */
function inviteTree({ Box, Text }: Els, invite: SetupInvite) {
  const others = invite.memberCount - 1
  const heading =
    others === 0
      ? "You're the first on your team. Invite teammates by sharing the link."
      : `You have ${plural(others, 'teammate')} on Quotient so far. Invite more by sharing the link.`
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{heading}</Text>
      <Text dimColor>{`They'll join ${invite.companyName}. They won't see your sessions.`}</Text>
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={CARD_WIDTH + 4}>
        <Text>{others === 0 ? FIRST_MESSAGE : MORE_MESSAGE}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>{SIGNUP_LINE}</Text>
          <Text color="suggestion">{invite.inviteUrl}</Text>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Builds the invite message as it's pasted: the message, then the sign-up
 * line and the link.
 *
 * @param invite - The checked invite
 * @returns The text to copy
 */
function inviteText(invite: SetupInvite): string {
  const message = invite.memberCount === 1 ? FIRST_MESSAGE : MORE_MESSAGE
  return `${message}\n\n${SIGNUP_LINE}\n${invite.inviteUrl}`
}

/**
 * Draws what follows the invite once "Copy to share" is answered: what was
 * copied, or why it wasn't, then what happens next.
 *
 * @param els - The surface's elements
 * @param shared - How the question was answered
 * @param frictions - The new frictions the run stored
 * @returns The closing sections
 */
function sharedTree({ Box, Text }: Els, shared: NonNullable<SetupSummary['shared']>, frictions: number) {
  const { copy, isCopied } = shared
  const what = copy === 'message' ? 'message' : 'link'
  return (
    <Box flexDirection="column" marginTop={1}>
      {copy !== null && (
        <Box flexDirection="column">
          <Text dimColor>
            {`· ${INVITE_QUESTION} → `}
            <Text bold>{copy === 'message' ? COPY_MESSAGE : COPY_LINK}</Text>
          </Text>
          {isCopied ? (
            <Text>
              <Text color="success">✓</Text> {`${copy === 'message' ? 'Message' : 'Link'} copied. Paste it to your teammates in Slack.`}
            </Text>
          ) : (
            <Text>
              <Text color="warning">!</Text> {`Couldn't reach the clipboard here. Select the ${what} above to copy it.`}
            </Text>
          )}
        </Box>
      )}
      <Box flexDirection="column" marginTop={copy === null ? 0 : 1}>
        <Text bold>What happens next</Text>
        <Text>1. Your teammate joins.</Text>
        <Text>2. Quotient finds solutions in their setup.</Text>
        <Text>3. You get suggestions next session.</Text>
      </Box>
      {frictions > 0 && (
        <Box marginTop={1}>
          <Text dimColor>Your frictions stay saved. Run /list-fixes to see the full list.</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Asks "Copy to share" about a summary's invite, copies what the operator
 * chose, and keeps the outcome on the summary, which draws it. A dismissed
 * question, free text, or an answer given while they were away copies
 * nothing.
 *
 * @param $ - The engine
 * @param rowId - The summary call's id
 */
async function shareInvite($: Api, rowId: string): Promise<void> {
  const shown = (await read($, drawn))[rowId]
  if (shown?.kind !== 'summary' || shown.summary.invite === undefined) return
  const { invite } = shown.summary
  answeredWhileAway = false
  let choice: string | null
  try {
    choice = await $.ui.ask(INVITE_QUESTION, { header: 'Invite', options: [COPY_MESSAGE, COPY_LINK] })
  } catch {
    choice = null
  }
  const copy = answeredWhileAway ? null : choice === COPY_MESSAGE ? 'message' : choice === COPY_LINK ? 'link' : null
  const isCopied =
    copy !== null && (await $.ui.copy({ text: copy === 'message' ? inviteText(invite) : invite.inviteUrl })).isCopied
  await update($, drawn, (current): SetupDrawn => {
    const row = current[rowId]
    if (row?.kind !== 'summary') return current
    return { ...current, [rowId]: { ...row, summary: { ...row.summary, shared: { copy, isCopied } } } }
  })
}

/**
 * Says how widely a friction reached: its share of the run's sources, never
 * shown below 1%, or its session count when the run's size isn't known.
 *
 * @param sessions - The sessions and routine runs it appeared in
 * @param reviewedCount - The sources the run reviews, when its start message was shown
 * @returns The text after the friction's impact
 */
function reach(sessions: number, reviewedCount: number | undefined): string {
  if (reviewedCount === undefined || reviewedCount === 0) return plural(sessions, 'session')
  return `${Math.max(1, Math.round((100 * sessions) / reviewedCount))}% of sessions`
}

/**
 * Draws setup's final summary: only its designed sections, from the checked
 * fields, in the order the mockups show them.
 *
 * @param els - The surface's elements
 * @param summary - The checked fields
 * @returns The summary
 */
function summaryTree(els: Els, summary: SetupSummary) {
  const { Box, Text } = els
  const { frictions, working, top, remainingHigh, inCommon, teammateCheck, reviewedCount, invite, shared } = summary
  const isInvited = teammateCheck !== undefined
  const found = `Your agents ran into ${frictions === 0 ? 'no new frictions' : plural(frictions, 'friction')} in the last two weeks.`
  const remaining = frictions - top.length
  return (
    <Box flexDirection="column">
      <Text bold>{`Setup is done. ${found}`}</Text>
      {frictions > 0 && <Text>They're saved to Quotient, where your teammates' agents can look for fixes.</Text>}
      {working.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>What's working</Text>
          {working.map(item => (
            <Text>
              <Text color="success">✓</Text> {item}
            </Text>
          ))}
        </Box>
      )}
      {top.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Your top frictions</Text>
          {top.map(friction => {
            const { label, color } = SEVERITY_LABELS[friction.severity]
            return (
              <Box flexDirection="row">
                <Box width={SEVERITY_WIDTH} flexShrink={0}>
                  <Text color={color} dimColor={color === undefined}>
                    {label}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text>{friction.description}</Text>
                </Box>
                <Box flexShrink={0} marginLeft={2}>
                  <Text dimColor>
                    <Text color="suggestion">{impactLabel(friction.impact)}</Text>
                    {` · ${reach(friction.sessions, reviewedCount)}`}
                  </Text>
                </Box>
              </Box>
            )
          })}
          {frictions > MAX_ITEMS && (
            <Text dimColor>{`+ ${remaining} more, ${remainingHigh} of them high severity`}</Text>
          )}
        </Box>
      )}
      {teammateCheck !== undefined && teammateCheck.solvedCount > 0 && solvedTree(els, teammateCheck)}
      {teammateCheck !== undefined && invite === undefined && nextTree(els, teammateCheck.solvedCount)}
      {!isInvited && frictions > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Your teammates have probably already fixed some of these.</Text>
          <Text>{inCommon}</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Why a teammate's fix beats asking Claude</Text>
            <Text>
              · Claude suggests a general fix. A teammate's fix already works in this repo, with your CI and your local
              setup.
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text>Here's what you'd get back:</Text>
            {cardTree(els)}
          </Box>
        </Box>
      )}
      {!isInvited && frictions > 0 && invite === undefined && (
        <Box marginTop={1}>
          <Text>{LIST_FIXES_HINT}</Text>
        </Box>
      )}
      {invite !== undefined && inviteTree(els, invite)}
      {invite !== undefined && shared !== undefined && sharedTree(els, shared, frictions)}
    </Box>
  )
}

/**
 * Tells whether a path is one setup is expected to read in the Claude Code
 * config folder. A relative path, whose folder isn't known here, never is.
 *
 * @param path - The path a tool call names
 * @param dirs - The config, home and daily-run folders
 * @param isWhole - Whether everything under the path is read, as a Grep of a folder does
 * @returns Whether the path is an expected file, or an expected folder or inside one
 */
function isSetupRead(path: unknown, dirs: NonNullable<SetupRun['dirs']>, isWhole: boolean): boolean {
  if (typeof path !== 'string' || !/^[/~]/.test(path)) return false
  const full = fullPath(path, dirs, dirs.home)
  return full !== null && isConfigPath(full, dirs, isWhole)
}

/**
 * Tells whether a Glob call lists only inside a folder setup is expected to
 * read. Without a `path`, its pattern must be absolute.
 *
 * @param input - The Glob call's input
 * @param dirs - The config, home and daily-run folders
 * @returns Whether the Glob is expected
 */
function isSetupGlob(input: Record<string, unknown>, dirs: NonNullable<SetupRun['dirs']>): boolean {
  if (input.path === undefined && !(typeof input.pattern === 'string' && /^[/~]/.test(input.pattern))) return false
  if (input.path !== undefined && !(typeof input.path === 'string' && /^[/~]/.test(input.path))) return false
  const root = globRoot(input, dirs, dirs.home)
  return root !== null && isConfigPath(root, dirs, false)
}

/**
 * Tells whether a tool call is one setup is expected to make, so its row can
 * be hidden. Anything else stays visible, so the operator sees an unexpected
 * action without opening ctrl+o. Setup writes nothing on this machine, so a
 * shell command, a write or an edit is never expected.
 *
 * @param input - The call's input, with its tool
 * @param dirs - Where setup reads, or null when unknown
 * @returns Whether the call is expected
 */
function isExpectedCall(input: Record<string, unknown>, dirs: SetupRun['dirs']): boolean {
  const tool = input.tool as string
  if (QUIET_TOOLS.includes(tool)) return true
  if (tool === 'Skill') return input.skill === FIND_SOLUTIONS_SKILL
  if (dirs === null) return false
  if (tool === 'Read') return isSetupRead(input.file_path, dirs, false)
  if (tool === 'Grep') return isSetupRead(input.path, dirs, true)
  if (tool === 'Glob') return isSetupGlob(input, dirs)
  return false
}

/**
 * Looks up where setup reads transcripts and the operator's Claude Code
 * setup, in the session's own environment.
 *
 * @param $ - The engine
 * @returns The folders, or null when they can't be found
 */
async function lookUpDirs($: Api): Promise<SetupRun['dirs']> {
  try {
    const found = await $.process.run(
      [
        'sh',
        '-c',
        'printf "%s\\n%s\\n%s\\n" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$HOME" "${XDG_DATA_HOME:-$HOME/.local/share}/quotient"',
      ],
      { timeoutMs: 10_000 },
    )
    const [config, home, runs] = found.stdout.split('\n')
    if (found.exitCode !== 0 || !config?.startsWith('/') || !home?.startsWith('/') || !runs?.startsWith('/')) return null
    return { config, home, runs }
  } catch {
    return null
  }
}

/**
 * Adds what quotient knows to a `start_setup_run` reply: a pinned window's
 * end as its `startedAt`, so the skill's "two weeks before `startedAt`" is
 * the pinned window, and the routine ids the window's sessions mention. The
 * model only reads these, and never sends them back to Quotient.
 *
 * @param text - The reply's text
 * @param window - The pinned window, or undefined when none is pinned
 * @param routineIds - The routine ids, or undefined when none were found
 * @returns The changed reply, or undefined to leave it as it was sent
 */
function withStartAdditions(text: string | undefined, window: PinnedWindow | undefined, routineIds: string[] | undefined): string | undefined {
  const additions = {
    ...(window === undefined ? {} : { startedAt: `${window.end}T00:00:00Z` }),
    ...(routineIds === undefined || routineIds.length === 0 ? {} : { routineIdsInSessions: routineIds }),
  }
  if (Object.keys(additions).length === 0 || text === undefined) return undefined
  try {
    const reply: unknown = JSON.parse(text)
    if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return undefined
    return JSON.stringify({ ...reply, ...additions })
  } catch {
    return undefined
  }
}

/**
 * Names the Quotient setup tool a call went to, by the plugin's server or
 * the connector.
 *
 * @param tool - The called tool's full name
 * @returns The tool's name on the server, or undefined for any other tool
 */
function setupRunTool(tool: string): string | undefined {
  const prefix = QUOTIENT_PREFIXES.find(one => tool.startsWith(one))
  const name = prefix === undefined ? undefined : tool.slice(prefix.length)
  return name !== undefined && SETUP_RUN_TOOLS.includes(name) ? name : undefined
}

/**
 * Reads the sources a setup run has reviewed from one of the skill's calls:
 * all of them from `start_setup_run`'s reply, which resumes the run, and the
 * batch's own from a `record_setup_progress` call.
 *
 * @param name - The setup tool's name on the server
 * @param input - The call's input
 * @param text - The call's reply, as the model read it
 * @returns The sources, or undefined when the call says nothing about them
 */
function reviewedFrom(name: string, input: Record<string, unknown>, text: string | undefined): string[] | undefined {
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every(one => typeof one === 'string') ? (value as string[]) : undefined
  if (name === 'record_setup_progress') return strings(input.sources)
  if (name !== 'start_setup_run' || text === undefined) return undefined
  try {
    const reply: unknown = JSON.parse(text)
    return typeof reply === 'object' && reply !== null ? strings((reply as Record<string, unknown>).reviewedSources) : undefined
  } catch {
    return undefined
  }
}

/**
 * Says how far setup has got: getting ready until the start message is
 * shown, then how many of its sources it has recorded as reviewed.
 *
 * @param current - The setup run
 * @returns The progress, without a "Quotient setup" prefix
 */
function progress(current: SetupRun): string {
  if (current.start === null) return 'Quotient setup is getting ready…'
  const { sessions, automatedRuns, cloudRuns } = current.start
  return `${current.reviewedIds.length} of ${sessions + automatedRuns + cloudRuns} sources reviewed`
}

/**
 * Shows the setup run's progress on the status line, or clears it once the
 * run has ended.
 *
 * @param $ - The engine
 */
async function showStatus($: Api): Promise<void> {
  const current = await read($, run)
  let line: string | null = null
  if (current.isRunning) line = current.start === null ? 'setup is getting ready…' : `setup · ${progress(current)}`
  const parts = await update($, statusParts, latest => ({ ...latest, setup: line }))
  $.ui.status(statusLine(parts))
}

/**
 * Ends the setup run. Its rows stay hidden, since a row is drawn again on a
 * resize or scroll.
 *
 * @param $ - The engine
 */
async function endRun($: Api): Promise<void> {
  if (!(await read($, run)).isRunning) return
  await update($, run, current => ({ ...current, isRunning: false }))
  await showStatus($)
}

/**
 * Adds the sources a setup run has reviewed, each counted once, and shows the
 * new count.
 *
 * @param $ - The engine
 * @param sources - The sources a setup call named
 */
async function addReviewed($: Api, sources: readonly string[]): Promise<void> {
  await update($, run, current => ({ ...current, reviewedIds: [...new Set([...current.reviewedIds, ...sources])] }))
  await showStatus($)
}

/**
 * Reads the company the operator joined from a `start_setup_run` reply.
 *
 * @param text - The reply's text
 * @returns The company's name, or null when the reply names none or can't be read
 */
function joinedCompanyFrom(text: string | undefined): string | null {
  let reply: unknown
  try {
    reply = JSON.parse(text ?? '')
  } catch {
    return null
  }
  const joined = (reply as { joinedCompany?: unknown } | null)?.joinedCompany
  const name = (joined as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' ? cleanText(name) : null
}

/**
 * Answers a `setup_start` call: refuses input that breaks a rule, or keeps
 * the start values for its row, the band and the status line.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @param toolUseId - The call's id, which its row carries
 * @returns The refusal, or the instruction to go on quietly
 */
async function answerStart(
  $: Api,
  input: Record<string, unknown>,
  toolUseId: string | undefined,
): Promise<{ deny: string } | { result: string }> {
  const dirs = (await read($, run)).dirs
  const window = pinnedWindow(await $.env.get('QUOTIENT_SETUP_WINDOW_END'))
  const counted = dirs === null ? undefined : await countSources($, dirs, window).catch(() => undefined)
  const checked = checkStart(input, counted)
  if (checked.error !== undefined) return { deny: checked.error }
  const start = window === undefined ? checked.value : { ...checked.value, firstDay: window.firstDay, lastDay: window.lastDay }
  if (toolUseId !== undefined) {
    const { joinedCompany } = await read($, run)
    await update($, drawn, (current): SetupDrawn => ({ ...current, [toolUseId]: { kind: 'start', start, joinedCompany } }))
  }
  await update($, run, current => (current.isRunning ? { ...current, start } : current))
  if ((await read($, run)).isRunning) await showStatus($)
  if (counted === undefined) return { result: GO_ON }
  const { sessions, automatedRuns, files, leftOut } = counted
  const found = `quotient counted ${plural(sessions, 'session')} and ${plural(automatedRuns, 'automated run')} from the last two weeks, leaving out every session setup skips`
  const counts =
    leftOut === 0
      ? `${found}.`
      : `${found} and ${plural(leftOut, 'older run')} of recurring automated jobs: it lists the latest runs of each job, about the square root of its run count, from ${JOB_SAMPLE.min} to ${JOB_SAMPLE.max}.`
  const held = await teammateHolders($, files)
  if (held === null) return { result: `${counts} ${GO_ON}` }
  const reviewed = (await read($, run)).reviewedIds
  const listed = files.filter(file => !held.includes(file))
  const byName = Object.fromEntries(listed.map(file => [file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, ''), file]))
  await update($, run, current => (current.isRunning ? { ...current, listed: byName } : current))
  return { result: [counts, batchesText(batchSources(listed, reviewed), held.length), GO_ON].join('\n') }
}

const NOT_LISTED = 'setup_digest reads only the sources setup_start listed in this run: pass one by its name, as the batch gives it'
const NOT_SETUP = 'setup_digest works only while /quotient:setup is running'
const HOLDS_FIXES = "This session's transcript holds teammates' fixes, which setup never reads: skip it"
const UNCHECKED = "quotient couldn't check this transcript for teammates' fixes, so it isn't read: skip it"

/**
 * Shortens a RemoteTrigger reply setup reads, keeping its shape: a routine
 * list or routine to the fields setup reads, and a run log to one short line
 * per event. Any other reply, or one that isn't what it should be, goes on
 * unchanged.
 *
 * @param called - The call's outcome
 * @param action - The call's action, such as `list` or `get_run_log`
 * @returns The outcome, its result shortened when it could be
 */
function compactRemote<R extends { result?: unknown }>(called: R, action: unknown): R {
  const result = called.result
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return called
  const reply = result as Record<string, unknown>
  if (action === 'get_run_log' && typeof reply.summary === 'string') {
    return { ...called, result: { ...reply, summary: runLogDigest(reply.summary) } }
  }
  const json = (action === 'list' || action === 'get') && typeof reply.json === 'string' ? compactRoutines(reply.json) : null
  return json === null ? called : { ...called, result: { ...reply, json } }
}

/**
 * Answers a `setup_digest` call with a digest of one listed source, or
 * refuses: the source must be one `setup_start` listed in this run, and
 * its transcript must hold no teammates' fixes when it's read.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @returns The refusal, or the digest
 */
async function answerDigest($: Api, input: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
  const current = await read($, run)
  if (!current.isRunning) return { deny: NOT_SETUP }
  const source = input.source
  const path = typeof source === 'string' && Object.hasOwn(current.listed, source) ? current.listed[source] : undefined
  if (path === undefined || typeof source !== 'string') return { deny: NOT_LISTED }
  // The transcript can gain teammates' fixes after setup_start, such as setup's own session's.
  const held = await $.process.run(['grep', '-q', '-E', '--', TEAMMATE_TOOL_USE, path], { timeoutMs: 30_000 }).catch(() => undefined)
  const verdict = heldVerdict(held?.exitCode)
  if (verdict !== 'clean') return { deny: verdict === 'holds' ? HOLDS_FIXES : UNCHECKED }
  const lines = await readLines($, path)
  return holdsTeammateText(lines, TEAMMATE_TOOL_USE) ? { deny: HOLDS_FIXES } : { result: digest(source, lines) }
}

/**
 * Reads a transcript's lines in ranges, so no read passes the 4 MiB a
 * process's output keeps. A single line past it is kept as its size alone.
 * Nothing is written to disk.
 *
 * @param $ - The engine
 * @param path - The transcript
 * @returns Its lines, numbered from 1
 * @throws When a range can't be read
 */
async function readLines($: Api, path: string): Promise<TranscriptLine[]> {
  const lines: TranscriptLine[] = []
  let from = 1
  let count = LINES_PER_READ
  for (;;) {
    const chunk = await $.process.run(['sed', '-n', `${from},${from + count - 1}p`, path], { timeoutMs: 30_000 })
    if (chunk.exitCode !== 0) throw new Error(`sed exited ${chunk.exitCode}`)
    if (chunk.isStdoutTruncated && count > 1) {
      count = Math.max(1, Math.floor(count / 2))
      continue
    }
    if (chunk.isStdoutTruncated) {
      const size = await $.process.run(['awk', `NR == ${from} { print length($0); exit }`, path], { timeoutMs: 30_000 })
      lines.push({ n: from, text: null, bytes: Number(size.stdout.trim()) || 0 })
      from += 1
      count = LINES_PER_READ
      continue
    }
    const got = chunk.stdout.split('\n')
    if (got.at(-1) === '') got.pop()
    got.forEach((text, i) => lines.push({ n: from + i, text, bytes: text.length }))
    if (got.length < count) return lines
    from += got.length
    count = LINES_PER_READ
  }
}

/** One batch of sources for one reviewer: up to ten transcript names, grouped by project folder. */
type Batch = { folder: string; ids: string[] }[]

const BATCH_SIZE = 10

/**
 * Packs the transcripts setup still has to review into batches of at most
 * ten, in folder and then name order, so a folder with few transcripts
 * shares a batch with the next.
 *
 * @param files - The transcripts' full paths
 * @param reviewed - The sources the run already recorded, by transcript name without `.jsonl`
 * @returns The batches
 */
function batchSources(files: readonly string[], reviewed: readonly string[]): Batch[] {
  const sources = files
    .map(file => {
      const cut = file.lastIndexOf('/')
      return { folder: file.slice(0, cut), id: file.slice(cut + 1).replace(/\.jsonl$/, '') }
    })
    .filter(source => !reviewed.includes(source.id))
    .sort((a, b) => (a.folder === b.folder ? compare(a.id, b.id) : compare(a.folder, b.folder)))
  const batches: Batch[] = []
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch: Batch = []
    for (const { folder, id } of sources.slice(i, i + BATCH_SIZE)) {
      const last = batch.at(-1)
      if (last?.folder === folder) last.ids.push(id)
      else batch.push({ folder, ids: [id] })
    }
    batches.push(batch)
  }
  return batches
}

/**
 * Orders two strings by their UTF-16 code units, as `Array.prototype.sort` does by default.
 *
 * @param a - One string
 * @param b - The other
 * @returns Negative, zero or positive
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Tells the model which batches to review, and how to read them.
 *
 * @param batches - The batches
 * @param held - How many transcripts were left out for holding teammates' fixes
 * @returns The instruction
 */
function batchesText(batches: readonly Batch[], held: number): string {
  const total = batches.reduce((sum, batch) => sum + batch.reduce((count, group) => count + group.ids.length, 0), 0)
  const lines =
    total === 0
      ? ['No local session or automated run is left to review.']
      : [
          `Review these ${plural(total, 'source')} in ${plural(batches.length, 'batch', 'batches')}, in this order. Review each through setup_digest, by its name. Never read a transcript itself, and don't list or search the projects folder yourself.`,
          ...batches.map((batch, i) => `Batch ${i + 1}, ${batch.map(group => `in ${group.folder}: ${group.ids.join(', ')}`).join('; ')}`),
        ]
  if (held === 1) lines.push("1 session holds teammates' fixes, so it's left out: never read it.")
  if (held > 1) lines.push(`${held} sessions hold teammates' fixes, so they're left out: never read them.`)
  return lines.join('\n')
}

/**
 * Finds the transcripts that hold teammates' fixes, which setup never reads.
 *
 * @param $ - The engine
 * @param files - The transcripts' full paths
 * @returns The ones that hold them, or null when they couldn't be checked
 */
async function teammateHolders($: Api, files: readonly string[]): Promise<string[] | null> {
  if (files.length === 0) return []
  try {
    const found = await $.process.run(['grep', '-l', '-E', '--', TEAMMATE_TOOL_USE, ...files], { timeoutMs: 30_000 })
    // grep exits 1 when no file matched.
    if (found.exitCode !== 0 && found.exitCode !== 1) return null
    return found.stdout.split('\n').filter(file => file !== '')
  } catch {
    return null
  }
}

/**
 * Lists and counts the local sessions and automated runs setup reviews: the
 * last two weeks' transcripts under the config folder, leaving out the
 * skipped project folders and the sessions that started with one of
 * quotient's skills, an automated run being one a script or the Agent SDK
 * started. quotient counts them itself, so the skill injects no shell
 * command.
 *
 * @param $ - The engine
 * @param dirs - The config folder and the daily-run folder
 * @param window - Fixed days to count in place of the last two weeks, when pinned
 * @returns The counts, and every transcript's full path
 * @throws When the transcripts can't be listed or searched
 */
async function countSources(
  $: Api,
  dirs: NonNullable<SetupRun['dirs']>,
  window?: PinnedWindow,
): Promise<SourceCounts & { files: string[]; leftOut: number }> {
  const recent = await windowFiles($, dirs, window)
  if (recent.length === 0) return { sessions: 0, automatedRuns: 0, files: [], leftOut: 0 }
  const started = await $.process.run(['awk', QUOTIENT_STARTED, ...recent], { timeoutMs: 30_000 })
  if (started.exitCode !== 0) throw new Error(`awk exited ${started.exitCode}`)
  const quotientRuns = new Set(started.stdout.split('\n'))
  const files = recent.filter(file => !quotientRuns.has(file))
  if (files.length === 0) return { sessions: 0, automatedRuns: 0, files, leftOut: 0 }
  const automated = await $.process.run(['grep', '-l', '--', '"entrypoint":"sdk-', ...files], { timeoutMs: 30_000 })
  // grep exits 1 when no file matched.
  if (automated.exitCode !== 0 && automated.exitCode !== 1) throw new Error(`grep exited ${automated.exitCode}`)
  const runs = automated.stdout.split('\n').filter(file => file !== '')
  const olderRuns = await olderJobRuns($, runs)
  const kept = files.filter(file => !olderRuns.includes(file))
  return { sessions: files.length - runs.length, automatedRuns: runs.length - olderRuns.length, files: kept, leftOut: olderRuns.length }
}

/**
 * Lists the transcripts of the two weeks setup reviews, leaving out the
 * skipped project folders.
 *
 * @param $ - The engine
 * @param dirs - The config folder and the daily-run folder
 * @param window - Fixed days in place of the last two weeks, when pinned
 * @returns Each transcript's full path
 * @throws When the transcripts can't be listed
 */
async function windowFiles($: Api, dirs: NonNullable<SetupRun['dirs']>, window?: PinnedWindow): Promise<string[]> {
  const found = await $.process.run(transcriptFindArgs(`${dirs.config}/projects`, window ?? { days: WINDOW_DAYS }), { timeoutMs: 30_000 })
  if (found.exitCode !== 0) throw new Error(`find exited ${found.exitCode}`)
  return found.stdout.split('\n').filter(file => file !== '' && !isSkippedProject(file.split('/').at(-2) ?? '', dirs))
}

// A cloud routine's id, as a session that made or ran one mentions it.
const ROUTINE_ID = 'trig_[A-Za-z0-9]{10,}'
const MAX_ROUTINE_IDS = 50

/**
 * Finds the cloud routines the window's sessions mention, since RemoteTrigger
 * lists only the first 20. Sessions that hold teammates' fixes are left out.
 *
 * @param $ - The engine
 * @param dirs - The config folder and the daily-run folder
 * @param window - Fixed days in place of the last two weeks, when pinned
 * @returns The routine ids, most mentioned first, or undefined when they couldn't be found safely
 */
async function routineIdsInSessions($: Api, dirs: SetupRun['dirs'], window?: PinnedWindow): Promise<string[] | undefined> {
  if (dirs === null) return undefined
  const files = await windowFiles($, dirs, window)
  const held = await teammateHolders($, files)
  if (held === null) return undefined
  const readable = files.filter(file => !held.includes(file))
  if (readable.length === 0) return []
  const found = await $.process.run(['grep', '-ohE', '--', ROUTINE_ID, ...readable], { timeoutMs: 30_000 })
  // grep exits 1 when no file matched.
  if (found.exitCode !== 0 && found.exitCode !== 1) return undefined
  const counts = new Map<string, number>()
  for (const id of found.stdout.split('\n')) if (id !== '') counts.set(id, (counts.get(id) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
    .slice(0, MAX_ROUTINE_IDS)
    .map(([id]) => id)
}

// How many of a recurring automated job's runs setup reviews: about the
// square root of its run count, so a job that runs on every change gets more
// than a daily one, but never all of them.
const JOB_SAMPLE = { min: 3, max: 15 }
// An automated run's first prompt, up to its first escape or 60 characters,
// as an extended regular expression for grep: runs of one job start alike.
const FIRST_PROMPT = '"role":"user","content":(\\[\\{"type":"text","text":)?"[^"\\\\]{0,60}'

/**
 * Finds the automated runs setup leaves out: all but the latest runs of each
 * recurring job, about the square root of its run count, a job being the
 * runs whose first prompts start alike.
 * A run whose prompt can't be read is its own job, so nothing is left out
 * unless quotient could read it.
 *
 * @param $ - The engine
 * @param runs - The automated runs' full paths
 * @returns The runs to leave out, or none when they couldn't be ordered or read
 */
async function olderJobRuns($: Api, runs: readonly string[]): Promise<string[]> {
  if (runs.length <= JOB_SAMPLE.min) return []
  try {
    const newest = await $.process.run(['ls', '-t', '--', ...runs], { timeoutMs: 30_000 })
    const prompts = await $.process.run(['grep', '-m', '1', '-o', '-E', '--', FIRST_PROMPT, ...runs], { timeoutMs: 30_000 })
    if (newest.exitCode !== 0 || (prompts.exitCode !== 0 && prompts.exitCode !== 1)) return []
    const promptOf = new Map<string, string>()
    for (const line of prompts.stdout.split('\n')) {
      const cut = line.indexOf('.jsonl:')
      if (cut !== -1 && !promptOf.has(line.slice(0, cut + 6))) promptOf.set(line.slice(0, cut + 6), line.slice(cut + 7))
    }
    const byJob = new Map<string, string[]>()
    for (const run of newest.stdout.split('\n').filter(file => runs.includes(file))) {
      const prompt = promptOf.get(run)
      if (prompt !== undefined) byJob.set(prompt, [...(byJob.get(prompt) ?? []), run])
    }
    const older: string[] = []
    for (const jobRuns of byJob.values()) {
      const kept = Math.min(JOB_SAMPLE.max, Math.max(JOB_SAMPLE.min, Math.round(Math.sqrt(jobRuns.length))))
      older.push(...jobRuns.slice(kept))
    }
    return older
  } catch {
    return []
  }
}

/**
 * Answers a `setup_summary` call: refuses input that breaks a rule, or keeps
 * the summary for its result row to draw.
 *
 * @param $ - The engine
 * @param input - The call's input
 * @param toolUseId - The call's id, which its result row carries
 * @returns The refusal, or the instruction to end the turn
 */
async function answerSummary(
  $: Api,
  input: Record<string, unknown>,
  toolUseId: string | undefined,
): Promise<{ deny: string } | { result: string }> {
  const current = await read($, run)
  const teammates = current.start?.checksTeammates
    ? teammateCheckFrom(current.teammateTitles, current.teammateAnswers, current.reviewedIds)
    : undefined
  const checked = checkSummary(input, current.reviewedIds, teammates)
  if (checked.error !== undefined) return { deny: checked.error }
  const { start } = current
  const invite = await fetchInvite($)
  const summary = {
    ...checked.value,
    ...(start === null ? {} : { reviewedCount: start.sessions + start.automatedRuns + start.cloudRuns }),
    ...(invite === null ? {} : { invite }),
  }
  if (toolUseId !== undefined) {
    await update($, drawn, (current): SetupDrawn => ({ ...current, [toolUseId]: { kind: 'summary', summary } }))
  }
  inviteRowId = invite === null || toolUseId === undefined ? null : toolUseId
  await endRun($)
  const endsWithHint = summary.teammateCheck === undefined && summary.frictions > 0 && invite === null
  return { result: endsWithHint ? END_TURN_WITH_HINT : END_TURN }
}

/**
 * Handles a teammate-check call during a setup run, after it ran. Setup's own
 * session holds submit_frictions, so it learns only whether teammates have
 * frictions, never their text. The teammate-check subagent's calls are
 * recorded instead: each friction's title as Quotient listed it, and each
 * answer as it was sent, leaving out any Quotient refused, each with a log
 * line of its own.
 *
 * @param $ - The engine
 * @param input - The call's input, with its tool
 * @param agentId - The subagent that made the call, absent for setup's own session
 * @param called - What the call answered
 * @returns What the model reads
 */
async function answerTeammateCall<R extends { text?: string }>(
  $: Api,
  input: Record<string, unknown>,
  agentId: string | undefined,
  called: R,
): Promise<R | { deny: string }> {
  const name = quotientTool(input.tool as string)
  if (name === 'list_teammate_frictions') {
    const titles = teammateTitlesFrom(called.text)
    if (agentId === undefined) {
      if (titles === null) return { deny: "quotient withheld this reply: it couldn't be read" }
      const text = JSON.stringify({ hasFrictions: Object.keys(titles).length > 0 })
      return { result: [{ type: 'text', text }] } as unknown as R
    }
    if (titles !== null) await update($, run, current => ({ ...current, teammateTitles: { ...current.teammateTitles, ...titles } }))
  }
  if (agentId === undefined) return called
  for (const { frictionId, description } of sentAnswers(name, input, called.text)) {
    const fix = cleanText(typeof description === 'string' ? description : null)
    const current = await update($, run, latest => ({ ...latest, teammateAnswers: [...latest.teammateAnswers, { frictionId, fix }] }))
    const shown = cardText(fix, current.reviewedIds)
    $.ui.log(
      fix === null
        ? "Checked a teammate's friction: no fix found in your setup."
        : shown === null
          ? 'Sent a teammate a fix.'
          : `Sent a teammate a fix: ${shown}`,
    )
  }
  return called
}

/**
 * Starts a setup run: its progress, folders and teammate-check record start
 * over, and the earlier runs' rows stay hidden.
 *
 * @param $ - The engine
 */
async function startSetupRun($: Api): Promise<void> {
  await update($, run, current => ({
    ...NO_RUN,
    isRunning: true,
    toolUseIds: current.toolUseIds,
    agentIds: current.agentIds,
  }))
  await showStatus($)
  const dirs = await lookUpDirs($)
  await update($, run, current => ({ ...current, dirs }))
}

/** Setup's tools, which the setup skill calls; the session registers them. */
export const SETUP_TOOLS_SPECS = [
  {
    name: 'setup_start',
    description:
      "Shows the operator /quotient:setup's start message. Call it once, before reviewing anything, with the values the setup skill lists.",
    inputSchema: START_SCHEMA,
    isDeferred: false,
  },
  {
    name: 'setup_digest',
    description:
      "Returns a short digest of one session or automated run /quotient:setup is reviewing: its prompts, errors, refusals, interrupts, repeated calls and large results, each with its transcript line. Pass a source by its name, as setup_start's batches give it.",
    inputSchema: DIGEST_SCHEMA,
    isDeferred: false,
  },
  {
    name: 'setup_summary',
    description:
      "Shows the operator /quotient:setup's final summary. Call it once, at the end of setup, with the fields the setup skill lists, then end your turn.",
    inputSchema: SUMMARY_SCHEMA,
    isDeferred: false,
  },
] as const

/**
 * Tracks a setup run and checks what the skill sends.
 *
 * @param on - Adds the module's hooks
 */
export const registerSetup: Register = on => {
  on('command.run', { command: SETUP_COMMAND }, async ($, e, next) => {
    await startSetupRun($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The teammate check reads with Read, Grep and Glob only, and Glob lists
  // files oldest first and stops at 100, so it can't find the window's
  // sessions itself: its prompt names their project folders.
  on('agent.spawn', async ($, e, next) => {
    const current = await read($, run)
    if (e.subagentType !== TEAMMATE_CHECK_AGENT || !current.isRunning || current.dirs === null) return next(e)
    const window = pinnedWindow(await $.env.get('QUOTIENT_SETUP_WINDOW_END'))
    const dirs = current.dirs
    const folders = projectFolders(await windowFiles($, dirs, window), name => isSkippedProject(name, dirs))
    return folders.length === 0 ? next(e) : next({ ...e, prompt: `${e.prompt}\n\n${RECENT_FOLDERS} ${folders.join(' ')}` })
  }).catch(($, e, next) => next(e))

  // One hook for every call: the summary tool's name isn't in the generated
  // tool types until a session has registered it, so it's matched by hand.
  // No .catch: falling back to next(e) after the call ran would run it again.
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) === START_TOOL) {
      return answerStart($, e as unknown as Record<string, unknown>, e.tool_use_id)
    }
    if ((e.tool as string) === SUMMARY_TOOL) {
      return answerSummary($, e as unknown as Record<string, unknown>, e.tool_use_id)
    }
    if ((e.tool as string) === DIGEST_TOOL) {
      return answerDigest($, e as unknown as Record<string, unknown>)
    }
    // Setup the model starts with the Skill tool runs the same as typed.
    const skill = (e as unknown as Record<string, unknown>).skill
    if (e.tool === 'Skill' && e.agentId === undefined && next.origin.plugin === 'engine' && isQuotientSkill(skill, ['setup'], true)) {
      await startSetupRun($)
    }
    const current = await read($, run)
    if (current.isRunning) {
      // Only an expected call's row is hidden; a subagent's id and an Agent
      // call's name mark the subagent as setup's, for its report-back rows.
      const id = e.tool_use_id
      const isHidden = id !== undefined && isExpectedCall(e as unknown as Record<string, unknown>, current.dirs)
      const agentId = e.agentId
      const agentName = e.tool === 'Agent' ? (e.name ?? e.subagent_type ?? DEFAULT_AGENT) : undefined
      await update($, run, latest => ({
        ...latest,
        toolUseIds: isHidden ? [...latest.toolUseIds, id] : latest.toolUseIds,
        agentIds: agentId === undefined || latest.agentIds.includes(agentId) ? latest.agentIds : [...latest.agentIds, agentId],
        agentNames:
          agentName === undefined || latest.agentNames.includes(agentName)
            ? latest.agentNames
            : [...latest.agentNames, agentName],
      }))
    }
    const called = await next(e)
    const name = setupRunTool(e.tool as string)
    if (name !== undefined && called.deny === undefined && called.isError !== true && (await read($, run)).isRunning) {
      const sources = reviewedFrom(name, e as unknown as Record<string, unknown>, called.text)
      if (sources !== undefined) await addReviewed($, sources)
    }
    if (called.deny !== undefined || called.isError === true || !(await read($, run)).isRunning) return called
    if (e.tool === 'RemoteTrigger') return compactRemote(called, (e as unknown as Record<string, unknown>).action)
    if (name === 'start_setup_run') {
      const joinedCompany = joinedCompanyFrom(called.text)
      await update($, run, latest => ({ ...latest, joinedCompany }))
      const window = pinnedWindow(await $.env.get('QUOTIENT_SETUP_WINDOW_END'))
      const routineIds = await routineIdsInSessions($, (await read($, run)).dirs, window).catch(() => undefined)
      const added = withStartAdditions(called.text, window, routineIds)
      if (added !== undefined) return { result: [{ type: 'text', text: added }] } as unknown as typeof called
    }
    return answerTeammateCall($, e as unknown as Record<string, unknown>, e.agentId, called)
  })

  // A setup tool's own row draws what the call sent, and its result row,
  // which would only repeat the instruction to the model, is hidden.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const shown = (await read($, drawn))[e.props.tool_use_id]
    if (shown?.kind === 'summary') return summaryTree($.ui.resolve(e), shown.summary)
    if (shown?.kind === 'start') return startTree($.ui.resolve(e), shown.start, shown.joinedCompany)
    // Until the call is checked, its row would show the raw input.
    const isUnchecked = [START_TOOL, SUMMARY_TOOL].includes(e.props.tool as string) && e.props.isRunning
    if (!isUnchecked && !(await read($, run)).toolUseIds.includes(e.props.tool_use_id)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  // While setup's reviewers run, the main agent ends turns to wait on them,
  // and Claude Code asks it for visible text when a turn ends with none, so
  // it writes status lines the skill can't stop. They're drawn as nothing
  // until the reviewers have reported; ctrl+o still shows them.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const current = await read($, run)
    if (!current.isRunning || current.start === null) return next(e)
    const agents = await $.agent.list()
    if (!agents.some(agent => agent.type === REVIEWER_AGENT && ACTIVE.includes(agent.status))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const isSetup =
      (await read($, drawn))[e.props.tool_use_id] !== undefined ||
      (await read($, run)).toolUseIds.includes(e.props.tool_use_id)
    if (!isSetup) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  // Setup's subagents work in the background, so a turn that ends on its own
  // doesn't end the run: the summary, the operator's own prompt, an
  // interrupted turn or the end of the session does.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && e.command?.name !== SETUP_COMMAND) await endRun($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.reason === 'aborted' && e.agentId === undefined) await endRun($)
    const rowId = inviteRowId
    if (e.reason !== 'answer' || e.agentId !== undefined || rowId === null) return next(e)
    inviteRowId = null
    const done = await next(e)
    await shareInvite($, rowId)
    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const asked = await next(e)
    const reply = asked.result as { afkTimeoutMs?: number } | undefined
    if (e.questions.some(one => one.question === INVITE_QUESTION) && reply?.afkTimeoutMs !== undefined) {
      answeredWhileAway = true
    }
    return asked
  })

  on('session.end', async ($, e, next) => {
    await endRun($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, run)
    if (!current.isRunning || e.props.hasSurvey) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{progress(current)}</Text>
  }).catch(($, e, next) => next(e))

  // Hidden only when the group is setup's calls and nothing else, so a
  // recalled memory or another row in it still shows.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.isCallsOnly !== true) return next(e)
    const { toolUseIds } = await read($, run)
    if (!e.props.calls.every(call => call.tool_use_id !== undefined && toolUseIds.includes(call.tool_use_id))) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  // A setup subagent's finished line names its Agent call or its id. Its
  // report-back names only its sender, so that row is matched by name, and
  // only while the run goes on.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const current = await read($, run)
    const { task, from } = e.props
    const isFinished =
      task !== undefined &&
      ((task.toolUseId !== undefined && current.toolUseIds.includes(task.toolUseId)) ||
        (task.id !== undefined && current.agentIds.includes(task.id)))
    const isReport =
      current.isRunning && e.props.origin.kind === 'peer' && from !== undefined && current.agentNames.includes(from.name)
    if (!isFinished && !isReport) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))
}
