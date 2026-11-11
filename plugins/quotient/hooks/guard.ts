// Holds quotient's unattended agents to the rules in sandbox.ts: a daily run,
// and the subagent setup starts to check the operator's setup for fixes to
// teammates' frictions. Both read teammates' text, which is untrusted, so the
// model there may call only Read, Grep, Glob, ToolSearch, its own skill and its
// own Quotient tools, and read only where its job needs. A deny here holds
// over the operator's own allow rules. While setup or review-frictions
// runs, it also keeps every transcript out of reach but through quotient's
// digests, and refuses writing a file. Anywhere else this changes nothing.
// The same hook lets quotient's own mods reach Quotient (self-allow.ts), since
// a module may hold only one tool.check hook without a matcher.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { SandboxReach, TeammateTextMode } from '../types'
import { KINDS, OWN_TOOLS, TOOLS } from './daily'
import type { Kind } from './daily'
import {
  fullPath,
  globRoot,
  isGlobAllowed,
  isQuotientSkill,
  isQuotientTool,
  isReadAllowed,
  isSettingsFile,
  isSkippedProject,
  QUOTIENT_PREFIXES,
  safeRepos,
  TEAMMATE_TOOL_USE,
} from './sandbox'
import type { Scope } from './sandbox'
import { privateText } from './privacy'
import { SETUP_SHELL_COMMANDS } from './sessions'
import { REVIEW_SHAPE } from './review'
import { RUN_SHAPE } from './setup'
import { isOwnQuotientCall, ownCallVerdict } from './self-allow'
import { HIDES_FIXES, SHOWN_ALREADY } from './teammate-text'

