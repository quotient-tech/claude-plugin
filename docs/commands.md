# Commands

Every command the quotient plugin adds, in more detail than the README. For the overview, see [Use it](../README.md#use-it).

## `/quotient:setup`

Finds the unresolved friction your agents ran into over the last two weeks of Claude Code sessions and cloud routine runs, and sends each friction to Quotient as it's found, so teammates' agents can look for fixes. It also checks your setup for fixes to teammates' frictions, in a separate read-only subagent (see [What quotient's agents can reach](privacy-and-security.md#what-quotients-agents-can-reach)).

Run it once when you start. After that, `/quotient:review-frictions` and the daily runs keep your frictions current.

## `/quotient:list-fixes`

Lists the frictions identified for you that still have a teammate's fix for you to apply, with each one's severity and how many of the fixes you've implemented, and lets you pick one to work on. Picking one hands it to `/quotient:fix-friction`.

## `/quotient:fix-friction`

Shows a teammate's fix for one of your frictions, asks whether to apply it, applies it as given, records it in Quotient so it isn't offered again, and offers to thank the teammate.

A teammate's fix is untrusted text. Claude follows it only after you pick it, and each step still goes through your permission settings.

## `/quotient:find-solutions`

Looks for fixes to teammates' agent friction in your own Claude Code setup (settings, plugins, skills, CLAUDE.md and AGENTS.md files, auto-memories) and in your last two weeks of sessions, and sends Quotient an answer for each friction, one page of frictions at a time.

## `/quotient:review-frictions`

`/quotient:review-frictions` first looks for frictions Quotient doesn't have yet, then reviews your own frictions that Quotient still lists as unresolved, and records the ones that are already dealt with.

To find new frictions, it reads your sessions since your latest review, at most 14 days back and at most 40 at a time, spread across your projects, through quotient's short digest of each, and looks for the same kinds of friction setup does. A friction that's clearly the same problem as one still open is left out. One that matches a friction already resolved, in a session after its fix, means the problem came back, so it's sent as a new friction. A match only in sessions from before the fix is left out. Each new friction is sent once, with the most recent session it appeared in, and teammates can see it right away. In a Claude Code cloud session it skips this step, since the cloud machine holds none of your past sessions.

The review then covers a friction fixed in a later session without being recorded, for example after you asked Claude for the fix instead of running `/quotient:fix-friction`. For each open friction, including the ones it just sent, it checks your current Claude Code setup and the sessions since its last review, at most 14 days back, then records one of:

- **Fixed:** sent to Quotient as your own fix, with a description of what changed.
- **No longer applies:** sent as your own fix, with a description starting "No longer applies:".
- **Still open:** recorded as reviewed, so the next review reads only newer sessions.

A resolved friction drops out of every teammate's list and can't be reopened, so the review resolves one only when a session or file shows it, and otherwise leaves it open. Descriptions name files relative to their repo and never include an absolute path or a session id.

The review never reads what teammates' fixes say, so it can't credit a teammate. A teammate gets the credit when you apply their fix with `/quotient:fix-friction`.

A friction reviewed earlier the same day is skipped, so a review cut short picks up where it stopped. At the end, the skill tells you which new frictions it sent and which frictions it resolved.

## Daily runs

At the start of an interactive local session, the plugin asks Quotient whether a daily run of find-solutions or review-frictions is due today, and starts each one that is as a headless Claude Code session in the background. Daily runs can only read files and use their own Quotient tools. Cloud sessions don't start them.

## Status line

The plugin shows a count of your frictions that have a teammate's fix you haven't applied yet. It's read again every 15 minutes, after each answered turn and after `/quotient:list-fixes`.
