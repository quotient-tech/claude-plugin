---
name: setup
description: Find the unresolved friction your agents ran into over the last two weeks of Claude Code sessions and cloud routine runs, and send each batch's frictions to Quotient as soon as it's reviewed, so teammates' agents can look for fixes.
disable-model-invocation: true
allowed-tools: mcp__plugin_quotient_agex__start_setup_run, mcp__claude_ai_Quotient__start_setup_run, mcp__plugin_quotient_agex__record_setup_progress, mcp__claude_ai_Quotient__record_setup_progress, mcp__plugin_quotient_agex__submit_frictions, mcp__claude_ai_Quotient__submit_frictions, mcp__plugin_quotient_agex__finish_setup_run, mcp__claude_ai_Quotient__finish_setup_run, mcp__plugin_quotient_agex__list_teammate_frictions, mcp__claude_ai_Quotient__list_teammate_frictions, Skill(quotient:find-solutions), mcp__quotient__setup_start, mcp__quotient__setup_digest, mcp__quotient__setup_summary, Bash(echo "cloud session: ${CLAUDE_CODE_REMOTE-false}"), Bash(git remote get-url origin)
---

## Setup run

If you don't have quotient's `mcp__quotient__setup_start` tool, the quotient plugin's hooks module didn't load, and nothing would keep teammates' fixes out of the review. Say exactly this and stop, calling nothing else:

  > Setup needs the quotient plugin's hooks module, which keeps teammates' fixes out of the review, and this session didn't load it.
  > Update Claude Code, start a new session, and run `/quotient:setup` again.

Otherwise, before anything else, call `start_setup_run`. Use Quotient's tools from one server for the whole skill: the `mcp__plugin_quotient_agex__` tools when you have them, and the `mcp__claude_ai_Quotient__` tools only when you don't.

- If you have neither, you aren't signed in to Quotient. Say exactly this and stop, calling nothing else:

  > You're not signed in to Quotient.
  > - In Claude Code on your computer: run `/mcp`, select `plugin:quotient:agex`, and sign in.
  > - In a Claude Code cloud session: connect the Quotient connector at claude.ai/customize/connectors.
  >
  > Then try again.
- If any of these tools returns an error, show its text exactly apart from any id, and stop: don't explain it, retry, or look for the cause. Running `/quotient:setup` again resumes this run without reviewing a recorded source again. The one exception is the `submit_frictions` error the Friction section describes.
- While its `nextCursor` isn't null, call it again with `cursor` set to that value, for the rest of `reportedFrictions`.

Its reply starts a new run or resumes one that was cut short, on any machine. It gives the run's `runId`, its `startedAt`, the sessions and routine runs already reviewed in it (`reviewedSources`), the frictions already submitted in it (`frictionsInRun`), and the frictions you have already reported to Quotient outside it (`reportedFrictions`).

!`echo "cloud session: ${CLAUDE_CODE_REMOTE-false}"`

## Teammates' frictions
In a cloud session, skip this section: setup checks only your own sessions there.

Otherwise, right after `start_setup_run`, call `list_teammate_frictions` once, with no `cursor`. When quotient's hooks are loaded its reply is only `hasFrictions`, so this session never reads teammates' frictions. If `hasFrictions` is true, or its `frictions` aren't empty, your teammates have frictions you haven't answered, and this setup also checks your setup for fixes to them. If it returns an error, carry on as if it returned none. Never stop setup because of this check.

When this setup checks your setup for fixes, start one subagent with the Agent tool before reviewing the first batch, with `subagent_type: "quotient:teammate-check"` and this prompt:

> Check my setup for fixes to my teammates' frictions.

Only that agent type may read teammates' frictions, and it can read nothing but your Claude Code config folder. Review the sessions while it works. Wait for it to finish before the summary. It reports only how many answers it sent with a fix and how many without: quotient shows each answer as it's sent, and builds the summary's cards from them. If it fails, carry on: it found no fixes.

