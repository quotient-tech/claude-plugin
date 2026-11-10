import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { digest, DIGEST_BUDGET } from "../plugins/quotient/hooks/digest.ts";
import type { TranscriptLine } from "../plugins/quotient/hooks/digest.ts";
import { FIXTURE_ROOT, PROJECT } from "../scripts/build-setup-fixture.ts";

const ID = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Reads a fixture session as numbered lines.
 * @param n - The session's number.
 * @returns Its lines.
 */
function linesOf(n: number): TranscriptLine[] {
  const text = readFileSync(join(FIXTURE_ROOT, PROJECT, `${ID(n)}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line, i) => ({ n: i + 1, text: line, bytes: Buffer.byteLength(line) }));
}

/**
 * Digests a fixture session.
 * @param n - The session's number.
 * @returns Its digest.
 */
const digestOf = (n: number) => digest(ID(n), linesOf(n));

test("navigation: every search for the shipping rates survives, with what it found", () => {
  const text = digestOf(1);
  assert.match(text, /operator: Where is the shipping rate table configured\?/);
  assert.equal(text.match(/^L\d+ (Grep|Glob) .*→ ok/gm)?.length, 5);
  assert.match(text, /No matches found/);
});

test("automated checks: the CI lint failure survives as an error", () => {
  assert.match(digestOf(2), /Bash \{"command":"gh run watch"\} → ERROR: X lint failed: src\/cart\/discount\.ts:14:7 no-unused-vars/);
});

test("coding standards: the reviewer's clean report and the operator's correction both survive", () => {
  const text = digestOf(5);
  assert.match(text, /Agent \{"subagent_type":"code-reviewer".*→ ok, \d+ chars: No issues found/);
  assert.match(text, /operator: The reviewer missed the console\.log calls/);
});

test("CLAUDE.md: the whole 900-line read survives as a large result", () => {
  assert.match(digestOf(6), /Read \{"file_path":"\/Users\/op\/Development\/acme-shop\/CLAUDE\.md"\} → ok, [\d,]+ chars: .*\(large result\)/);
});

test("tool economy: the log read whole twice survives, marked as a repeat, before the search", () => {
  const text = digestOf(7);
  const reads = text.match(/^L(\d+) Read \{"file_path":"[^"]*import\.log"\}.*\(large result\)/gm) ?? [];
  assert.equal(reads.length, 2);
  assert.match(reads[1] ?? "", /\(repeats L\d+\)/);
  assert.match(text, /Grep .*→ ok, \d+ chars: 3998:ERROR supplier feed timed out/);
});

test("no-ops: both failed verify commands survive", () => {
  const text = digestOf(8);
  assert.match(text, /make verify.*→ ERROR: make: \*\*\* No rule to make target/);
  assert.match(text, /npm run verify.*→ ERROR: npm error Missing script/);
});

test("information access: the agent's request to paste the dev server's output survives", () => {
  assert.match(digestOf(9), /agent: I can't see the dev server's output from here/);
});

test("tool economy: zsh's failed glob survives", () => {
  assert.match(digestOf(10), /--include=\*\.ts src"\} → ERROR: \(eval\):1: no matches found: --include=\*\.ts/);
});

test("automated checks: the nightly run's missing tool survives", () => {
  assert.match(digestOf(14), /npx sitemap-gen"\} → ERROR: npm error 404 Not Found - sitemap-gen/);
});

test("a digest drops thinking, hook context and duplicated results", () => {
  const text = digestOf(7);
  assert.doesNotMatch(text, /Weighing which file to open next/);
  assert.doesNotMatch(text, /Prefer the project's own scripts/);
  assert.doesNotMatch(text, /c2lnbmF0dXJl/);
});

test("every fixture digest fits the budget and is a small share of its transcript", () => {
  let digested = 0;
  let raw = 0;
  for (let n = 1; n <= 14; n += 1) {
    const text = digestOf(n);
    assert.ok(text.length <= DIGEST_BUDGET, `session ${n}: ${text.length} chars`);
    digested += text.length;
    raw += linesOf(n).reduce((sum, line) => sum + line.bytes, 0);
  }
  console.log(`digests are ${((digested / raw) * 100).toFixed(1)}% of the transcripts' size`);
  assert.ok(digested / raw < 0.1);
});

test("over budget, plain tool calls go first, then the agent's text, and the digest says so", () => {
  const lines = linesOf(1);
  const text = digest(ID(1), lines, 900);
  assert.ok(text.length <= 900, `${text.length} chars`);
  assert.match(text, /operator: Where is the shipping rate table configured\?/);
  assert.doesNotMatch(text, /^L\d+ Edit /m);
  assert.match(text, /\(cut to fit: \d+ plain tool calls/);
});

test("a digest that still doesn't fit stops at a line and says which", () => {
  const prompts: TranscriptLine[] = Array.from({ length: 50 }, (_, i) => ({
    n: i + 1,
    text: JSON.stringify({ type: "user", message: { role: "user", content: `Prompt ${i + 1}: ${"x".repeat(300)}` } }),
    bytes: 400,
  }));
  const text = digest("s1", prompts, 2_000);
  assert.ok(text.length <= 2_000, `${text.length} chars`);
  assert.match(text, /\(digest stops at line \d+ of 50\)$/);
});

test("a line too large to read, an interrupt, a refusal and a call with no result are kept", () => {
  const row = (type: string, content: unknown, extra = {}) => JSON.stringify({ type, message: { content }, ...extra });
  const lines: TranscriptLine[] = [
    { n: 1, text: row("user", "Clean up the build folder.") },
    { n: 2, text: row("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf build" } }]) },
    { n: 3, text: row("user", [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Permission to use Bash denied by a hook" }]) },
    { n: 4, text: null, bytes: 5_000_000 },
    { n: 5, text: row("user", [{ type: "text", text: "[Request interrupted by user]" }]) },
    { n: 6, text: row("assistant", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a" } }]) },
  ].map((line) => ({ bytes: 100, ...line }));
  const text = digest("s1", lines);
  assert.match(text, /^L2 Bash \{"command":"rm -rf build"\} → ERROR: Permission to use Bash denied/m);
  assert.match(text, /L4 \(line of 5,000,000 bytes, too large to read\)/);
  assert.match(text, /L5 interrupted: \[Request interrupted by user\]/);
  assert.match(text, /L6 Read \{"file_path":"\/a"\} → no result/);
});
