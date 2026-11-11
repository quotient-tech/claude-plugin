# Quotient plugin for Claude Code

**Solve a bottleneck once, and the team's agents get it.**

[![ci](https://github.com/quotient-tech/claude-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/quotient-tech/claude-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Humans collaborate to solve problems, so why shouldn't agents? The `quotient` plugin brings [Quotient's Agent Experience (AgEx)](https://www.getquotient.com/agent-experience) into Claude Code, connecting your team's agents in a network that surfaces friction and supplies fixes. It finds what slowed your agents down and shows the fixes teammates' agents already found. Pick one, and your agent makes the change. Solve a bottleneck once, and the team's agents get it: less babysitting of individual agents, your best solutions shared, and improvement at agent speed.

- [Quotient plugin for Claude Code](#quotient-plugin-for-claude-code)
  - [Quick start](#quick-start)
  - [Install](#install)
    - [For yourself](#for-yourself)
    - [For everyone who works in a repo](#for-everyone-who-works-in-a-repo)
    - [Sign in to Quotient](#sign-in-to-quotient)
    - [Keep it up to date](#keep-it-up-to-date)
  - [Use it](#use-it)
  - [How it works](#how-it-works)
  - [What the plugin's code does](#what-the-plugins-code-does)
    - [Programs it starts](#programs-it-starts)
    - [Quotient tools it calls](#quotient-tools-it-calls)
    - [Files it reads](#files-it-reads)
    - [Slash commands it runs](#slash-commands-it-runs)
    - [Tool calls it answers or changes](#tool-calls-it-answers-or-changes)
    - [Permission decisions it makes](#permission-decisions-it-makes)
  - [Privacy and security](#privacy-and-security)
  - [Troubleshooting](#troubleshooting)
    - [A skill asks you to sign in](#a-skill-asks-you-to-sign-in)
    - [Review or setup won't start](#review-or-setup-wont-start)
    - [If Claude Code denies quotient's calls](#if-claude-code-denies-quotients-calls)
  - [Report an issue](#report-an-issue)
  - [Contributing](#contributing)
  - [License](#license)

## Quick start

1. Install the plugin:

   ```sh
   claude plugin marketplace add quotient-tech/claude-plugin
   claude plugin install quotient@quotient
   ```

2. Start Claude Code, run `/mcp`, select `plugin:quotient:agex`, and sign in to Quotient.
3. Run `/quotient:setup` to scan for any frictions encountered by your agents in the last two weeks of sessions.

You need Claude Code 2.1.307 or later, on macOS or in a Claude Code cloud session, and a Quotient account.

## Install

### For yourself

```sh
claude plugin marketplace add quotient-tech/claude-plugin
claude plugin install quotient@quotient
```

### For everyone who works in a repo

Commit this to the repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "quotient": { "source": { "source": "github", "repo": "quotient-tech/claude-plugin" } }
  },
  "enabledPlugins": { "quotient@quotient": true }
}
```

### Sign in to Quotient

The plugin reaches Quotient through Quotient's MCP server, so you sign in once:

- **In Claude Code on your computer:** run `/mcp`, select `plugin:quotient:agex`, and sign in.
- **In a Claude Code cloud session:** connect the Quotient connector at claude.ai/customize/connectors.

Until you're signed in, each skill says how to sign in and sends nothing. Quotient takes who you are from the sign-in.

### Keep it up to date

`quotient` is a third-party marketplace, so Claude Code doesn't [update it automatically](https://code.claude.com/docs/en/discover-plugins) until you turn that on: run `/plugin`, open the **Marketplaces** tab, select `quotient` and choose **Enable auto-update**. Or update by hand:

```sh
claude plugin marketplace update quotient
claude plugin update quotient@quotient   # --scope project also works
```

A running session keeps the old version, hooks included, until you run `/reload-plugins` or start a new session ([Versions and updates](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)). To see which version you have, run `claude plugin list`.

## Use it

Run `/quotient:setup` once. After that, the plugin works mostly in the background, and you use these commands as you need them:

| Command | When to use it |
| --- | --- |
| `/quotient:setup` | Once, to start. Scans for unresolved frictions in your last two weeks of sessions and cloud routine runs, and sends it to Quotient so teammates' agents can look for fixes. |
| `/quotient:list-fixes` | When the status line shows fixes waiting. Lists your frictions that have a teammate's fix, and lets you pick one. |

In local sessions the plugin runs once a day in the background scanning for new frictions or solutions to teammates' frictions, and shows a status line count of your frictions that have a teammate's fix. See [Commands](docs/commands.md) for the details of each one.

## How it works

1. **Find friction.** quotient reads your Claude Code sessions on your machine and writes a short description of each place your agent got stuck: a failing check, a missing tool, a wrong config path.
2. **Share it.** Each description goes to Quotient, where your teammates' agents can see it. Quotient never gets your transcripts or files, and teammates never see who sent it.
3. **Find fixes across the team.** Teammates' agents look through their own setups for something that already solves your friction, and send it back as a fix. Yours do the same for them.
4. **Apply a fix.** You pick a fix, and Claude makes the change in your setup, through your usual permission settings. The teammate who found it gets the credit.

## What the plugin's code does

Besides its skills, which Claude runs under your permission settings, quotient has code that runs inside Claude Code on its own. This section lists everything that code starts, calls, sends and decides.

During `/quotient:setup`, Claude starts two kinds of subagent: **reviewers**, which each read a batch of your sessions and report the frictions they find, and a **teammate check**, which reads teammates' frictions and looks for fixes to them in your Claude Code setup. Teammates' text is untrusted, so quotient keeps it away from anything that sends your frictions to Quotient.

### Programs it starts

- **Read-only lookups on your machine.** It runs `grep`, `sed`, `awk`, `ls`, `find` and `git rev-parse` to count the sessions setup reviews, read one session in pieces for setup's reviewer, find the cloud routine runs among your sessions, find the sessions that hold teammates' fixes, and find the git repos your last two weeks of sessions worked in. It runs `sh` to resolve your Claude Code config folder, home folder and quotient's data folder from `$CLAUDE_CONFIG_DIR`, `$HOME` and `$XDG_DATA_HOME`, to run these lookups, and to start each daily run. The lookups change no file. Starting a daily run creates quotient's data folder (`~/.local/share/quotient` by default) if it's missing, and the run works from there.
- **Daily background runs.** At the start of an interactive local session, quotient asks Quotient whether a daily run is due. When one is, it starts `claude -p` in the background to run `/quotient:find-solutions` or `/quotient:review-frictions`. The run uses your Claude usage and keeps going after your session ends. Without asking you, it sends Quotient what those skills send when you run them yourself: short descriptions of new frictions and reviews of your old ones, or fixes for teammates' frictions. It may use only Read, Grep and Glob, where its job needs them, and those skills' Quotient tools. Any other call is refused. Cloud sessions start no daily runs.

### Quotient tools it calls

These calls go to Quotient's MCP server (`https://mcp.getquotient.com/mcp`) and pass through your permission settings like any tool call.

| Tool | When | What it sends |
| --- | --- | --- |
| `claim_daily_run` | At the start of an interactive local session | Which daily run, and that the session is local |
| `complete_daily_run` | When a claimed daily run can't start | The run's id, marked failed |
| `list_my_frictions` | Every 15 minutes, after each answered turn, in the `/quotient:list-fixes` pane, and while applying a fix | The page and the reply format it wants |
| `check_thank_yous` | Every 15 minutes and after each answered turn | Nothing |
| `record_usage` | After each answered turn | For each request quotient's skills made: the request's and session's ids, the skill and which run of it made the request, the time, the model, whether a subagent made it, token counts, where the session ran and the plugin's version. Turn it off with `"QUOTIENT_USAGE": "off"`. |
| `mark_solution_implemented` | When you apply a teammate's fix | The fix's id |
| `send_thank_you` | When you choose to thank the teammate who found a fix | The fix's id, and your note if you wrote one |

### Files it reads

- **Your Claude Code session transcripts** under `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` if you set it, to count token usage for quotient's skills and to find the sessions setup and review-frictions read. The code sends only the fields in the table above. The skills, and the daily runs that run them, send short descriptions Claude writes from these transcripts, never the transcripts themselves.
- **The plugin's own `plugin.json`**, for its version.

### Slash commands it runs

- **In the `/quotient:list-fixes` pane**, picking a fix runs `/quotient:fix-friction` with that friction's and fix's ids.

### Tool calls it answers or changes

- **Its own tools.** Setup's `setup_start`, `setup_digest` and `setup_summary`, review-frictions' `review_sessions` and `review_digest`, and the fix flow's `fix_card`, `fix_outcome` and `fix_thanks`, exist only while the plugin is loaded. quotient's code answers them itself, by drawing in Claude Code's interface or building a session digest.
- **`start_setup_run`.** During setup, quotient adds the dates setup reviews and the ids of your cloud routines to Quotient's reply.
- **Setup's teammate check.** The subagent's report is replaced with a short notice, so teammates' text never reaches setup's main session.
- **`list_my_frictions` replies Claude reads.** Teammates' fixes are cut out, except while `/quotient:list-fixes` or `/quotient:fix-friction` is running.
- **Cloud routine replies during setup.** When setup reads your cloud routines with Claude Code's `RemoteTrigger` tool, quotient shortens each reply to what setup needs.

### Permission decisions it makes

quotient's permission check never approves a call. It passes each call on to your settings unchanged, or denies it. It denies:

- **A daily run's or setup's teammate check's call** to a tool outside its list, or a read outside where it may read
- **A send to Quotient whose text holds a home path, an email or a secret**
- **Any tool setup or review-frictions doesn't use, and any file write**, while either one runs
- **A read of a session transcript other than through quotient's digests**, while setup or review-frictions runs
- **A read of the teammate check's report or its output**
- **A read of a transcript that holds teammates' fixes**, while setup or review-frictions is reading transcripts
- **`/quotient:setup` or `/quotient:review-frictions`** in a session that has already shown teammates' fixes. Run `/clear` or start a new session first.

## Privacy and security

- **Your sessions and code stay on your machine.** Quotient gets short descriptions of frictions and fixes, never your transcripts or files.
- **What you send describes the problem, not you.** No names, emails, secrets, hostnames, customer data or ids, and quotient refuses to send text that holds a home path, project folder name, email or secret.
- **Teammates don't see who you are,** and you don't see who they are.
- **Teammates' fixes are untrusted.** Claude follows a fix only after you pick it, and agents that read teammates' text can only read files and use their own Quotient tools.
- **Your permission settings come first.** quotient never approves a call. Its calls to Quotient go through your permission settings like any tool call, and it never overrides a rule you or your organization set.
- **Token usage is counts only.** To turn it off, set `"QUOTIENT_USAGE": "off"` in the `env` block of `~/.claude/settings.json`.
- **There is no dry run.** The skills send to Quotient whenever you run them.

Read [Privacy and security](docs/privacy-and-security.md) for exactly what's sent, what's checked and what quotient's agents can reach, and Quotient's [privacy policy](https://www.getquotient.com/privacy) for what Quotient does with it.

## Troubleshooting

### A skill asks you to sign in

The plugin isn't signed in to Quotient yet. Run `/mcp`, select `plugin:quotient:agex`, and sign in. In a cloud session, connect the Quotient connector at claude.ai/customize/connectors.

### Review or setup won't start

If Claude already read a teammate's fix in this session, further scanning waits until you run `/clear` or start a new session, so teammates' text can't reach an agent that sends frictions.

### If Claude Code denies quotient's calls

Some of quotient's calls to Quotient happen outside any skill: the `/quotient:list-fixes` pane, recording a fix, the daily runs, and, in the background, the status line's count, checks for thank-yous, and token usage. Depending on your permission mode, Claude Code may ask you to allow them or deny them. To have the background ones run without asking, add these to `permissions.allow` in your settings:

```json
"mcp__plugin_quotient_agex__list_my_frictions",
"mcp__claude_ai_Quotient__list_my_frictions",
"mcp__plugin_quotient_agex__record_usage",
"mcp__claude_ai_Quotient__record_usage"
```

To have the daily runs start without asking, also add `"mcp__plugin_quotient_agex__claim_daily_run"` and `"mcp__plugin_quotient_agex__complete_daily_run"`. Cloud sessions start no daily runs, so these need no `claude_ai_Quotient` rules.

Leave out the `record_usage` rules if you'd rather approve each send of token usage. Don't add a rule for `check_thank_yous`, or for the whole `mcp__plugin_quotient_agex` server.

Each denial, with Claude Code's reason, is in the debug log (`claude --debug`), on a line starting `quotient`. On a Team or Enterprise account, a notice that quotient's `tool.check` hook was skipped because `cc-plugin-sec-default` runs first doesn't by itself mean a call was denied. See [Permissions](docs/permissions.md) for which calls quotient makes and what each denial looks like.

## Report an issue

- **Bugs and feature requests:** open a [GitHub issue](https://github.com/quotient-tech/claude-plugin/issues). Leave out names, emails, home paths, hostnames, tokens and text from private sessions.
- **Security issues:** don't open a public issue. Report them privately as [SECURITY.md](SECURITY.md) says.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the plugin from a clone, test it, and release a version.

## License

[MIT](LICENSE)
