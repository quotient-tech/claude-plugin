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
4. Turn on auto-update so you get new releases: run `/plugin`, open **Marketplaces**, select `quotient` and choose **Enable auto-update**.

You need Claude Code 2.1.307 or later and a Quotient account.

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
    "quotient": {
      "source": { "source": "github", "repo": "quotient-tech/claude-plugin" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "quotient@quotient": true }
}
```

This turns the plugin on for the repo but doesn't download it, so each teammate runs `claude plugin install quotient@quotient --scope project` once per clone. With `autoUpdate`, their copies then update to each new release.

### Sign in to Quotient

The plugin reaches Quotient through Quotient's MCP server, so you sign in once:

- **In Claude Code on your computer:** run `/mcp`, select `plugin:quotient:agex`, and sign in.
- **In a Claude Code cloud session:** connect the Quotient connector at claude.ai/customize/connectors.

Until you're signed in, each skill says how to sign in and sends nothing. Quotient takes who you are from the sign-in.

### Keep it up to date

Turn on auto-update to get each new release. `quotient` is a third-party marketplace, so Claude Code doesn't [update it automatically](https://code.claude.com/docs/en/discover-plugins) until you do:

- **For yourself:** run `/plugin`, open the **Marketplaces** tab, select `quotient` and choose **Enable auto-update**.
- **For a repo:** set `"autoUpdate": true` on the `quotient` marketplace, as in the [settings above](#for-everyone-who-works-in-a-repo).

Or update by hand:

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
4. **Apply a fix.** You pick a fix, and Claude makes the change in your setup, through your usual permission settings. You can thank the teammate who found it with a high-five, which reaches them without your name.

## Privacy and security

- **Your sessions and code stay on your machine.** Quotient gets short descriptions of frictions and fixes, never your transcripts or files.
- **Teammates see only short descriptions of frictions and fixes.** quotient's skills write them to leave out names, emails, secrets, hostnames, customer data and ids. Before anything leaves your machine, quotient checks it for home paths, project folder names, emails and common secret formats, and won't send text that contains one.
- **Sharing is anonymous between teammates.** Teammates see your frictions and fixes but not your name or email, and you don't see theirs. High-fives work the same way. Quotient knows your account from your sign-in, but teammates can't tie anything you share back to you.
- **A teammate's fix runs only when you choose it.** Another person's agent wrote it, so a fix could contain instructions you wouldn't want followed. Claude acts on a fix only after you pick it, and each step still goes through your permission settings. The background runs that answer teammates' frictions can only read files and use their own Quotient tools, so they can't reach your other tools or your secrets.
- **Your permission settings come first.** quotient approves only its own calls to Quotient, and never overrides a rule you or your organization set.
- **Token usage is counts only.** To turn it off, set `"QUOTIENT_USAGE": "off"` in the `env` block of `~/.claude/settings.json`.

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

These rules also let Claude call those tools without asking. To approve each send of token usage yourself, leave out the two `record_usage` rules. Don't add any other quotient rules. A rule for `check_thank_yous` would let Claude use up your thank-yous before you see them, and a rule for the whole server would let Claude send frictions and fixes without asking you. [Permissions](docs/permissions.md#background-calls) explains each one.

Each denial, with Claude Code's reason, is in the debug log (`claude --debug`), on a line starting `quotient`. On a Team or Enterprise account, a notice that quotient's `tool.check` hook was skipped because `cc-plugin-sec-default` runs first doesn't by itself mean a call was denied. See [Permissions](docs/permissions.md) for which calls quotient approves, why, and what each denial looks like.

## Report an issue

- **Bugs and feature requests:** open a [GitHub issue](https://github.com/quotient-tech/claude-plugin/issues). Leave out names, emails, home paths, hostnames, tokens and text from private sessions.
- **Security issues:** don't open a public issue. Report them privately as [SECURITY.md](SECURITY.md) says.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the plugin from a clone, test it, and release a version.

## License

[MIT](LICENSE)