## Goal
Find me any unresolved frictions or room for improvement the agent experienced across all sessions over the two weeks before the run's `startedAt`.

Include local Claude Code sessions and automated runs (transcripts under `~/.claude/projects/`; an automated run is one started by a script or the Agent SDK) and cloud routine runs (scheduled remote agents). In a cloud session, the local sessions are only this session: review it and the cloud routine runs.

quotient's `setup_start` tool counts the local sessions and automated runs itself, and its reply says how many. It also lists them, so don't list, count or search the transcripts before calling `setup_start`. If its reply doesn't say, count them yourself: the `.jsonl` transcripts in the folders under `~/.claude/projects/` changed in the last two weeks, leaving out the sessions listed below. The automated runs are the ones that hold `"entrypoint":"sdk-`, and the sessions are the rest.

Skip these sessions under `~/.claude/projects/`:
- the ones whose first prompt starts with `/quotient:`: they ran one of quotient's own skills, such as setup or a daily background run, and a problem with quotient itself isn't a friction to share with teammates;
- every session in a project folder whose name starts with `-private-tmp-`, `-tmp-`, `-var-folders-` or `-private-var-folders-`: those ran from a temporary folder, such as an agent's throwaway test, and aren't real work.

Read or search one project folder at a time, never `~/.claude/projects/` as a whole. When quotient refuses a transcript because it holds teammates' fixes, skip that session.

## Agent Experiences
Check for the following categories for friction or room for improvement in the agent's experience:

- **Navigation**: how easy was it for the agent to find the right files? Are there hidden dependencies between files? Would a **navigation pointer** make it easier? _Use when_ the session took a long time to find a piece of information.
- **Automated checks**: are there automated checks that could catch errors the agent made? Linting, typing, tests, filesystem linters? Read the repo's own check command first (its `package.json`/build-tool `lint`/`check` scripts, its CI workflow), so a check that already exists but sits unwired or silently broken is the finding, not a reinvention. A repo with no **guardrail** (no pre-commit hook and no CI job running its lint/typecheck/test command) is itself a finding: an un-linted repo is a standing missed opportunity, not a neutral default. _Use when_ the agent made a mistake an automated check could have caught, or the repo has no guardrail at all.
- **Coding standards**: should the **reviewer agent** be given a new rule to enforce? Should an existing rule be removed or clarified? Classify the violation: 
  - **mechanical**: a fixed syntactic pattern, a banned API, an import shape, a file-location rule
  - **judgment calls**: cross-file consistency, "matches the surrounding style," anything no guardrail could ever substitute for. 
_Use when_ the reviewer agent failed to catch a mistake.
- **Global AGENTS.md/CLAUDE.md**: are there any steering instructions that should be moved to coding standards (or automated checks) instead? _Use when_ the AGENTS.md/CLAUDE.md file is particularly large - in the repo OR the user's global scope.
- **Tool economy**: did the agent make expensive tool calls that could be streamlined? Is there any custom tooling (CLI's, MCP's) that is particularly token-inefficient? _Use when_ the agent made an expensive tool call.
- **No-ops**: look for instructions in steering files that don't modify the agent's behavior. _Use when_ the steering files are large and unwieldy.
- **Information access**: look for opportunities to increase the agent's access to information. Teeing dev server logs, readonly access to third-party services. _Use when_ a crucial piece of information was not available to the agent.

