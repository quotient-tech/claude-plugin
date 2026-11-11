// The pure parts of listing and reading the operator's transcripts, which
// setup and review-frictions share. Claude Code reads a hooks file's `$`
// calls file by file, so each file runs its own commands with these.

// Prints each transcript whose first prompt typed one of quotient's own
// skills: a review of it would find problems with quotient itself, which
// aren't the operator's frictions to share. It stops reading each file at
// that prompt, which isn't a meta message such as a command's caveat. A typed
// command's prompt starts with its command tags, as Claude Code records it,
// so a prompt that only quotes one doesn't count.
export const QUOTIENT_STARTED = String.raw`/"type": ?"user"/ && !/"isMeta": ?true/ { if (/"content": ?"<command-(name>\/|message>)quotient:/) print FILENAME; nextfile }`
// How many lines one read of a transcript asks for. Output stops at 4 MiB,
// so a range that runs past it is halved until it fits.
export const LINES_PER_READ = 500

/**
 * Which transcripts to list, by when they were last modified: the last
 * `days`, or a pinned window's days, each a plain `YYYY-MM-DD`, the only
 * kind of time every `find` reads alike.
 */
export type SessionWindow = { days: number } | { start: string; end: string }

/** Whether a transcript holds teammates' fixes, by grep's exit code. */
export type HeldVerdict = 'holds' | 'clean' | 'unchecked'

/**
 * Builds the `find` command that lists the transcripts in a window.
 *
 * @param projects - The config folder's projects folder
 * @param window - Which transcripts to list
 * @returns The command and its arguments
 */
export function transcriptFindArgs(projects: string, window: SessionWindow): string[] {
  const changed =
    'start' in window
      ? ['-newermt', window.start, '!', '-newermt', window.end]
      : ['-mtime', `-${window.days}`]
  return ['find', projects, '-mindepth', '2', '-maxdepth', '2', '-type', 'f', '-name', '*.jsonl', ...changed]
}

/**
 * Tells whether lines read from a transcript hold a call that returned
 * teammates' fixes. A session still running can gain one after a check of
 * the file, so a digest checks the very lines it was built from. A line too
 * large to read shows only its size, so it can't leak one.
 *
 * @param lines - The lines read, their text null when too large to read
 * @param pattern - Such a call, as `TEAMMATE_TOOL_USE` in sandbox.ts gives it
 * @returns Whether any holds such a call
 */
export function holdsTeammateText(lines: readonly { text: string | null }[], pattern: string): boolean {
  const call = new RegExp(pattern)
  return lines.some(line => line.text !== null && call.test(line.text))
}

/**
 * Reads what a `grep -q` for teammates' fixes found in a transcript.
 *
 * @param exitCode - grep's exit code, or undefined when it couldn't run
 * @returns Whether the transcript holds them, or that it couldn't be checked
 */
export function heldVerdict(exitCode: number | undefined): HeldVerdict {
  if (exitCode === 0) return 'holds'
  return exitCode === 1 ? 'clean' : 'unchecked'
}
