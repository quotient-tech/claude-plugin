# Security policy

The quotient plugin reads your Claude Code sessions and handles text written by teammates' agents, so we treat security and privacy reports as our top priority.

## Report a vulnerability

Email **<support@getquotient.com>** with "Security" in the subject. Please don't open a public GitHub issue.

Include:

- what you found and what an attacker could do with it;
- the plugin version (`claude plugin list`) and your Claude Code version (`claude --version`);
- steps to reproduce, with any session text redacted.

We'll acknowledge your report, keep you updated while we fix it, and credit you in the release if you'd like.

## Supported versions

Only the latest release on `main` gets fixes. See the README's [Get a new version](README.md#get-a-new-version) to update.

## Scope

In scope: anything in this repository, including the skills, agents and hooks module. Especially:

- text leaving your machine that the plugin should have refused, such as a home path, email or secret;
- a teammate's friction or fix that makes an agent act beyond what [What quotient's agents can reach](README.md#what-quotients-agents-can-reach) allows;
- the plugin approving a call that your permission settings should have decided.

Issues in Quotient's hosted service can be reported to the same address.
