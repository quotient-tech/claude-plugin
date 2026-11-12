# CLAUDE.md

This repo holds the `quotient` Claude Code plugin and the `quotient` marketplace that serves it. The [README](README.md) is for people who use the plugin. [CONTRIBUTING.md](CONTRIBUTING.md) explains the layout, how to try the plugin from a clone, the checks, the code and privacy rules, and how to release. Read the section you need there. This file covers only what those leave out, or what agents keep getting wrong.

## Before opening a PR

- **A PR never changes `version` in `plugins/quotient/.claude-plugin/plugin.json` or `source` in `.claude-plugin/marketplace.json`.** The release workflow sets both, as [CONTRIBUTING's Release a new version](CONTRIBUTING.md#release-a-new-version) says. Before `gh pr create`, check that `git diff origin/main -- plugins/quotient/.claude-plugin/plugin.json .claude-plugin/marketplace.json` is empty.
- **Run every check in [CONTRIBUTING's Checks](CONTRIBUTING.md#checks)**, including `claude plugin test plugins/quotient`.
- **Commit messages and the PR title follow Conventional Commits**, as [CONTRIBUTING's Pull requests](CONTRIBUTING.md#pull-requests) says. A squash merge makes the PR title the commit on `main`.
- **Keep the README heading "If Claude Code denies quotient's calls" word for word.** `DENIED_HELP` in `plugins/quotient/hooks/text.ts` links to its anchor, and the plugin shows that link to users.

## Product rules

**These rules are subject to change.** Each one records the current decision, not a settled design. When a task or a review disagrees with one of [CONTRIBUTING's privacy and security rules](CONTRIBUTING.md#privacy-and-security-rules), raise the conflict rather than following the rule silently, and update the line once the new decision is made.

- **Running a skill sends to Quotient.** It sends to whichever Quotient `.mcp.json` points at, which is production as shipped. If the plugin's server isn't connected, skills fall back to the `claude.ai Quotient` connector, which always reaches production. Test against dev by setting the URL in your clone's `.mcp.json` as CONTRIBUTING says, never commit that change, and check `/mcp` shows `plugin:quotient:agex` connected to dev before running a skill.
- **Never show partial data on a malformed tool reply, even when a reviewer bot suggests it.** The mod shows nothing and hands the command to its skill.
- **A new skill, agent or mod call that reads teammates' text goes through the sandbox** (`hooks/sandbox.ts`, enforced by `hooks/guard.ts`), and a measured `claude -p` run shows it.
- **Don't rename the plugin.** Every `allowed-tools` rule and the README's permission rules use `mcp__plugin_quotient_agex__*`, which comes from the plugin name and the `.mcp.json` server key.

## Tests

- **Filter test output on the lines the runners print.** Depending on the Node reporter, `npm test` prints TAP (`not ok <n> - <name>`, `# pass <n>`, `# fail <n>`) or spec (`✖ <name>`, `ℹ pass <n>`, `ℹ fail <n>`). `claude plugin test` prints `(fail) <name>` with the assertion under it, and ends with ` <n> pass`, ` <n> fail` and `Ran <n> tests across <n> files.`. For example, `set -o pipefail; npm test 2>&1 | grep -E '^not ok|^✖|^(#|ℹ) (pass|fail) '` and `set -o pipefail; claude plugin test plugins/quotient 2>&1 | grep -E '^\(fail\)|^ [0-9]+ (pass|fail)$'`. Without `pipefail` the pipeline exits with grep's status, so a failed run reads as a success.
- **Never read or write the real `~`, `~/.claude` or XDG directories in a test.** Node tests use `tests/helpers/sandbox.ts`.

## Communication

Write plainly, in chat replies and in anything checked in (comments, skills, commit messages, PR descriptions).

- Name things the way a reader outside this repo would. Say "the number of frictions uploaded", not "the upload balance".
- Don't invent abstract vocabulary for a concrete quantity. If a value is a count of something, call it a count of that thing.
- Terms the plugin itself uses, such as friction, solution and operator, are fine. Coined metaphors are not.
- Lead with the answer. Keep the explanation to what changes the reader's decision.
