# Setup's synthetic sessions

Fifteen made-up Claude Code sessions in one project, `-fixture-quotient-setup-acme-shop`, for measuring and checking `/quotient:setup`. `scripts/build-setup-fixture.ts` writes them. Don't edit the `.jsonl` files by hand: change the generator and run `node scripts/build-setup-fixture.ts`. `tests/setup-fixture.test.ts` fails when they drift apart.

They're dated January 2020, so a run with `QUOTIENT_SETUP_WINDOW_END=2020-01-15` and their files' modification times set to those days reviews them and nothing else.

## Planted frictions

A good run reports each of these. "Agent Experiences" names the category in setup's skill.

| # | Friction | Agent Experiences | Sessions |
|---|---|---|---|
| 1 | Shipping rates live outside `src/`, with no pointer to them, so the agent searched five times | Navigation | a0000000-0000-4000-8000-000000000001 |
| 2 | Lint passes on commit but fails in CI: no pre-commit check | Automated checks | a0000000-0000-4000-8000-000000000002, a0000000-0000-4000-8000-000000000003, a0000000-0000-4000-8000-000000000004 |
| 3 | The code reviewer misses banned `console.log` calls | Coding standards | a0000000-0000-4000-8000-000000000005 |
| 4 | CLAUDE.md is 900 lines, read whole for a one-line change | Global AGENTS.md/CLAUDE.md | a0000000-0000-4000-8000-000000000006 |
| 5 | A 4,000-line log read whole, twice, before searching it | Tool economy | a0000000-0000-4000-8000-000000000007 |
| 6 | CLAUDE.md says to run `make verify`, which doesn't exist | No-ops | a0000000-0000-4000-8000-000000000008 |
| 7 | The agent can't see the dev server's output and asks the operator to paste it | Information access | a0000000-0000-4000-8000-000000000009 |
| 8 | zsh expands an unquoted `--include=*.ts`, so grep fails | Tool economy | a0000000-0000-4000-8000-000000000010, a0000000-0000-4000-8000-000000000011 |
| 9 | The nightly sitemap run needs a tool that isn't installed | Automated checks | a0000000-0000-4000-8000-000000000014 (automated run) |

## Sessions with no friction

- a0000000-0000-4000-8000-000000000012: the typecheck caught a rename's misses (something that worked well).
- a0000000-0000-4000-8000-000000000013: a one-line edit.

## A session setup must never read

a0000000-0000-4000-8000-000000000015 called `list_teammate_frictions`, so it holds teammates' text. quotient refuses reading it, and setup skips it. A run that reports anything from it has broken that rule.

## Counts

`setup_start` counts 14 sessions and 1 automated run: it counts files, and reads none. Setup reviews 13 sessions and the automated run. Reading the 15th is refused, so setup skips it.