// The agent type setup starts its teammate check as.
export const TEAMMATE_CHECK_AGENT = 'quotient:teammate-check'
const TEAMMATE_CHECK_TOOLS = ['list_teammate_frictions', 'submit_solutions', 'submit_solution']
// The Quotient tools whose text teammates read, found under any server's
// name, as self-allow.ts finds its own: an operator can run Quotient under
// a server they set up by hand.
const SEND_TOOLS = ['submit_friction', 'submit_solutions', 'submit_solution', 'submit_review']
const FIND_SOLUTIONS_SKILL = 'find-solutions'
// The subagent setup reviews each batch with. It can only read and build
// digests, so quotient allows the main agent's start of one during setup in
// place of Claude Code's default ask: in auto mode, another plugin's hook that
// rewrites an Agent call's input makes auto mode refuse it, and the model
// then writes the whole call out again.
const REVIEWER_AGENT = 'quotient:setup-reviewer'
// The tools every sandboxed agent may call; Read, Grep and Glob only where it may read.
const READ_TOOLS = ['Read', 'Grep', 'Glob']
// SubagentHandback is how a subagent hands its report back: a teammate
// check's is replaced before setup's session reads it (teammate-text.ts).
const ALWAYS = ['ToolSearch', 'SubagentHandback']
// How far back review-frictions looks for the repos its sessions worked in.
const REPO_DAYS = 14
const DENIED_TOOL = "quotient's sandbox: not one of this agent's tools"
const DENIED_READ = "quotient's sandbox: outside what this agent may read"
const DENIED_SETTINGS = "quotient's sandbox: search ~/.claude/settings.json with Grep for what you need, never read it whole"
// A background task's output file, or the folder that holds them, under
// Claude Code's temporary folder (`/tmp/claude-<uid>/…/tasks/<id>.output`).
const TASK_OUTPUT = /\/claude-\d+\/\S*\/tasks(\/|$|\b)|\/tasks\/[^/\s'"]+\.output\b/i
// The folders above a task's output, down to the session that holds it,
// matched ignoring case, as macOS's file system does.
const TASK_OUTPUT_ABOVE = /^(\/|\/private|\/tmp|\/private\/tmp)$|\/tmp\/claude-\d+(\/[^/]+){0,2}$/i
const DENIED_REPORT = "quotient: the teammate check's report is shown only as the answers it sent"
const DENIED_OUTSIDE = `quotient's sandbox: teammates' frictions are read only in a ${TEAMMATE_CHECK_AGENT} subagent`
const FAILED = "quotient's sandbox couldn't check this call, so it's denied"
const DENIED_TRANSCRIPT =
  "quotient: this session's transcript holds teammates' fixes, which review-frictions and setup never read: skip it"
// A Bash command that names the transcripts: a `.jsonl` file, or the config
// folder and then its projects folder. Matching a command's text is a best
// effort, so the skills read transcripts with Read and Grep instead.
const BASH_TRANSCRIPTS = /\.jsonl\b|(\.claude|CLAUDE_CONFIG_DIR)[\s\S]*\bprojects\b/i
// While setup or review-frictions runs, only the calls they make may run:
// none writes a file, and RemoteTrigger only reads routines and their runs.
const REMOTE_READS = ['list', 'get', 'list_runs', 'get_run_log']
// What setup and review-frictions use to ask the operator, wait on and stop
// their subagents, and answer: none writes a file, runs a shell, or reaches
// an agent or a later turn outside the lock, as SendMessage and
// ScheduleWakeup can.
const LOCKED_HARNESS_TOOLS = ['AskUserQuestion', 'ReadNotifications', 'StructuredOutput', 'TaskStop']
const LOCKED_SKILLS = ['setup', 'review-frictions', FIND_SOLUTIONS_SKILL]
// The Quotient tools, under either server, and quotient's own tools each skill calls.
const LOCKED_QUOTIENT_TOOLS = {
  setup: ['start_setup_run', 'list_teammate_frictions', 'record_setup_progress', 'submit_friction', 'finish_setup_run'],
  'review-frictions': ['list_my_frictions', 'submit_friction', 'submit_review', 'complete_daily_run'],
} as const
const LOCKED_OWN_TOOLS = {
  setup: ['mcp__quotient__setup_start', 'mcp__quotient__setup_digest', 'mcp__quotient__setup_summary'],
  'review-frictions': ['mcp__quotient__review_sessions', 'mcp__quotient__review_digest'],
} as const
const DENIED_LOCKED_TOOL = 'quotient: while setup or review-frictions runs, only the tools they use may run, and none of them writes a file'
const DENIED_LOCKED_TRANSCRIPT =
  "quotient: setup and review-frictions read sessions only through quotient's digests: setup_digest, or review_sessions and review_digest"
const DENIED_BASH_TRANSCRIPT =
  "quotient: some transcripts hold teammates' fixes, which review-frictions and setup never read: read transcripts with Read, one session at a time, or during setup through setup_digest"

// Where the sandboxed agent may read, looked up once per session: a daily
// run's own, or, in an operator's session, the config folder alone.
const reach = atom({ plugin: 'quotient', key: 'sandboxReach' } as const, null as SandboxReach | null, {
  shape: 'reach-1',
})
// The setup teammate-check subagents already found, so each is looked up once.
const agents = atom({ plugin: 'quotient', key: 'sandboxedAgents' } as const, [] as string[], { shape: 'agents-1' })
// Shared with teammate-text.ts, which declares it with the same key and sets it.
const mode = atom({ plugin: 'quotient', key: 'teammateTextMode' } as const, null as TeammateTextMode)
// Shared with teammate-text.ts: the Agent calls that started a teammate check.
const checkCalls = atom({ plugin: 'quotient', key: 'teammateCheckCalls' } as const, [] as string[], { shape: 'calls-1' })
// Shared with teammate-text.ts: the session a command last showed teammates' fixes in.
const shownIn = atom({ plugin: 'quotient', key: 'teammateTextShownIn' } as const, null as string | null)

/**
 * Runs a shell script with its arguments as `$1`, `$2`, …, so nothing passed
 * is ever read as shell.
 *
 * @param $ - The engine
 * @param script - The script
 * @param args - Its arguments
 * @returns Its output's lines, without empty ones
 * @throws When it can't run or exits non-zero
 */
async function lines($: EngineInterface, script: string, args: string[] = []): Promise<string[]> {
  const ran = await $.process.run(['sh', '-c', script, 'sh', ...args], { timeoutMs: 30_000 })
  if (ran.exitCode !== 0) throw new Error(`exit ${ran.exitCode}`)
  return ran.stdout.split('\n').filter(line => line !== '')
}

/**
 * Looks up where a sandboxed agent may read, each folder as its real path,
 * so a symbolic link can't lead a read somewhere else. With repos, they are
 * the git repos the last two weeks' sessions worked in, leaving out the
 * sessions of skipped project folders, kept as safeRepos says.
 *
 * @param $ - The engine
 * @param withRepos - Whether the agent reads repos too
 * @returns The reach
 * @throws When the folders can't be found
 */
async function lookUpReach($: EngineInterface, withRepos: boolean): Promise<SandboxReach> {
  const [config, home, runs] = await lines(
    $,
    'printf "%s\\n%s\\n%s\\n" "$(cd "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" && pwd -P)" "$(cd "$HOME" && pwd -P)" "${XDG_DATA_HOME:-$HOME/.local/share}/quotient"',
  )
  if (!config?.startsWith('/') || !home?.startsWith('/') || !runs?.startsWith('/')) throw new Error('no folders')
  const dirs = { config, home, runs }
  if (!withRepos) return { dirs, repos: [] }

  const transcripts = await lines($, `find "$1/projects" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime -${REPO_DAYS}`, [config])
  const kept = transcripts.filter(file => !isSkippedProject(file.split('/').at(-2) ?? '', dirs))
  if (kept.length === 0) return { dirs, repos: [] }
  const roots = await lines(
    $,
    `for f; do grep -m1 -o '"cwd":"[^"]*"' "$f" | sed 's/^"cwd":"//; s/"$//'; done | sort -u |
     while IFS= read -r d; do top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) && (cd "$top" && pwd -P); done | sort -u`,
    kept,
  )
  return { dirs, repos: safeRepos(roots, dirs) }
}

/**
 * Finds what a model call's agent may do, when it's sandboxed: in a daily
 * run, its kind's tools and reads; in setup's teammate-check subagent, the
 * check's tools and the config folder.
 *
 * @param $ - The engine
 * @param agentId - The subagent that made the call, absent for the main loop
 * @returns The scope, or null when the call isn't sandboxed
 */
async function scopeOf($: EngineInterface, agentId: string | undefined): Promise<Scope | null> {
  const kind = await $.env.get('QUOTIENT_DAILY_RUN_KIND')
  if (kind !== undefined) {
    // An unknown kind is still a daily run: it gets no tool at all.
    const known = (KINDS as readonly string[]).includes(kind) ? (kind as Kind) : null
    return {
      tools: known === null ? [] : TOOLS[known],
      ownTools: known === null ? [] : OWN_TOOLS[known],
      skills: known === null ? [] : [known],
      withRepos: known === 'review-frictions',
    }
  }
  if (agentId === undefined) return null
  const isCheck =
    (await read($, agents)).includes(agentId) ||
    (await $.agent.list()).some(agent => agent.id === agentId && agent.type === TEAMMATE_CHECK_AGENT)
  if (!isCheck) return null
  await update($, agents, ids => (ids.includes(agentId) ? ids : [...ids, agentId]))
  return { tools: TEAMMATE_CHECK_TOOLS, ownTools: [], skills: [FIND_SOLUTIONS_SKILL], withRepos: false }
}

/**
 * Says why a sandboxed agent's read is refused: Read and Grep by the real
 * path they reach, a Grep of a folder as reading everything in it, and Glob
 * by the folder it lists from. The user settings file may only be searched.
 *
 * @param $ - The engine
 * @param tool - Read, Grep or Glob
 * @param input - The call's input
 * @param where - Where the agent may read
 * @returns The reason, or null when the read is allowed
 */
async function readDenial($: EngineInterface, tool: string, input: Record<string, unknown>, where: SandboxReach): Promise<string | null> {
  const cwd = await $.session.cwd()
  const real = async (path: string) => $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (tool === 'Glob') {
    const root = globRoot(input, where.dirs, cwd)
    const stat = root === null ? undefined : await real(root)
    return stat?.realPath !== undefined && isGlobAllowed(stat.realPath, where, input.pattern) ? null : DENIED_READ
  }
  const full = fullPath(tool === 'Read' ? input.file_path : (input.path ?? cwd), where.dirs, cwd)
  const stat = full === null ? undefined : await real(full)
  if (stat?.realPath === undefined) return DENIED_READ
  // Through a link, the settings may live elsewhere, such as a dotfiles repo,
  // so both the path as written and the file the link leads to count.
  if (tool === 'Read' && full !== null) {
    if ([full, stat.realPath].some(path => isSettingsFile(path, where.dirs))) return DENIED_SETTINGS
    const settings = await real(`${where.dirs.config}/settings.json`)
    if (settings?.realPath !== undefined && settings.realPath === stat.realPath) return DENIED_SETTINGS
  }
  return isReadAllowed(stat.realPath, where, tool === 'Grep' && stat.kind !== 'file') ? null : DENIED_READ
}

/**
 * Says why a sandboxed agent's call is refused.
 *
 * @param $ - The engine
 * @param tool - The tool's full name
 * @param input - The call's input
 * @param scope - What the agent may do
 * @returns The reason, or null when the call is allowed
 */
async function denial(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  scope: Scope,
): Promise<string | null> {
  if (ALWAYS.includes(tool) || scope.ownTools.includes(tool)) return null
  if (tool === 'Skill') return isQuotientSkill(input.skill, scope.skills) ? null : DENIED_TOOL
  if (!READ_TOOLS.includes(tool)) return isQuotientTool(tool, scope.tools) ? null : DENIED_TOOL
  return readDenial($, tool, input, await reachFor($, scope.withRepos))
}

/**
 * Finds where this session's sandboxed agent may read. A session holds one
 * kind, so its reach is looked up once.
 *
 * @param $ - The engine
 * @param withRepos - Whether the agent reads repos too
 * @returns The reach
 * @throws When the folders can't be found
 */
async function reachFor($: EngineInterface, withRepos: boolean): Promise<SandboxReach> {
  const known = await read($, reach)
  if (known !== null) return known
  const found = await lookUpReach($, withRepos)
  await update($, reach, () => found)
  return found
}

/**
 * Says why a read of a transcript that holds teammates' fixes is refused: a
 * session that called `list_my_frictions` or `list_teammate_frictions`
 * carries their replies, which no review or setup may read. A transcript
 * that can't be checked is refused too.
 *
 * @param $ - The engine
 * @param tool - Read or Grep
 * @param input - The call's input
 * @param where - The config folder, among others
 * @returns The reason, or null when the read holds no teammate text
 */
async function transcriptDenial($: EngineInterface, tool: string, input: Record<string, unknown>, where: SandboxReach): Promise<string | null> {
  const cwd = await $.session.cwd()
  const full = fullPath(tool === 'Read' ? input.file_path : (input.path ?? cwd), where.dirs, cwd)
  const projects = `${where.dirs.config}/projects`
  const stat = full === null ? undefined : await $.fs.stat(full, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath
  // A path that can't be resolved but, as written, reaches the transcripts is refused.
  const isWritten = full !== null && (full.startsWith(`${projects}/`) || full === projects || projects.startsWith(`${full}/`))
  if (real === undefined) return isWritten ? DENIED_TRANSCRIPT : null
  // A Grep of the projects folder or a folder holding it reads every transcript.
  const holdsAll =
    tool === 'Grep' && real !== undefined && (real === projects || real === '/' || projects.startsWith(`${real}/`))
  const target = holdsAll ? projects : real?.startsWith(`${projects}/`) ? real : undefined
  if (target === undefined) return null
  const found = await $.process.run(['grep', '-rqE', '--', TEAMMATE_TOOL_USE, target], { timeoutMs: 30_000 })
  return found.exitCode === 1 ? null : DENIED_TRANSCRIPT
}

/**
 * Tells whether setup or review-frictions is running, when nothing but
 * quotient's digests may reach a transcript and nothing writes a file:
 * setup's run, a review the operator or the model started, or a daily
 * review-frictions run.
 *
 * @param $ - The engine
 * @returns Which skill is running, or null for neither
 */
async function lockedBy($: EngineInterface): Promise<'setup' | 'review-frictions' | null> {
  if ((await $.env.get('QUOTIENT_DAILY_RUN_KIND')) === 'review-frictions') return 'review-frictions'
  const setupRun = await read($, { plugin: 'quotient', key: 'setupRun' } as const)
  if (setupRun?.shape === RUN_SHAPE && setupRun.value.isRunning) return 'setup'
  const reviewRun = await read($, { plugin: 'quotient', key: 'reviewRun' } as const)
  return reviewRun?.shape === REVIEW_SHAPE && reviewRun.value.isRunning ? 'review-frictions' : null
}

/**
 * Says why a call is refused while setup or review-frictions runs: only the
 * tools they use may run: reads, the harness's tools for asking the operator
 * and stopping subagents, the skill's own Quotient and quotient tools, a
 * subagent in this checkout, quotient's own skills, and during setup,
 * RemoteTrigger's reads and setup's own shell commands.
 *
 * @param tool - The tool's full name
 * @param input - The call's input
 * @param skill - The running skill
 * @returns The reason, or null when the call may run
 */
function lockedToolDenial(tool: string, input: Record<string, unknown>, skill: 'setup' | 'review-frictions'): string | null {
  if ([...READ_TOOLS, ...ALWAYS, ...LOCKED_HARNESS_TOOLS].includes(tool)) return null
  if (isQuotientTool(tool, LOCKED_QUOTIENT_TOOLS[skill]) || (LOCKED_OWN_TOOLS[skill] as readonly string[]).includes(tool)) return null
  if (tool === 'Agent' && input.isolation === undefined) return null
  if (tool === 'Skill' && isQuotientSkill(input.skill, LOCKED_SKILLS, true)) return null
  if (skill !== 'setup') return DENIED_LOCKED_TOOL
  if (tool === 'RemoteTrigger' && REMOTE_READS.includes(String(input.action))) return null
  return tool === 'Bash' && typeof input.command === 'string' && SETUP_SHELL_COMMANDS.includes(input.command.trim()) ? null : DENIED_LOCKED_TOOL
}

/**
 * Says why a call is refused while the transcripts are locked, whatever
 * they hold: a Read of a transcript (`*.jsonl` under the projects folder),
 * a Grep or Glob of a folder that holds any, or a Bash command that names
 * them. A project's
 * auto-memory folder and other files under the projects folder, such as a
 * saved reply, stay readable. Paths compare ignoring case and Unicode form,
 * as macOS's file system does.
 *
 * @param $ - The engine
 * @param tool - The tool's full name
 * @param input - The call's input
 * @param reach - Looks up the config folder, among others, for a call that can name a path
 * @returns The reason, or null when the call reaches no transcript
 */
async function lockedTranscriptDenial(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  reach: () => Promise<SandboxReach>,
): Promise<string | null> {
  if (tool !== 'Bash' && !READ_TOOLS.includes(tool)) return null
  const where = await reach()
  const form = (path: string) => path.normalize('NFC').toLowerCase()
  // The projects folder as written and, when it's a link, where it leads.
  const projectsAsWritten = `${where.dirs.config}/projects`
  const linked = (await $.fs.stat(projectsAsWritten, { resolve: true }).catch(() => undefined))?.realPath
  const roots = [...new Set([projectsAsWritten, linked ?? projectsAsWritten].map(form))]
  if (tool === 'Bash') {
    const named = typeof input.command === 'string' ? form(input.command) : ''
    return BASH_TRANSCRIPTS.test(named) || roots.some(root => named.includes(root)) ? DENIED_LOCKED_TRANSCRIPT : null
  }
  const cwd = await $.session.cwd()
  const written = tool === 'Glob' ? globRoot(input, where.dirs, cwd) : fullPath(tool === 'Read' ? input.file_path : (input.path ?? cwd), where.dirs, cwd)
  // A path that can't be placed, such as one with `..`, could reach the transcripts.
  if (written === null) return DENIED_LOCKED_TRANSCRIPT
  const stat = await $.fs.stat(written, { resolve: true }).catch(() => undefined)
  const paths = [written, stat?.realPath ?? written].map(form)
  const isTranscript = (path: string) => roots.some(root => path.startsWith(`${root}/`)) && path.endsWith('.jsonl')
  if (paths.some(isTranscript)) return DENIED_LOCKED_TRANSCRIPT
  if (tool === 'Read' || stat?.kind === 'file') return null
  // A search of a folder reads every transcript under it, outside a project's auto-memory.
  const isMemory = (path: string, root: string) => path.startsWith(`${root}/`) && /^[^/]+\/memory(\/|$)/.test(path.slice(root.length + 1))
  const holds = (path: string, root: string) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path === '/' ? '' : path}/`)
  return paths.some(path => roots.some(root => holds(path, root) && !isMemory(path, root))) ? DENIED_LOCKED_TRANSCRIPT : null
}

/**
 * Tells whether a tool belongs to another MCP server than Quotient's or
 * quotient's mod. Such a tool, like a sandbox that runs code on a file, can
 * read any transcript its input names, and quotient can't see what it reads.
 *
 * @param tool - The tool's full name
 * @returns Whether it's another server's
 */
function isOtherServer(tool: string): boolean {
  return tool.startsWith('mcp__') && !tool.startsWith('mcp__quotient__') && !QUOTIENT_PREFIXES.some(prefix => tool.startsWith(prefix))
}

/**
 * Says why a Bash command, or another server's call, that names the
 * transcripts is refused while they're held: one of them holds teammates'
 * fixes, and a command can reach any of them. When none holds such text,
 * the call goes on.
 *
 * @param $ - The engine
 * @param command - The Bash command, or the other server's call's input as JSON
 * @param where - The config folder, among others
 * @returns The reason, or null when the command names no transcript or none holds teammate text
 */
async function bashTranscriptDenial($: EngineInterface, command: unknown, where: SandboxReach): Promise<string | null> {
  const projects = `${where.dirs.config}/projects`
  if (typeof command !== 'string' || !(BASH_TRANSCRIPTS.test(command) || command.includes(projects))) return null
  const found = await $.process.run(['grep', '-rqE', '--', TEAMMATE_TOOL_USE, projects], { timeoutMs: 30_000 })
  return found.exitCode === 1 ? null : DENIED_BASH_TRANSCRIPT
}

/**
 * Tells whether a call reaches a background task's output: a Bash command
 * naming one, or a Read, Grep or Glob whose real path is an output file or
 * the folder that holds them.
 *
 * @param $ - The engine
 * @param tool - The tool's full name
 * @param input - The call's input
 * @returns Whether it reaches a task's output
 */
async function namesTaskOutput($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<boolean> {
  if (tool === 'Bash') return typeof input.command === 'string' && TASK_OUTPUT.test(input.command)
  if (!READ_TOOLS.includes(tool)) return false
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? '/'
  const dirs = { config: '', home, runs: '' }
  const path = tool === 'Glob' ? globRoot(input, dirs, cwd) : fullPath(tool === 'Read' ? input.file_path : (input.path ?? cwd), dirs, cwd)
  // A path or pattern that can't be placed, such as one with `..`, could reach the outputs.
  if (path === null) return true
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (TASK_OUTPUT.test(path) || (tool === 'Glob' && TASK_OUTPUT.test(pattern))) return true
  const real = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath ?? path
  if (TASK_OUTPUT.test(real)) return true
  // A search from a folder above the outputs reaches them too.
  return tool !== 'Read' && TASK_OUTPUT_ABOVE.test(real)
}

/**
 * Tells whether the model's reads of transcripts are held back from
 * teammates' fixes: in a daily review-frictions run, and in an operator's
 * session once review-frictions or setup has started, until fix-friction or
 * list-fixes does. A find-solutions run and setup's teammate check read
 * teammates' text by design, and send it only back to teammates.
 *
 * @param $ - The engine
 * @param scope - The sandboxed agent's scope, or null for an operator's session
 * @returns Whether to check transcripts for teammates' fixes
 */
async function holdsTranscripts($: EngineInterface, scope: Scope | null): Promise<boolean> {
  return scope === null ? (await read($, mode)) === 'hides' : scope.withRepos
}

/**
 * Tells whether a call would put teammates' frictions in front of the model:
 * the find-solutions skill, or the teammate check's own Quotient tools.
 *
 * @param tool - The tool's full name
 * @param input - The call's input
 * @returns Whether it reads or answers teammates' frictions
 */
function isTeammateCall(tool: string, input: Record<string, unknown>): boolean {
  return isQuotientTool(tool, TEAMMATE_CHECK_TOOLS) || (tool === 'Skill' && isQuotientSkill(input.skill, [FIND_SOLUTIONS_SKILL], true))
}

/**
 * Tells whether a call sends Quotient text teammates read, under any server.
 *
 * @param tool - The tool's full name, as `mcp__<server>__<tool>`
 * @returns Whether it's one of the send tools
 */
function isSendTool(tool: string): boolean {
  return tool.startsWith('mcp__') && SEND_TOOLS.some(name => tool.endsWith(`__${name}`))
}

/**
 * Refuses a send to Quotient whose text teammates mustn't see, naming the
 * field and what it holds, never the text itself.
 *
 * @param $ - The engine
 * @param tool - The tool's full name
 * @param input - The call's input
 * @returns The refusal's reason, or null when the call isn't a send or its text is clean
 * @throws When the home folder can't be read
 */
async function privateTextDenial($: EngineInterface, tool: string, input: Record<string, unknown>): Promise<string | null> {
  if (!isSendTool(tool)) return null
  const found = privateText(input, (await $.env.get('HOME')) ?? '/')
  return found === null
    ? null
    : `quotient: \`${found.field}\` holds ${found.kind}, which teammates would read. Rewrite that field without it and send the call again.`
}

/**
 * Adds the module's permission check: it allows quotient's own calls to
 * Quotient in place of Claude Code's default ask, and holds quotient's
 * unattended agents to their tools and reads. A subagent of any other type
 * may not reach teammates' frictions at all, so the sandbox never depends on
 * which type the model chose to start.
 *
 * @param on - Adds the module's hooks
 */
export function registerGuard(on: On): void {
  on('tool.check', async ($, e, next) => {
    if (isOwnQuotientCall(next.origin.plugin, e.tool)) return ownCallVerdict(await next(e))
    if (next.origin.plugin !== 'engine') return next(e)
    const input = (e.input ?? {}) as Record<string, unknown>
    const leak = await privateTextDenial($, e.tool, input)
    if (leak !== null) return { decision: 'deny', reason: leak }
    const scope = await scopeOf($, e.agentId)
    if (scope === null && e.agentId !== undefined && isTeammateCall(e.tool, input)) {
      return { decision: 'deny', reason: DENIED_OUTSIDE }
    }
    // The teammate check's output or the check itself, by its task or call
    // id, so it can't be read or continued, and while
    // transcripts are held back, any background task's output: only quotient
    // reads them, for setup's session and its other subagents alike.
    if (scope === null) {
      // The conversation already holds teammates' fixes, and filtering can't take them back.
      const shown = e.tool === 'Skill' && isQuotientSkill(input.skill, HIDES_FIXES, true) ? await read($, shownIn) : null
      if (shown !== null && shown === (await $.session.id())) {
        return { decision: 'deny', reason: SHOWN_ALREADY }
      }
      const named = JSON.stringify(input)
      const ids = [...(await read($, checkCalls)), ...(await read($, agents))]
      if (ids.some(id => named.includes(id))) return { decision: 'deny', reason: DENIED_REPORT }
      if ((await read($, mode)) === 'hides' && (await namesTaskOutput($, e.tool, input))) {
        return { decision: 'deny', reason: DENIED_REPORT }
      }
    }
    const isHeld = (['Read', 'Grep', 'Bash'].includes(e.tool) || isOtherServer(e.tool)) && (await holdsTranscripts($, scope))
    const where = async (): Promise<SandboxReach> => reachFor($, scope?.withRepos ?? false)
    // setup's teammate check searches the operator's sessions by design; it can't write or run a shell.
    const locked = scope?.tools === TEAMMATE_CHECK_TOOLS ? null : await lockedBy($)
    const reason =
      (scope === null ? null : await denial($, e.tool, input, scope)) ??
      (locked === null ? null : (await lockedTranscriptDenial($, e.tool, input, where)) ?? lockedToolDenial(e.tool, input, locked)) ??
      (!isHeld
        ? null
        : e.tool === 'Bash' || isOtherServer(e.tool)
          ? await bashTranscriptDenial($, e.tool === 'Bash' ? input.command : JSON.stringify(input), await where())
          : await transcriptDenial($, e.tool, input, await where()))
    if (reason !== null) return { decision: 'deny', reason }
    const isReviewerStart = scope === null && e.agentId === undefined && e.tool === 'Agent' && input.subagent_type === REVIEWER_AGENT
    const setupRun = isReviewerStart ? await read($, { plugin: 'quotient', key: 'setupRun' } as const) : undefined
    if (setupRun?.shape === RUN_SHAPE && setupRun.value.isRunning) return ownCallVerdict(await next(e), "quotient's own setup reviewer")
    return next(e)
  }).catch(async ($, e, next) => {
    // A failed check denies only the model's calls where the sandbox holds,
    // or where it can't tell whether it does; and a Read, a Grep, or a Bash
    // command or another server's call naming transcripts once a review or setup holds transcripts
    // back, or when that can't be told either.
    if (next.origin.plugin !== 'engine') return next(e)
    if (isSendTool(e.tool)) return { decision: 'deny', reason: FAILED }
    const input = (e.input ?? {}) as Record<string, unknown>
    // While setup or a review runs, or when that can't be told, a read whose
    // check failed and any call outside their tools is refused.
    const locked = await lockedBy($).catch(() => 'review-frictions' as const)
    if (locked !== null && (READ_TOOLS.includes(e.tool) || lockedToolDenial(e.tool, input, locked) !== null)) {
      return { decision: 'deny', reason: FAILED }
    }
    const isTranscriptRead =
      e.tool === 'Read' ||
      e.tool === 'Grep' ||
      (e.tool === 'Bash' && typeof input.command === 'string' && BASH_TRANSCRIPTS.test(input.command)) ||
      (isOtherServer(e.tool) && BASH_TRANSCRIPTS.test(JSON.stringify(input)))
    if (isTranscriptRead && (await read($, mode).catch(() => 'hides' as const)) === 'hides') {
      return { decision: 'deny', reason: FAILED }
    }
    if (e.agentId !== undefined && isTeammateCall(e.tool, input)) {
      return { decision: 'deny', reason: FAILED }
    }
    const scope = await scopeOf($, e.agentId).catch(() => 'unknown' as const)
    return scope === null ? next(e) : { decision: 'deny', reason: FAILED }
  })
}
