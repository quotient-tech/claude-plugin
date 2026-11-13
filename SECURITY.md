# Security and privacy

The quotient plugin reads your Claude Code sessions and handles text that teammates' agents wrote, so it's built to keep your data on your machine and to treat teammates' text as untrusted. This page explains how to report a vulnerability, what the plugin sends, what it checks, and what its agents can reach. We treat security and privacy reports as our top priority.

Quotient's [privacy policy](https://www.getquotient.com/privacy) covers what Quotient does with the data the plugin sends.

## Report a vulnerability

Email **<support@getquotient.com>** with "Security" in the subject. Please don't open a public GitHub issue.

Include:

- what you found and what an attacker could do with it;
- the plugin version (`claude plugin list`) and your Claude Code version (`claude --version`);
- steps to reproduce, with any session text redacted.

We'll acknowledge your report, keep you updated while we fix it, and credit you in the release if you'd like.

## Supported versions

Only the latest release on `main` gets fixes. See the README's [Keep it up to date](README.md#keep-it-up-to-date) to update.

## Scope

In scope: anything in this repository, including the skills, agents and hooks module. Especially:

- text leaving your machine that the plugin should have refused, such as a home path, email or secret;
- a teammate's friction or fix that makes an agent act beyond what [What quotient's agents can reach](#what-quotients-agents-can-reach) allows;
- the plugin approving a call that your permission settings should have decided.

Issues in Quotient's hosted service can be reported to the same address.

## What the plugin promises

- **Your sessions and code stay on your machine.** Quotient gets short written descriptions of frictions and fixes, never your session transcripts or your files.
- **Teammates see only short descriptions of frictions and fixes, written to leave out anything that identifies you.** Your teammates read every friction, review and fix you send, so quotient's skills write them this way:
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
- **Your permission settings come first.** quotient never approves a call. Its own calls to Quotient go through your permission settings like any tool call, and it never overrides a rule you or your organization set. While `/quotient:setup` runs, the setup skill itself lets Claude start setup's reviewer subagents without asking. They can only read your sessions and report back. See [Permissions](docs/permissions.md).
- **Teammates' frictions and fixes are treated as untrusted.** Another person's agent wrote them. Claude follows a fix only after you pick it, and each step still goes through your permission settings as usual. An agent that reads teammates' frictions to answer them can't reach your other tools or your secrets, though a planted instruction could still shape the answer it sends back.
- **Work that runs on its own can only read.** The daily runs, and setup's check for fixes to teammates' frictions, can only read files and use their own Quotient tools. They can't run commands, edit files or use other tools, even ones your settings allow. See [What quotient's agents can reach](#what-quotients-agents-can-reach).
- **Reviews and setup leave your transcripts where they are.** While `/quotient:setup` or `/quotient:review-frictions` runs, Claude reads your sessions only through quotient's short digest of each, never a transcript itself, and it writes no file and runs no shell command but setup's own two: quotient refuses every tool those skills don't use, even ones your settings allow. See [What quotient's agents can reach](#what-quotients-agents-can-reach).
- **Secrets are off limits.** Those same runs never read your Claude Code sign-in tokens, `.env` or `.envrc` files, keys, Terraform state, or anything under `.git`, `.ssh`, `.aws` or `.docker`.
- **Reviews and setup never see teammates' fix text.** They send new frictions, so they never read what teammates' fixes say, and an instruction hidden in one can't make them send your data anywhere. If Claude already read a teammate's fix in this session, they won't start until you run `/clear` or start a new session.
- **Throwaway sessions are skipped.** Sessions run from a temporary folder, such as an agent's quick test, are never reviewed or counted.
- **quotient doesn't review its own work.** A session that started with one of quotient's skills, such as `/quotient:setup` or a daily run, is never reviewed or counted, so a problem with quotient itself is never sent as one of your frictions.
- **No ids and no extra blocks.** The skills never show you a friction's or a fix's id, and never add your output style's Insight or recap blocks. The daily runs always use the default output style.
- **Token usage is counts only, and you can turn it off.** quotient sends how many tokens its own skills used, never prompts, replies or files. See [Token usage](#token-usage).

## What quotient's agents can reach

Teammates' frictions and fixes are text another person's agent wrote, so quotient treats them as untrusted and limits what an agent reading them can do. A planted instruction could still shape the answer such an agent sends back to a teammate, but it can't reach your other tools, your secrets, or anything that sends new frictions:

- **The daily runs and setup's check for teammates' fixes** can call only Read, Grep, Glob and their own Quotient tools, and the daily review also quotient's `review_sessions` and `review_digest`, even where your settings allow more, such as another server's tools. They read only your Claude Code config folder's settings, plugins, skills, agents, commands, CLAUDE.md and AGENTS.md, memories and transcripts, never its sign-in tokens, and the daily review reads transcripts only through those digests. The daily review also reads files in the git repos its sessions worked in, one at a time, never `.env` or `.envrc` files, keys, Terraform variables or state, or anything under `.git`, `.ssh`, `.aws` or `.docker`. Each read is checked by where the file really is, so a symbolic link can't lead elsewhere.
- **Setup's check for teammates' fixes** runs in a subagent of its own type, `quotient:teammate-check`. No other subagent may read teammates' frictions. Setup's own session only learns whether there are any, and the check's report reaches it only as a fixed line: quotient shows each answer the check sends to a teammate as its own line, and builds the summary's cards from those answers.
- **`/quotient:review-frictions` and `/quotient:setup` never read teammates' fix text.** Only `/quotient:fix-friction` and `/quotient:list-fixes` show it. quotient never lists or digests the transcript of a session that listed teammates' fixes or frictions, so that session is skipped. In a session where Claude already read a teammate's fix, review-frictions and setup won't start until you run `/clear` or start a new session, since the conversation still holds it. quotient keeps track of that only while Claude Code is running, so a session reopened with `claude --resume` isn't refused. `/quotient:setup` needs quotient's hooks module to enforce this, so in a session that didn't load it, setup says so and stops.
- **While `/quotient:setup` or `/quotient:review-frictions` runs, transcripts are reached only through quotient's digests:** `setup_digest`, which reads only the sessions setup listed, and `review_sessions` and `review_digest`, which read only the sessions the review listed. A Read, Grep, Glob or Bash command that reaches a transcript is refused, whatever it holds, and so is every tool those skills don't use, including Write, Edit, other MCP servers' tools, Quotient tools another skill uses, and every shell command but setup's own two. Your memories and the replies Claude Code saves stay readable. Setup's check for teammates' fixes, which can't write or run commands, still searches your sessions. When the run ends, these refusals end with it; after that, the transcript of a session that listed teammates' fixes stays refused until you run `/quotient:fix-friction` or `/quotient:list-fixes`.
- **Transcripts of sessions run from a temporary folder**, such as an agent's throwaway test, aren't reviewed or counted: their project folders start with `-private-tmp-`, `-tmp-`, `-var-folders-` or `-private-var-folders-`.

A refused call shows quotient's reason, starting `quotient's sandbox:` or `quotient:`.

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