## Cloud routines
Cloud routine runs can be read. Use the RemoteTrigger tool: `list`, `get`, `list_runs`, `get_run_log`. Known pitfalls:
- **Don't trust `list` to be complete.** It returns only the first 20 routines and ignores `next_cursor`. Most of those slots are one-off "Re-check PR" reminders, so recurring routines get hidden.
- **Build the full routine list from `start_setup_run`'s `routineIdsInSessions`** when its reply has it: quotient adds the routine ids your sessions from the window mention. Combine those IDs with the `list` result. Never search the transcripts for routine ids with Bash: quotient refuses it.
- **Call `list_runs` on each ID, not `get`.** `get` returns the whole routine prompt (10–20KB each). Routines with a cron schedule are the recurring ones; reminders usually show no runs.
- **An empty `list_runs` doesn't mean the routine never ran.** Routines that post into a persistent session (e.g. ones created from Slack) leave no run rows. Call `get` and read `last_run.session_id`, then pass that to `get_run_log`.
- **If Claude Code saves a RemoteTrigger reply to a file, read that file with Read, never Bash:** quotient refuses shell reads there. During setup quotient shortens these replies, so this is rare.
- **Call RemoteTrigger from the main session.** Subagents can't load it, so fetch the run logs yourself before handing any analysis to a subagent.
- **`get_run_log` shows only the newest 200 events,** so a run's setup phase (environment, dependency installs) is usually cut off. Read only the newest page of a run's log, and pass `next_cursor` for the older events only when the newest page shows setup friction.
- **Sample, don't read everything:** 2–3 runs per recurring routine from the window, including the latest. Say which runs were sampled.
- **Also compare each recurring routine's saved prompt with what its runs report.** Look for truncated instructions, connectors it doesn't need, and the wrong time zone.

## Start message
Once you've listed the routines and chosen the runs to sample, and before reviewing anything, show the operator the start message.

Call quotient's `setup_start` tool with `cloudRuns`, `firstDay` and `lastDay` (days like `Oct 15`), taken as described below, and `checksTeammates`: `true` when this setup checks your setup for fixes to teammates' frictions. It counts the sessions and automated runs and draws the start message, so write nothing yourself. Only if it refuses for want of `sessions` or `automatedRuns`, count them as described above and call it again with them.

Take the sessions and automated runs from your own count when you made one, the cloud runs from the number of routine runs you'll review, and the days from the two weeks before the run's `startedAt`.

Then write no other text until the final summary: no plan, no progress updates, no notes between batches.

## Progress
Skip the sessions and routine runs in the run's `reviewedSources`.

The start message's counts already leave out every session you skip, so `reviewedSessionCount` is the same from the first friction you submit: never take the skipped sessions off it again.

When a new finding is the same friction as one in the run's `frictionsInRun`, or one you've submitted since, send its `frictionId` with the new frequency, `affectedSessionCount` and impact, and `reviewedSessionCount` set to this run's total, instead of submitting another.

Before submitting a friction, compare it with the run's `reportedFrictions`. Leave it out when it is clearly the same problem as one of them, even if you would word it differently: teammates are already looking for its fix. Record each one you leave out by its `id`. When you aren't sure it's the same problem, submit it.

When `setup_start`'s reply lists batches, review exactly those, in that order, then the routine runs you sampled. Call `mcp__quotient__setup_digest` with each source's name, as the batch gives it, and review its digest: the prompts, errors, refusals, interrupts, repeated calls and large results, each with its transcript line. Then cite evidence from the digest, by its line numbers and short quotes. Never read a transcript itself, not even a few lines to check evidence: its lines run to tens of thousands of tokens. Don't list, count or search the projects folder yourself. The list already leaves out the sessions you skip, the sources this run has recorded, all but the latest runs of each recurring automated job (about the square root of its run count, from 3 to 15), and the sessions that hold teammates' fixes. Without that list, choose the batches yourself as below.

Review sources in small batches of at most 10 sessions or routine runs. Hand each batch of local sessions to its own subagent with the Agent tool, `subagent_type: "quotient:setup-reviewer"`, at most 16 running at once. Its prompt gives the batch's sources by name, each with its folder, and the titles of the frictions this run has submitted and of its `reportedFrictions`. The reviewer already has the Agent Experiences section above, so don't repeat it. When there's only one batch, review it yourself. Review the routine runs you sampled yourself, since a subagent can't fetch their logs. Without that agent type, review a batch yourself or hand batches to subagents, several at a time. The review subagents only report back. For each source, they give its id (a session's transcript file name without `.jsonl`, or a routine run's id), the frictions they found, with evidence, and anything that clearly worked well for the agent, with evidence. A friction that is the same problem as one of the titles they were given comes marked `matches: <title>`. They never submit frictions or record progress. Keep what worked well for the summary: it's never sent to Quotient.

