// What quotient's unattended agents may reach: the daily runs and setup's
// teammate check read teammates' text, which is untrusted, so a planted
// instruction must find nothing worth sending. These pure rules say which
// tools such an agent may call and which paths it may read; guard.ts
// enforces them.
import type { SandboxReach } from '../types'

// The parts of the Claude Code config folder setup and find-solutions read:
// transcripts and memories, the operator's plugins, skills, agents and
// commands, and their user-level steering and settings. A read anywhere else
// there, such as Claude Code's sign-in tokens, isn't one of them.
export const CONFIG_FOLDERS = ['projects', 'plugins', 'skills', 'agents', 'commands']
export const CONFIG_FILES = ['CLAUDE.md', 'AGENTS.md', 'settings.json']
// The operator's user settings, which a sandboxed agent searches with Grep
// and never reads whole: the file can be long, and most of it, such as the
// `env` block, has nothing to do with a friction.
const SETTINGS_FILE = 'settings.json'
// Project folders under `projects/` whose transcripts aren't real work: a
// session run from a temporary folder, such as an agent's throwaway probe,
// which can hold deliberately hostile text. The skills name the same folders.
// Names are matched ignoring case, since macOS's file system does.
export const SKIPPED_PROJECT = /^-(private-tmp|tmp|var-folders|private-var-folders)-/i
// The plugin's own Quotient server, and the connector a cloud session reaches it through.
export const QUOTIENT_PREFIXES = ['mcp__plugin_quotient_agex__', 'mcp__claude_ai_Quotient__']
// A transcript's record of a call that returned teammates' text, under any
// server's name, as an extended regular expression for grep. A session that
// only mentions these tools has its quotes escaped inside a string, so it
// doesn't match.
export const TEAMMATE_TOOL_USE = '"name":"mcp__[^"]*__list_(my|teammate)_frictions"'
// Folders and files in a repo that hold credentials rather than evidence,
// matched ignoring case.
const SECRET_FOLDERS = ['.ssh', '.aws', '.gnupg', '.git', '.docker']
const SECRET_FILES = [
  /^\.env(rc|\..*)?$/i,
  /^\.dev\.vars$/i,
  /\.tfvars(\.json)?$|\.tfstate(\.backup)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /^\.?credentials/i,
]
// Claude Code's local settings, which name a secret pattern doesn't match
// but which steer the agent: read as evidence.
const STEERING_FILE = 'settings.local.json'

/** The operator's Claude Code config folder, home folder, and quotient's daily-run folder. */
export type Dirs = SandboxReach['dirs']

/** Everywhere a sandboxed agent may read: the config folder's safe parts, and repos. */
export type Reach = { dirs: Dirs; repos: readonly string[] }

/** What one sandboxed agent may do: which Quotient tools and skills it calls, and whether it reads repos. */
export type Scope = { tools: readonly string[]; skills: readonly string[]; withRepos: boolean }

/**
 * Names the project folder Claude Code keeps a session's transcripts in.
 *
 * @param cwd - The session's working directory
 * @returns The folder's name under `projects/`
 */
