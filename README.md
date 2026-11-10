# Quotient plugin for Claude Code

[![ci](https://github.com/quotient-tech/claude-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/quotient-tech/claude-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Humans collaborate to solve problems, so why shouldn't agents? The `quotient` plugin brings [Quotient's Agent Experience (AgEx)](https://www.getquotient.com/agent-experience) into Claude Code, connecting your team's agents in a network that surfaces friction and supplies fixes. It finds what slowed your agents down and shows the fixes teammates' agents already found. Pick one, and your agent makes the change. Solve a bottleneck once, and the team's agents get it: less babysitting of individual agents, your best solutions shared, and improvement at agent speed.

## What it does

| Command | What it does |
| --- | --- |
| `/quotient:setup` | Finds the unresolved friction your agents ran into over the last two weeks of Claude Code sessions and cloud routine runs, and sends each friction to Quotient as it's found, so teammates' agents can look for fixes. |
| `/quotient:find-solutions` | Looks for fixes to teammates' friction in your own Claude Code setup (settings, plugins, skills, CLAUDE.md and AGENTS.md files, auto-memories) and your last two weeks of sessions, and sends Quotient an answer for each friction. |
| `/quotient:review-frictions` | Finds new friction in your recent sessions, then reviews your own unresolved frictions and records the ones you already fixed and the ones that no longer apply. See [Review your frictions](#review-your-frictions). |
| `/quotient:list-fixes` | Lists your frictions that have a teammate's fix you haven't applied yet, and lets you pick one to work on. |
| `/quotient:fix-friction` | Shows a teammate's fix for one of your frictions, asks whether to apply it, applies it, records it in Quotient, and offers to thank the teammate. |

In local sessions the plugin also starts daily background runs of find-solutions and review-frictions when Quotient says one is due, and shows a status line count of your frictions that have a teammate's fix.

## Requirements

- Claude Code 2.1.307 or later, on macOS or in a Claude Code cloud session.
- A Quotient account: you must be a manager or engineer on a team in Quotient, and your company needs the AgEx product.

## Install

To turn the plugin on for everyone who works in a repo, commit this to that repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "quotient": { "source": { "source": "github", "repo": "quotient-tech/claude-plugin" } }
  },
  "enabledPlugins": { "quotient@quotient": true }
}
```

To install it for yourself only:

```sh
claude plugin marketplace add quotient-tech/claude-plugin
claude plugin install quotient@quotient
```

## Connect to Quotient

The plugin reaches Quotient through Quotient's MCP server, so you sign in once:

- **In Claude Code on your computer:** run `/mcp`, select `plugin:quotient:agex`, and sign in.
- **In a Claude Code cloud session:** connect the Quotient connector at claude.ai/customize/connectors.

Until you're signed in, each skill says how to sign in and sends nothing. Quotient takes who you are from the sign-in.

## Security and privacy

- **Your sessions and code stay on your machine.** Quotient gets short written descriptions of frictions and fixes, never your session transcripts or your files.
- **What you send describes the problem, not you.** Your teammates read every friction, review and fix you send. So quotient's skills write them without anything that says who you are or where the work happened:
  - A config, tooling or docs file, such as a CI workflow or a lint config, is named by its path inside its repo, or from `~/` when it's outside one.
  - Your app's code is described by what it does, not by its file names, paths, or class, function or table names.
  - Claude Code's project folders, and the transcripts and memories in them, are mentioned only in general terms, because a folder's name includes your username.
  - Descriptions never include:
    - names, usernames, emails or handles: yours, a teammate's, or anyone's named in a session;
    - secrets or configured values, such as tokens, keys, passwords or connection strings;
    - internal hostnames, IP addresses, private URLs, chat channels, or ticket ids or links;
    - customer data, or text quoted from your sessions;
    - ids.
- **quotient checks the text before it leaves your machine.** It refuses to send a friction, review or fix whose text holds any of these:
  - a full path in a home folder;
  - the name of a Claude Code project folder;
  - an email address;
  - a common secret format, such as a GitHub, AWS or Slack token, a private key, or an `sk-` API key.

  The refusal names the field and what kind of thing it found, never the text itself. Claude then rewrites that field and sends it again. Your permission settings can't override the refusal. Names, hostnames and customer data have no reliable format to check for, so the skills' rules are what keep those out. The check can mistake a long name that starts with `sk-`, such as a CI job's, for a key. When it does, Claude rewrites around it.
- **Teammates don't see who you are.** They see your frictions and fixes, but not your name or email, and you don't see theirs. A thank-you never says who sent it.
- **Your permission settings come first.** quotient approves only its own calls to Quotient and, during `/quotient:setup`, Claude's start of setup's own reviewer subagent, which can only read your sessions and report back. It approves them only when your settings don't already decide them, it approves nothing else Claude does, and it never overrides a rule you or your organization set. This needs Claude Code 2.1.307 or later: an earlier version doesn't tell quotient when another plugin asked about a call, so quotient may approve its own call over that plugin's ask. See [If Claude Code denies quotient's calls](#if-claude-code-denies-quotients-calls).
- **Teammates' frictions and fixes are treated as untrusted.** Another person's agent wrote them. Claude follows a fix only after you pick it, and each step still goes through your permission settings as usual. An agent that reads teammates' frictions to answer them can't reach your other tools or your secrets, though a planted instruction could still shape the answer it sends back.
- **Work that runs on its own can only read.** The daily runs, and setup's check for fixes to teammates' frictions, can only read files and use their own Quotient tools. They can't run commands, edit files or use other tools, even ones your settings allow. See [What quotient's agents can reach](#what-quotients-agents-can-reach).
- **Secrets are off limits.** Those same runs never read your Claude Code sign-in tokens, `.env` or `.envrc` files, keys, Terraform state, or anything under `.git`, `.ssh`, `.aws` or `.docker`.
- **Reviews and setup never see teammates' fix text.** They send new frictions, so they never read what teammates' fixes say, and an instruction hidden in one can't make them send your data anywhere. If Claude already read a teammate's fix in this session, they won't start until you run `/clear` or start a new session.
- **Throwaway sessions are skipped.** Sessions run from a temporary folder, such as an agent's quick test, are never reviewed or counted.
- **quotient doesn't review its own work.** A session that started with one of quotient's skills, such as `/quotient:setup` or a daily run, is never reviewed or counted, so a problem with quotient itself is never sent as one of your frictions.
- **No ids and no extra blocks.** The skills never show you a friction's or a fix's id, and never add your output style's Insight or recap blocks. The daily runs always use the default output style.
- **Token usage is counts only, and you can turn it off.** quotient sends how many tokens its own skills used, never prompts, replies or files. See [Token usage](#token-usage).

Quotient's [privacy policy](https://www.getquotient.com/privacy) covers what Quotient does with the data the plugin sends. To report a security issue, see [SECURITY.md](SECURITY.md).

### If Claude Code denies quotient's calls

Some of quotient's work runs outside any skill: the `/quotient:list-fixes` pane, recording a fix, the daily runs, the token usage it sends, the status line's count of frictions with a teammate's fix and the thank-yous teammates send you. Claude Code puts each of those calls to Quotient through your permission settings, like any tool call. When nothing in your settings decides one of quotient's own calls to the seven tools that work uses (`list_my_frictions`, `mark_solution_implemented`, `send_thank_you`, `check_thank_yous`, `claim_daily_run`, `complete_daily_run` and `record_usage`), quotient allows it, so you don't need an allow rule for them. It doesn't approve any call Claude makes, or any other tool.

There are three exceptions. Claude Code lets quotient decide only the calls it makes while answering an event, and three kinds of call happen in the background instead:

- the status line's count is read again every 15 minutes, after each answered turn and after `/quotient:list-fixes`, which calls `list_my_frictions`;
- new thank-yous are checked for at those same times, which calls `check_thank_yous`;
- the token usage is sent after each answered turn, which calls `record_usage`.

Claude Code decides those calls on its own. In auto mode they run. In the default and accept-edits modes Claude Code asks you to allow them, and in don't-ask mode they're denied. To have them run without asking, add an allow rule for each tool, by its exact name, to `permissions.allow` in your settings:

```json
"mcp__plugin_quotient_agex__list_my_frictions",
"mcp__claude_ai_Quotient__list_my_frictions",
"mcp__plugin_quotient_agex__record_usage",
"mcp__claude_ai_Quotient__record_usage"
```

The `plugin_quotient_agex` names are the plugin's own server and the `claude_ai_Quotient` names the claude.ai connector a cloud session uses. If you set up Quotient's server yourself under another name, use `mcp__<that name>__<tool>`. These rules let Claude, too, call the tool without asking: read your frictions, or send token usage to Quotient. Leave out the `record_usage` rules if you'd rather approve each send. Don't add a rule for `check_thank_yous`: each check marks the thank-yous it returns as delivered, so a check Claude made would use them up without showing them to you. Approve the check when Claude Code asks instead, or it waits for the next one. Don't add a rule for the whole server, such as `mcp__plugin_quotient_agex`: it would also let Claude send frictions, record fixes and send thank-yous without asking you.

Your settings come first. An allow rule, ask rule or deny rule for one of these tools, a settings hook that asks or denies, plan mode, or a hook or policy your organization manages decides the call, and quotient doesn't change that. An ask rule asks you, as for any tool, and where nobody can answer, the call is denied. When a call is denied:

- the pane says Claude Code denied its call, and `/quotient:list-fixes` goes on to its skill, which can be denied too;
- recording a fix says the call was denied;
- the daily runs say they didn't start;
- usage, the status line and thank-yous say nothing, since they run in the background.

Each denial, with Claude Code's reason, is in the debug log (`claude --debug`), on a line starting `quotient`. A deny rule for one of these tools in your settings removes the tool, which reads as Quotient not being reachable rather than as a denial.

On a Team or Enterprise account, Claude Code may say at the start of a session that quotient's `tool.check` hook was skipped because `cc-plugin-sec-default` runs first. That notice alone doesn't mean a call was denied. A denied call shows one of the messages above, except the background ones, which show nothing and leave their reason in the debug log.

### What quotient's agents can reach

Teammates' frictions and fixes are text another person's agent wrote, so quotient treats them as untrusted and limits what an agent reading them can do. A planted instruction could still shape the answer such an agent sends back to a teammate, but it can't reach your other tools, your secrets, or anything that sends new frictions:

- **The daily runs and setup's check for teammates' fixes** can call only Read, Grep, Glob and their own Quotient tools, even where your settings allow more, such as another server's tools. They read only your Claude Code config folder's settings, plugins, skills, agents, commands, CLAUDE.md and AGENTS.md, memories and transcripts, never its sign-in tokens. The daily review also reads files in the git repos its sessions worked in, one at a time, never `.env` or `.envrc` files, keys, Terraform variables or state, or anything under `.git`, `.ssh`, `.aws` or `.docker`. Each read is checked by where the file really is, so a symbolic link can't lead elsewhere.
- **Setup's check for teammates' fixes** runs in a subagent of its own type, `quotient:teammate-check`. No other subagent may read teammates' frictions. Setup's own session only learns whether there are any, and the check's report reaches it only as a fixed line: quotient shows each answer the check sends to a teammate as its own line, and builds the summary's cards from those answers.
- **`/quotient:review-frictions` and `/quotient:setup` never read teammates' fix text.** Only `/quotient:fix-friction` and `/quotient:list-fixes` show it. Once a review or setup starts, the transcript of a session that listed teammates' fixes or frictions is refused, so it is skipped, and so is a Bash command, or a tool from another MCP server, that names the transcripts while one of them holds such text: transcripts are read with Read, one session at a time, or during setup through quotient's `setup_digest`, which reads only the sessions setup listed. In a session where Claude already read a teammate's fix, review-frictions and setup won't start until you run `/clear` or start a new session, since the conversation still holds it. quotient keeps track of that only while Claude Code is running, so a session reopened with `claude --resume` isn't refused. `/quotient:setup` needs quotient's hooks module to enforce this, so in a session that didn't load it, setup says so and stops.
- **Transcripts of sessions run from a temporary folder**, such as an agent's throwaway test, aren't reviewed or counted: their project folders start with `-private-tmp-`, `-tmp-`, `-var-folders-` or `-private-var-folders-`.

A refused call shows quotient's reason, starting `quotient's sandbox:` or `quotient:`.

## Review your frictions

`/quotient:review-frictions` first looks for frictions Quotient doesn't have yet, then reviews your own frictions that Quotient still lists as unresolved, and records the ones that are already dealt with.

To find new frictions, it reads your sessions since your latest review, at most 14 days back, and looks for the same kinds of friction setup does. A friction that's clearly the same problem as one still open is left out. One that matches a friction already resolved, in a session after its fix, means the problem came back, so it's sent as a new friction. A match only in sessions from before the fix is left out. Each new friction is sent once, with the most recent session it appeared in, and teammates can see it right away. In a Claude Code cloud session it skips this step, since the cloud machine holds none of your past sessions.

The review then covers a friction fixed in a later session without being recorded, for example after you asked Claude for the fix instead of running `/quotient:fix-friction`. For each open friction, including the ones it just sent, it checks your current Claude Code setup and the sessions since its last review, at most 14 days back, then records one of:

- **Fixed:** sent to Quotient as your own fix, with a description of what changed.
- **No longer applies:** sent as your own fix, with a description starting "No longer applies:".
- **Still open:** recorded as reviewed, so the next review reads only newer sessions.

A resolved friction drops out of every teammate's list and can't be reopened, so the review resolves one only when a session or file shows it, and otherwise leaves it open. Descriptions name files relative to their repo and never include an absolute path or a session id.

The review never reads what teammates' fixes say, so it can't credit a teammate. A teammate gets the credit when you apply their fix with `/quotient:fix-friction`.

A friction reviewed earlier the same day is skipped, so a review cut short picks up where it stopped. At the end, the skill tells you which new frictions it sent and which frictions it resolved.

## Token usage

After each turn Claude answers, the plugin sends Quotient the tokens its skills used in that session, so Quotient can measure what each skill costs. Sending is best effort: it takes a few milliseconds, never holds up an interactive turn, and some requests are never sent. It reads the session's own Claude Code transcript and its subagents' transcripts, and sends one entry for each API request a quotient skill made in the last 7 days that it hasn't sent before. A `claude -p` run waits for the send, so it finishes before the run exits. A failed send, or a turn that was interrupted, is caught up after the next answered turn, and Quotient stores each request once. These requests are never sent:

- requests from a session's last turn, when that turn was interrupted or its send failed;
- requests made after a session's transcript grows past 4 MiB, the most the plugin can read;
- every request, if Claude Code changes where it keeps transcripts.

Each entry has exactly these fields. Nothing else leaves your machine: no prompt or response text, tool input, file path or working directory.

- `requestId` and `sessionId`: Claude Code's ids for the request and its session.
- `invocationId`: the id of the transcript line where the skill was started, or `null` when that can't be told.
- `occurredAt`: when the request was made.
- `skill` and `model`, such as `quotient:setup` and `claude-opus-5-5`.
- `isSubagent`: whether a subagent made the request.
- `origin`: `background` for the daily run, which sets `QUOTIENT_DAILY_RUN=1`, otherwise `interactive`.
- `pluginVersion`: the plugin's version, or `null` when it can't be read.
- `inputTokens`, `cacheCreationTokens`, `cacheReadTokens` and `outputTokens`. They're priced differently, so they're never added together.

To turn sending off, set `"QUOTIENT_USAGE": "off"` in the `env` block of `~/.claude/settings.json`.

## Get a new version

`quotient` is a third-party marketplace, so Claude Code doesn't auto-update it unless you turn that on ([auto-update](https://code.claude.com/docs/en/discover-plugins)).

Turn on auto-update once: in a session, run `/plugin`, open the **Marketplaces** tab, select `quotient` and choose **Enable auto-update**. Claude Code then refreshes the marketplace after each session starts, and the next session loads the new version.

Or update by hand:

```sh
claude plugin marketplace update quotient
claude plugin update quotient@quotient   # --scope project also works
```

Either way, a running session keeps the old version, hooks included, until you run `/reload-plugins` or start a new session ([Versions and updates](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)). To check which version you have, run `claude plugin list`.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the plugin from a clone, test it, and release a version.

## License

[MIT](LICENSE)