As soon as a batch is done, start the next waiting batch's reviewer, if any, then, before waiting on another:
1. Send all its frictions to `submit_frictions`, in one call, or several of up to 100 when it found more: each new friction, and for one already submitted, its `frictionId`, to update the matching friction already submitted (its frequency, `affectedSessionCount` and impact, and `reviewedSessionCount` set to this run's total). When it found none, skip the call.
2. Then call `record_setup_progress` with the run's `runId`, its `sources` except any the reviewer skipped because `setup_digest` refused them, so a resumed run tries those again, and as `skippedFrictionIds` the ids of the `reportedFrictions` it found again.

Do the same for a batch you review yourself, and for the routine runs you sampled: one `submit_frictions` call with what you found, then `record_setup_progress`.

Never hold reviewed sources back to record at the end: an interrupted run redoes every source it didn't record.

When every session and sampled routine run in the window has been recorded, call `finish_setup_run` with the run's `runId`. Its reply has the run's `counts` by severity (`high`, `medium`, `low` and `other`), `newCount`, the frictions it stored, and `alreadyReportedCount`, the frictions it found already reported, counting the ones you left out. Then end with the summary below.

## Friction
Send each batch's frictions in one call to `submit_frictions`, with them as `frictions`. It takes at most 100, so a batch with more goes in several calls of up to 100. Give each friction these fields:
- `runId`: the run's `runId`
- `title`: a few words naming the friction, for a list, such as `Lint fails in CI after passing on commit`. Say what goes wrong, not the fix
- `description`: the friction in 1-2 sentences. End with what it cost and which sessions or routines it reaches, such as `About 15 minutes and 25 tool calls in each new worktree.`
- `frequency`: roughly how often it has been occurring, starting with the number of sessions or routine runs it appeared in, such as `9 sessions over two weeks`
- `affectedSessionCount`: that number of sessions and routine runs it appeared in, as a whole number of at least 1, such as `9`
- `reviewedSessionCount`: how many sessions, automated runs and cloud routine runs this setup reviews in all: the sum of the three counts in the start message. It is the same for every friction of a run, and never smaller than `affectedSessionCount`
- `impact`: the kind of harm the friction did, as exactly one of these values. When it fits more than one, send the first one in this list that applies. Judge by what you saw happen: a near miss counts, but a risk to some future or less careful run doesn't.
  - `SAFETY`: the agent took or nearly took a destructive or unsafe action (data deleted, work at risk, a safety check skipped or bypassed), or exposed a secret or private data
  - `QUALITY`: something wrong, unverified or incomplete reached the operator or left the session (an answer, PR, commit, ticket, stored data or review), even though the work finished
  - `BLOCKED`: the work or the run stopped or produced nothing, and the agent couldn't finish it on its own
  - `OPERATOR_ATTENTION`: the operator had to step in: correct or redirect the agent, answer extra questions, do steps by hand, or re-run something
  - `COST`: the main harm is tokens, context or compute, such as oversized output, duplicate work or context bloat, rather than turns
  - `TIME`: the agent wasted turns, tool calls or minutes, then finished correctly without the operator's help
- `severity`: exactly `high`, `medium` or `low`
- `tags`: tag keywords describing the friction
- `origin`: `"setup"`

An update to a friction already submitted carries every field above, as a new one does, and its `frictionId`.

Locally, leave `repository` out: the sessions come from many repos. In a cloud session, also send `repository`: run `git remote get-url origin` and send the repository as `owner/name`.

Its reply's `frictions` has one entry per friction, in the order you sent them: the first entry is the first friction's. Each entry's `status` is:
- `new` or `updated`, with the friction's `frictionId`: keep it, to update that friction from a later batch;
- `alreadyReported` for a friction you'd already reported elsewhere, which isn't stored again;
- `refused`, with the `reason`, for one Quotient didn't store. Don't send a refused friction again.

When Quotient refuses every friction in the call, it replies with an error that lists each friction's reason. Don't send them again, and don't stop: send the batch's remaining calls, if any, then go on to `record_setup_progress`. Any other error stops setup, as the Setup run section says.

If quotient refuses the call because a friction's text holds something teammates mustn't see, it names the field, such as `frictions[2].description`. Friction numbers start at 0, so that is the third friction. Rewrite that field and send the whole call again: nothing in it was sent.

## What teammates see
Every teammate reads the text you send to Quotient: each field but the ids and the repository. Describe the problem or the fix, never who or where it came from:
- Name a config, tooling or docs file, such as a CI workflow, a lint config or a git hook, by its path relative to its repo, or, outside a repo, from `~/`. Describe a file of the app's own code by what it does, never by its path or name. Name a setting, tool, skill or plugin by its name. Never write an absolute path, a home folder or a username.
- Refer to Claude Code's project folders, and the transcripts and auto-memories in them, in general terms, such as "this repo's auto-memory". Never write a project folder's name or its path.
- Describe the app's own code by what it does, such as "the billing API's request handler", never by its class, function, table or other names.
- Never write anyone's name, username, email or handle: not the operator's, not a teammate's, not anyone a session mentions.
- Never write a secret or a configured value: no token, key, password, connection string or `env` value. Name the setting instead.
- Never write an internal hostname, an IP address, a private URL, a chat channel, or a ticket's id or link.
- Never copy customer data, or quote a session: say in your own words what happened.
- Never write the id of a friction, a solution, a run, a session or a transcript.

If quotient refuses a call because its text holds one of these, rewrite that field and send it again. That isn't a tool error.

## What the operator sees
- Never show the operator the id of a friction, a solution, a run or a session, even when a tool's reply holds one. Name a friction by its number or its description instead.
- Never show a teammate's name or email. Quotient never says who raised a friction or found a fix.
- Write no Insight, recap or other closing block, whatever your output style asks for.

## Summary
Call quotient's `setup_summary` tool once with these fields, then end your turn without writing anything else. Each piece of text it takes (every `working` item, every `top` description and `inCommon`) is at most 200 characters, counting an emoji as 2 or more:
- `frictions`: `finish_setup_run`'s `newCount`.
- `working`: up to three things the subagents reported working well, each backed by their evidence, as a list of text. Give fewer when that's all there is, and none when there's none.
- `top`: one row for each of the three frictions submitted in this run that cost the agents the most time or happened most often, each with `severity` (`high`, `medium` or `low`), `description` (the friction's `title`, or its `description` when it has none), `impact` (the value you sent in `submit_frictions` for that friction), and `sessions` (the count from the start of its frequency).
- `remainingHigh`: the `counts` high number minus the high frictions in `top`, or 0 when `frictions` is 3 or fewer.
- `inCommon`: one or two sentences on what the top frictions have in common, and only what's true of them. For example: "Two of your top three involve your CI and local setup. Whoever set those up has likely hit the same problems and solved them in their own Claude setup." Leave it out when `frictions` is 0, and when this setup checked your setup for fixes to teammates' frictions: quotient adds what that check found itself.

The tool draws every section, including a sample fix whose teammate is made up. If it refuses a field, fix that field and call it again.

Put nothing else in any field:
- No id of a friction, session or routine run, and no name or email of a teammate.
- No list of what you reviewed, no corrections you made, and no suggested changes to the operator's setup.
- No Insight, recap or other closing block.
