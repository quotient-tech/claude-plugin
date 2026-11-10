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

## Privacy and security

- **Your sessions and code stay on your machine.** Quotient gets short descriptions of frictions and fixes, never your transcripts or files.
- **What you send describes the problem, not you.** No names, emails, secrets, hostnames, customer data or ids, and quotient refuses to send text that holds a home path, project folder name, email or secret.
- **Teammates don't see who you are,** and you don't see who they are.
- **Teammates' fixes are untrusted.** Claude follows a fix only after you pick it, and agents that read teammates' text can only read files and use their own Quotient tools.
- **Your permission settings come first.** quotient approves only its own calls to Quotient, and never overrides a rule you or your organization set.
- **Token usage is counts only.** To turn it off, set `"QUOTIENT_USAGE": "off"` in the `env` block of `~/.claude/settings.json`.
- **There is no dry run.** The skills send to Quotient whenever you run them.

Read [Privacy and security](docs/privacy-and-security.md) for exactly what's sent, what's checked and what quotient's agents can reach, and Quotient's [privacy policy](https://www.getquotient.com/privacy) for what Quotient does with it.

## Troubleshooting

### A skill asks you to sign in

The plugin isn't signed in to Quotient yet. Run `/mcp`, select `plugin:quotient:agex`, and sign in. In a cloud session, connect the Quotient connector at claude.ai/customize/connectors.

### Review or setup won't start

If Claude already read a teammate's fix in this session, further scanning waits until you run `/clear` or start a new session, so teammates' text can't reach an agent that sends frictions.

### If Claude Code denies quotient's calls

A few of quotient's calls to Quotient run in the background: the status line's count, checks for thank-yous, and token usage. Depending on your permission mode, Claude Code may ask you to allow them or deny them. To have them run without asking, add these to `permissions.allow` in your settings:

```json
"mcp__plugin_quotient_agex__list_my_frictions",
"mcp__claude_ai_Quotient__list_my_frictions",
"mcp__plugin_quotient_agex__record_usage",
"mcp__claude_ai_Quotient__record_usage"
```

Leave out the `record_usage` rules if you'd rather approve each send of token usage. Don't add a rule for `check_thank_yous`, or for the whole `mcp__plugin_quotient_agex` server.

Each denial, with Claude Code's reason, is in the debug log (`claude --debug`), on a line starting `quotient`. On a Team or Enterprise account, a notice that quotient's `tool.check` hook was skipped because `cc-plugin-sec-default` runs first doesn't by itself mean a call was denied. See [Permissions](docs/permissions.md) for which calls quotient approves, why, and what each denial looks like.

## Report an issue

- **Bugs and feature requests:** open a [GitHub issue](https://github.com/quotient-tech/claude-plugin/issues). Leave out names, emails, home paths, hostnames, tokens and text from private sessions.
- **Security issues:** don't open a public issue. Report them privately as [SECURITY.md](SECURITY.md) says.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the plugin from a clone, test it, and release a version.

## License

[MIT](LICENSE)
