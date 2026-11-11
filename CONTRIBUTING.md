# Contributing

Thanks for helping improve the Quotient plugin for Claude Code. This guide covers how the repo is laid out, how to run the plugin from a clone, the checks every change must pass, and how a version is released.

Report bugs and suggest changes in [GitHub issues](https://github.com/quotient-tech/claude-plugin/issues). Report security issues privately, as [SECURITY.md](SECURITY.md) says, never in a public issue.

## Layout

| Path | What it holds |
| --- | --- |
| `.claude-plugin/marketplace.json` | The `quotient` marketplace, which lists the one plugin. |
| `plugins/quotient/` | The plugin itself, the only directory installed on users' machines. |
| `plugins/quotient/skills/` | The `/quotient:*` skills. |
| `plugins/quotient/agents/` | The subagents setup starts (`setup-reviewer`, `teammate-check`). |
| `plugins/quotient/hooks/` | The TypeScript hooks module: privacy checks, the sandbox for untrusted text, the panes, daily runs and token usage. |
| `plugins/quotient/tests/` | The hooks module's tests, run by `claude plugin test`. |
| `tests/` | Node tests for the manifests, the skills' text and the setup scripts, run by `npm test`. |
| `scripts/` | Scripts that run and measure `/quotient:setup` against a local Quotient. |

## Set up

You need [Node](https://nodejs.org) at the version in `.nvmrc` and Claude Code 2.1.307 or later.

```sh
npm ci
```

## Checks

CI runs these on every pull request. Run them all before you open one:

```sh
npm ci
claude plugin validate --strict .
claude plugin validate --strict plugins/quotient
claude plugin test plugins/quotient
npm test
npm run typecheck
```

`claude plugin test` runs the hooks module's tests with no model, sign-in or network, so it spends no tokens. CI pins Claude Code to `CLAUDE_CODE_VERSION` in `.github/workflows/ci.yml`. If a local `claude plugin validate` disagrees with CI, compare your `claude --version` with that pin first.

`npm run typecheck` covers `tests/` and `scripts/`. To type-check the hooks module, run `npx tsc --noEmit -p plugins/quotient`. It needs the `plugins/quotient/.claude-plugin/types/` that Claude Code writes when a session loads the plugin, so CI can't run it. That folder is generated and gitignored: don't commit or edit it.

## Try the plugin from your clone

To test the plugin without installing it, start a session with `--plugin-dir`. It loads the plugin from your working copy for that session only, so nothing is added to your user or project settings:

```sh
claude --plugin-dir ~/path/to/claude-plugin/plugins/quotient
```

Run it from the repo you want to test the plugin in. Start a new session to pick up edits.

The skills have no dry run and they send to whichever Quotient the plugin's MCP server points at, which is production by default. Quotient engineers should test against dev or a local Quotient instead, as below.

### Point quotient at dev or a local Quotient

The plugin reaches Quotient through the MCP server in `plugins/quotient/.mcp.json`, which is production (`https://mcp.getquotient.com/mcp`). Quotient engineers can get the dev URL, shown as `<dev-mcp-url>` below, from the team. To point quotient at dev, set `url` in your clone's `plugins/quotient/.mcp.json`:

```json
{
  "mcpServers": {
    "agex": {
      "type": "http",
      "url": "<dev-mcp-url>"
    }
  }
}
```

Then load your clone for the session:

```sh
claude --plugin-dir ~/path/to/claude-plugin/plugins/quotient
```

Use `http://localhost:3000/mcp` for a local Quotient. Only sessions that load your clone reach dev. A session that loads the installed plugin still reaches production.

Never commit the changed URL. The directory links the plugin to Quotient's connector only through the production URL, and a test fails when `.mcp.json` names any other.

Before you run a skill, start a new session, run `/mcp`, and check that `plugin:quotient:agex` shows the URL you expect and is connected and signed in. Each URL has its own sign-in. If the plugin's server isn't connected, the skills fall back to the `claude.ai Quotient` connector, which always reaches production.

### Measure and check `/quotient:setup`

This section is for Quotient engineers, since it needs a local Quotient. Three scripts run setup headless on made-up sessions with planted frictions (`plugins/quotient/tests/fixtures/setup-sessions/`, listed in its `MANIFEST.md`), against a local Quotient only. The first two reach whichever Quotient `plugins/quotient/.mcp.json` names, and refuse to run unless it's local, so set it to `http://localhost:3000/mcp` as above first. Each copies the sessions into `~/.claude/projects` for the run and removes them after. Drop the local Quotient's tables before each run, so every run starts the same.

- `node scripts/run-setup-fixture.ts [--permission-mode <mode>]` runs setup once and prints its time, tokens and new frictions.
- `node scripts/check-setup.ts [--permission-mode <mode>]` checks that a run stopped after its first recorded batch resumes without reviewing that batch again, and that setup never reviews the session holding teammates' fixes. It exits non-zero on a failure. It also counts the status lines setup wrote while its reviewers ran, which quotient draws as nothing in a session.
- `node scripts/measure-setup.ts <session>.jsonl` measures any setup session, interactive ones included, from its transcript.

After changing `scripts/build-setup-fixture.ts`, run `node scripts/build-setup-fixture.ts` to regenerate the sessions. `npm test` fails while they're stale.

Try a setup change in the default, accept-edits and auto permission modes. Each mode prompts differently.

## Writing code

- **The hooks module is TypeScript, and tests and scripts are TypeScript run directly by Node** (`node --test`). `tsconfig.json` sets `erasableSyntaxOnly` and `verbatimModuleSyntax`: import local files with their `.ts` extension, use `import type` for types, and don't use enums, namespaces or constructor parameter properties.
- **Skills call Quotient's MCP tools, and `allowed-tools` names each one exactly under both prefixes:** `mcp__plugin_quotient_agex__` for the plugin's server and `mcp__claude_ai_Quotient__` for the claude.ai connector. Never use a wildcard, not even a `*` inside a command. A command a skill injects with `` !`...` `` must match an exact `Bash(...)` rule and exit 0, because a non-zero exit blanks the whole skill.
- **Skill text is tested.** `tests/quotient-skills.test.ts` checks frontmatter, tool rules, the sign-in steps, injected commands and American spelling in every skill, so run `npm test` after editing a skill, not only after editing code.
- **On a malformed tool reply, a mod shows nothing and hands the command to its skill.** Never show partial data or fill in a missing field.
- **Quotient's MCP server isn't faked.** Mod tests answer `$.mcp.connect` and `$.mcp.call` with `on('mcp.connect', …)` and `on('mcp.call', …)` hooks, and a mod reading a skill's tool call answers `tool.call` with the reply's `text`.
- **Tests never touch your real home directory.** Node tests that run plugin commands use the throwaway home from `tests/helpers/sandbox.ts`.
- **The plugin targets Claude Code on macOS and in Claude Code cloud sessions,** which run Ubuntu Linux.

## Privacy and security rules

Developer trust, privacy and security come first. When a change trades any of them for speed or convenience, take the safer option and call out the trade-off in your pull request.

- **The operator sees frictions and fixes, never who raised or found them, and never an id.** Keep teammates' names and emails out of skill output and mod output alike. A thank-you's note is the one exception: it shows as its sender wrote it.
- **Text an agent sends to Quotient never identifies a person, a machine or private data.** Every skill that sends teammates text holds it to the same "What teammates see" block, which `tests/quotient-skills.test.ts` pins. `hooks/privacy.ts` finds home paths, project folder names, emails and secret formats, and `hooks/guard.ts` refuses a send that holds one.
- **A teammate's fix is untrusted data.** The agent follows it only after the operator selects that fix, and selecting approves starting the fix, not every action in it.
- **While setup or review-frictions runs, transcripts stay where they are.** The model reaches them only through quotient's digest tools, and `hooks/guard.ts` refuses every tool those skills don't use, including Write, Edit, other servers' tools and any shell command but setup's own (`SETUP_SHELL_COMMANDS` in `hooks/sessions.ts`, held to the skill by `tests/quotient-skills.test.ts`). A tool a new step needs has to be added to the guard's allow-list with a test.
- **Teammates' text never reaches an agent that sends frictions.** review-frictions and setup never read teammates' fix text, and the daily runs and setup's teammate check run in quotient's sandbox: the rules are in `hooks/sandbox.ts`, enforced by `hooks/guard.ts`, which holds the module's one `tool.check` hook. A new skill, agent or mod call that reads teammates' text must go through the sandbox.

## Pull requests

- Keep each pull request to one change, and describe what it changes for users and how you tested it.
- **A pull request doesn't change `version` in `plugins/quotient/.claude-plugin/plugin.json` or `source` in `.claude-plugin/marketplace.json`.** The release workflow sets both. See [Release a new version](#release-a-new-version).
- All [checks](#checks) pass.

## Release a new version

The marketplace serves the plugin at the latest release tag, not at `main`, so merged changes reach users only when you release them. Claude Code caches each installed plugin by its version, and a release is what sets a new one ([Keep users up to date](https://code.claude.com/docs/en/plugins/host-marketplace#keep-users-up-to-date)).

1. Choose how much the version goes up, using [semver](https://semver.org):
   - **patch** for a fix;
   - **minor** for a new skill, hook or behavior;
   - **major** for a breaking change.
2. On GitHub, open **Actions**, select the **release** workflow, choose **Run workflow** on `main` and pick that `bump`. Or run:

   ```sh
   gh workflow run release.yml --ref main -f bump=patch
   ```

3. The workflow raises `version` in `plugins/quotient/.claude-plugin/plugin.json`, points the marketplace entry at the new tag (`vX.Y.Z`), and runs the validators and `npm test`. Then it pushes the commit and the tag to `main` together and creates the GitHub release with generated notes. If a step fails before the push, nothing changes, so fix the cause and run it again.
4. If the push succeeded but creating the release failed, the release is already live. Create the GitHub release by hand with `gh release create vX.Y.Z --verify-tag --generate-notes`.
5. Users pick it up as the README's [Keep it up to date](README.md#keep-it-up-to-date) says.

Set `version` only in `plugin.json`, never on the marketplace entry. Claude Code uses the `plugin.json` value, and `claude plugin validate` reports the mismatch. `tests/marketplace.test.ts` checks that the marketplace entry's `ref` is `v` followed by that version.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