export function projectFolder(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

/**
 * Turns a path a tool call names into an absolute one, refusing any `..`
 * that could climb out of where it seems to point.
 *
 * @param path - The path as the call names it
 * @param dirs - The home folder, for `~`
 * @param cwd - The session's working directory, for a relative path
 * @returns The absolute path without `.` segments or a trailing `/`, or null
 */
export function fullPath(path: unknown, dirs: Dirs, cwd: string): string | null {
  if (typeof path !== 'string' || path === '') return null
  const expanded = path === '~' ? dirs.home : path.startsWith('~/') ? `${dirs.home}${path.slice(1)}` : path
  const absolute = expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`
  const segments = absolute.split('/').filter(one => one !== '' && one !== '.')
  if (segments.includes('..')) return null
  return `/${segments.join('/')}`
}

/**
 * Splits a path into its segments under a folder.
 *
 * @param full - An absolute path from fullPath
 * @param root - The folder
 * @returns The segments under it, empty for the folder itself, or null outside it
 */
function under(full: string, root: string): string[] | null {
  if (full === root) return []
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1).split('/') : null
}

/**
 * Tells whether a path is in the config folder's safe parts, leaving out the
 * transcripts of quotient's own daily runs and of sessions run from a
 * temporary folder.
 *
 * @param full - An absolute path from fullPath
 * @param dirs - The config, home and daily-run folders
 * @param isWhole - Whether everything under the path is read, as a Grep of a folder does
 * @returns Whether a sandboxed agent may read it
 */
export function isConfigPath(full: string, dirs: Dirs, isWhole: boolean): boolean {
  const rest = under(full, dirs.config)
  const [first, project] = rest ?? []
  if (first === undefined) return false
  if (rest?.length === 1) return CONFIG_FILES.includes(first) || (CONFIG_FOLDERS.includes(first) && !(isWhole && first === 'projects'))
  if (!CONFIG_FOLDERS.includes(first)) return false
  return first !== 'projects' || project === undefined || !isSkippedProject(project, dirs)
}

/**
 * Tells whether a project folder's transcripts are left out of every review.
 *
 * @param project - The folder's name under `projects/`
 * @param dirs - The daily-run folder
 * @returns Whether it belongs to quotient's daily runs or a temporary folder
 */
export function isSkippedProject(project: string, dirs: Dirs): boolean {
  return SKIPPED_PROJECT.test(project) || project.toLowerCase() === projectFolder(dirs.runs).toLowerCase()
}

/**
 * Tells whether a path is the operator's user settings file.
 *
 * @param full - An absolute path from fullPath, or its real path
 * @param dirs - The config folder
 * @returns Whether it's the settings file at the config folder's top level
 */
export function isSettingsFile(full: string, dirs: Dirs): boolean {
  return full === `${dirs.config}/${SETTINGS_FILE}`
}

/**
 * Tells whether a path in a repo holds credentials rather than evidence,
 * ignoring case. The secret patterns apply in a `.claude` or `.agents`
 * folder too, so their steering stays readable but a key put there doesn't.
 *
 * @param segments - The path's segments under the repo
 * @returns Whether a sandboxed agent must not read it
 */
export function isSecretPath(segments: readonly string[]): boolean {
  const lower = segments.map(one => one.toLowerCase())
  const name = lower.at(-1) ?? ''
  if (name === STEERING_FILE) return false
  return lower.some(one => SECRET_FOLDERS.includes(one)) || SECRET_FILES.some(pattern => pattern.test(name))
}

/**
 * Tells whether a sandboxed agent may read a path.
 *
 * @param full - An absolute path from fullPath
 * @param reach - Where it may read
 * @param isWhole - Whether everything under the path is read, as a Grep of a
 *   folder does; in a repo only a single file may be, so no secret is read
 *   with it
 * @returns Whether the read is allowed. Inside the config folder only its own
 *   rule decides, even when a repo holds the config folder.
 */
export function isReadAllowed(full: string, reach: Reach, isWhole: boolean): boolean {
  if (under(full, reach.dirs.config) !== null) return isConfigPath(full, reach.dirs, isWhole)
  if (isWhole) return false
  return reach.repos.some(repo => {
    const segments = under(full, repo)
    return segments !== null && segments.length > 0 && !isSecretPath(segments)
  })
}

/**
 * Finds the folder a Glob call lists from: an absolute pattern's part before
 * its first wildcard, else its `path` or the working directory, with a
 * pattern that can't climb out of it. Any `..` refuses the pattern, even
 * inside a brace group such as `{..,a}`.
 *
 * @param input - The Glob call's input
 * @param dirs - The home folder, for `~`
 * @param cwd - The session's working directory
 * @returns The folder, or null when the pattern could reach outside it
 */
export function globRoot(input: Record<string, unknown>, dirs: Dirs, cwd: string): string | null {
  const { pattern, path } = input
  if (typeof pattern !== 'string' || pattern.includes('..')) return null
  if (/^[/~]/.test(pattern)) {
    const fixed = pattern.split('/')
    const wild = fixed.findIndex(one => /[*?[{]/.test(one))
    return fullPath(wild === -1 ? pattern : fixed.slice(0, wild).join('/') || '/', dirs, cwd)
  }
  return fullPath(path ?? cwd, dirs, cwd)
}

/**
 * Tells whether a Glob, which lists names and reads no file, stays where a
 * sandboxed agent may look: inside the config folder's safe parts or a repo.
 *
 * @param root - The folder from globRoot
 * @param reach - Where the agent may read
 * @param pattern - The Glob's pattern: at the config folder itself, only one
 *   that lists its top level, never into a folder left out
 * @returns Whether the Glob is allowed
 */
export function isGlobAllowed(root: string, reach: Reach, pattern?: unknown): boolean {
  if (root === reach.dirs.config) return typeof pattern === 'string' && !pattern.includes('/') && !pattern.includes('**')
  if (under(root, reach.dirs.config) !== null) return isConfigPath(root, reach.dirs, false)
  return reach.repos.some(repo => under(root, repo) !== null)
}

/**
 * Keeps the repo roots a sandboxed agent may read in: never the root folder,
 * the home folder or one above it, or a repo that holds the config folder.
 *
 * @param roots - The git repos' real paths
 * @param dirs - The config and home folders
 * @returns The roots that are safe to read in
 */
export function safeRepos(roots: readonly string[], dirs: Dirs): string[] {
  return roots.filter(
    root =>
      root.startsWith('/') &&
      root !== '/' &&
      !`${dirs.home}/`.startsWith(`${root}/`) &&
      !`${dirs.config}/`.startsWith(`${root}/`),
  )
}

/**
 * Tells whether a Skill call names one of quotient's skills, in any case and
 * with or without a leading `/`. To allow a call it must name the skill with
 * its `quotient:` namespace; to refuse one, a bare name counts too, so a look-alike
 * spelling never slips past.
 *
 * @param skill - The Skill call's `skill`
 * @param names - The skills' own names, such as `find-solutions`
 * @param isLoose - Whether a name without the namespace counts, as it should for a refusal
 * @returns Whether it names one of them
 */
export function isQuotientSkill(skill: unknown, names: readonly string[], isLoose = false): boolean {
  if (typeof skill !== 'string') return false
  const name = skill.trim().replace(/^\//, '').toLowerCase()
  if (name.startsWith('quotient:')) return names.includes(name.slice('quotient:'.length))
  return isLoose && names.includes(name)
}

/**
 * Tells whether a tool is one of the Quotient tools a sandboxed agent may call,
 * under the plugin's server or the connector.
 *
 * @param tool - The tool's full name
 * @param names - The Quotient tools' own names
 * @returns Whether it's one of them
 */
export function isQuotientTool(tool: string, names: readonly string[]): boolean {
  return QUOTIENT_PREFIXES.some(prefix => names.some(name => tool === `${prefix}${name}`))
}
