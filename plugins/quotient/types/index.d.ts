/** A teammate's solution to one of the operator's frictions, as the pane shows it. */
export type SolutionRow = {
  /** Only for starting fix-friction with this solution; never drawn. */
  id: string
  description: string | null
  found: string
  isImplemented: boolean
}

/** One friction as `list_my_frictions` returns it with `format: "rows"`. */
export type FrictionRow = {
  id: string
  /** The short name the list shows: the description until the API stores a title. */
  title: string
  symbol: string
  severity: string
  status: string
  description: string
  identified: string
  frequency: string
  impact: string
  /** How many of the reviewed sessions and routine runs it appeared in, or null when not counted. */
  affectedSessionCount: number | null
  /** How many sessions and routine runs were reviewed when it was found, or null when not counted. */
  reviewedSessionCount: number | null
  /** Whether a teammate's solution is still there to implement, and the operator hasn't fixed it themselves. */
  isFixable: boolean
  solutions: SolutionRow[]
  ownFix: { description: string | null; day: string } | null
}

/** The friction the pane last opened, and whether its details are showing. */
export type FrictionView = { id: string; isDetails: boolean } | null

/** The teammate's fix the operator picked in the pane and the main thread is working on. */
export type FixInProgress = { frictionId: string; solutionId: string } | null

/** The card the fix-friction skill shows before asking whether to apply a fix. */
export type FixCard = {
  friction: string
  fix: string
  file: string | null
  removed: string[]
  added: string[]
}

/** What a fix tool's row draws, by the call's tool_use_id. */
export type FixDrawn = Record<
  string,
  | { kind: 'card'; card: FixCard }
  | { kind: 'implemented' }
  | { kind: 'skipped' }
  | { kind: 'notRecorded'; error: string }
  | { kind: 'thanks'; isRetry: boolean; error: string | null; isNoteSent: boolean; closing: string | null }
>

/**
 * The fix just recorded as implemented, whose thank-you isn't settled yet.
 * `message` is absent until the operator chooses, null for a high-five, and
 * the note's text for a note; a failed send keeps it for the retry.
 */
export type ThanksDue = { solutionId: string; message?: string | null } | null

/**
 * Each feature's line for the plugin's one status line; the first set one
 * shows. A value stored before `frictionsToFix` existed lacks it.
 */
export type StatusParts = { setup: string | null; frictionsToFix?: string | null; fixes: string | null }

/** The kind of harm a friction did, as Quotient stores it. */
export type FrictionImpact = 'SAFETY' | 'QUALITY' | 'BLOCKED' | 'OPERATOR_ATTENTION' | 'COST' | 'TIME'

/** A friction in setup's summary, as the `setup_summary` tool takes it. */
export type SetupTopFriction = {
  severity: 'high' | 'medium' | 'low'
  description: string
  impact: FrictionImpact
  sessions: number
}

/** A teammate's friction the operator's setup already solves, as `setup_summary` takes it. */
export type SetupSolved = {
  /** The teammate friction's title, as Quotient listed it. */
  friction: string
  /** The fix, as the teammate check sent it. */
  fix: string
}

/** What setup's check of the operator's setup for teammates' fixes found. */
export type SetupTeammateCheck = {
  /** How many answers carried a fix, of which `solved` holds up to three. */
  solvedCount: number
  solved: SetupSolved[]
}

/** The fields of a `setup_summary` call that passed its checks. */
export type SetupSummary = {
  frictions: number
  working: string[]
  top: SetupTopFriction[]
  remainingHigh: number
  inCommon?: string
  /** Present when setup checked the operator's setup for teammates' fixes. */
  teammateCheck?: SetupTeammateCheck
  /** How many sources the run recorded as reviewed; absent when it recorded none. */
  reviewedCount?: number
  /** The company's invite link, when it can invite and its trial has a seat left. */
  invite?: SetupInvite
  /** How "Copy to share" was answered, once it has been: what was copied, if anything, and whether it reached the clipboard. */
  shared?: { copy: 'message' | 'link' | null; isCopied: boolean }
}

/** A company's invite link, from a `get_invite_link` reply that passed its checks. */
export type SetupInvite = {
  companyName: string
  inviteUrl: string
  /** The company's members, the operator included. */
  memberCount: number
}

/** The fields of a `setup_start` call that passed its checks. */
export type SetupStart = {
  sessions: number
  automatedRuns: number
  cloudRuns: number
  firstDay: string
  lastDay: string
  /** Whether setup also checks the operator's setup for fixes to teammates' frictions. */
  checksTeammates: boolean
}

/** What a setup tool's result row draws, by the call's tool_use_id. */
export type SetupDrawn = Record<
  string,
  { kind: 'start'; start: SetupStart; joinedCompany: string | null } | { kind: 'summary'; summary: SetupSummary }
>

/**
 * Where a sandboxed agent may read, every folder as its real path: the
 * Claude Code config, home and daily-run folders, and the git repos its
 * sessions worked in (none for an agent that reads only the config folder).
 */
export type SandboxReach = { dirs: { config: string; home: string; runs: string }; repos: string[] }

/** Which kind of quotient command last started: one that shows teammates' fixes, one that hides them, or none. */
export type TeammateTextMode = 'shows' | 'hides' | null

/** The setup run in progress, if any, and which rows and subagents are its own. */
export type SetupRun = {
  isRunning: boolean
  toolUseIds: string[]
  agentIds: string[]
  /** The names setup's subagents report back under: each Agent call's name, else its type. */
  agentNames: string[]
  start: SetupStart | null
  /** Where setup is expected to read (the Claude Code config folder), the home folder and quotient's daily-run folder, or null when they couldn't be looked up. */
  dirs: { config: string; home: string; runs: string } | null
  /** The sources the run has recorded as reviewed, from Quotient's replies and the skill's progress calls. */
  reviewedIds: string[]
  /** Each transcript `setup_start` listed for review, by its name without `.jsonl`: the only ones `setup_digest` reads. */
  listed: Record<string, string>
  /** Each teammate friction's title, cleaned, by its id, from the teammate check's `list_teammate_frictions` replies. */
  teammateTitles: Record<string, string>
  /** Each answer the teammate check sent with `submit_solutions` or `submit_solution`: its fix, cleaned, or null for none. */
  teammateAnswers: SetupAnswer[]
  /** The company the operator joined, when `start_setup_run` says this is their first setup since joining it. */
  joinedCompany: string | null
}

/** The review-frictions run in progress, if any, and the sessions it may read. */
export type ReviewRun = {
  isRunning: boolean
  /** Each transcript `review_sessions` listed, by its name without `.jsonl`: the only ones `review_digest` reads. */
  listed: Record<string, string>
}

/** One answer setup's teammate check sent to a teammate's friction. */
export type SetupAnswer = { frictionId: string; fix: string | null }

declare module 'claude-code' {
  interface PluginState {
    quotient: {
      rows: Shaped<FrictionRow[]>
      view: FrictionView
      working: FixInProgress
      fixDrawn: Shaped<FixDrawn>
      fixesImplemented: number
      thanksDue: Shaped<ThanksDue>
      noteError: string | null
      statusParts: StatusParts
      setupDrawn: Shaped<SetupDrawn>
      setupRun: Shaped<SetupRun>
      reviewRun: Shaped<ReviewRun>
      sandboxReach: Shaped<SandboxReach | null>
      sandboxedAgents: Shaped<string[]>
      teammateTextMode: TeammateTextMode
      teammateTextShownIn: string | null
      teammateCheckCalls: Shaped<string[]>
    }
  }
}
