import assert from "node:assert/strict";
import { test } from "node:test";

import { recordedSources, reviewedSources, textDuringRun, topFailures } from "../scripts/check-setup.ts";

type Line = Record<string, unknown>;

/**
 * A model response holding the given content blocks.
 * @param content - The blocks.
 * @returns The transcript line.
 */
const said = (...content: unknown[]): Line => ({ type: "assistant", message: { content } });

/**
 * A tool's reply.
 * @param id - The call's id.
 * @param isError - Whether it failed or was refused.
 * @returns The transcript line.
 */
const replied = (id: string, isError = false): Line => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...(isError ? { is_error: true } : {}) }] },
});

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

const SUBMIT = "mcp__plugin_quotient_agex__submit_frictions";
const SUMMARY = "mcp__quotient__setup_summary";
const LINT = { title: "Lint fails in CI", description: "Lint passes locally and fails in CI.", severity: "medium", impact: "QUALITY", affectedSessionCount: 4 };
const NODE = { title: "Wrong Node version", description: "The sandbox has an older Node.", severity: "low", impact: "TIME", affectedSessionCount: 2 };

/**
 * A `submit_frictions` call and Quotient's reply to it.
 * @param id - The call's id.
 * @param frictions - The frictions sent.
 * @param statuses - Each friction's reply entry, in order.
 * @returns The transcript lines.
 */
const submitted = (id: string, frictions: object[], statuses: object[]): Line[] => [
  said(use(id, SUBMIT, { runId: "run", frictions })),
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: JSON.stringify({ frictions: statuses }) }] }] } },
];

/**
 * A `setup_summary` call that came back.
 * @param top - Its `top` rows.
 * @returns The transcript lines.
 */
const summarized = (...top: object[]): Line[] => [said(use("sum", SUMMARY, { frictions: top.length, working: [], top, remainingHigh: 0 })), replied("sum")];

/**
 * A summary row showing a friction as it was sent.
 * @param friction - The friction.
 * @returns The row.
 */
const row = (friction: typeof LINT) => ({ severity: friction.severity, description: friction.title, impact: friction.impact, sessions: friction.affectedSessionCount });

test("text the agent writes between the start message and the summary is caught, but not before or after", () => {
  const lines = [
    said({ type: "text", text: "Starting." }),
    said(use("s", "mcp__quotient__setup_start", {})),
    said({ type: "thinking", thinking: "quiet" }),
    said({ type: "text", text: "Reviewing batch 1 now." }),
    said(use("e", "mcp__quotient__setup_summary", {})),
    said({ type: "text", text: "Done." }),
  ];
  assert.deepEqual(textDuringRun(lines), ["Reviewing batch 1 now."]);
});

test("only sources a successful record_setup_progress sent count as recorded", () => {
  const lines = [
    said(use("r1", "mcp__plugin_quotient_agex__record_setup_progress", { runId: "run", sources: ["a", "b"] })),
    replied("r1"),
    said(use("r2", "mcp__plugin_quotient_agex__record_setup_progress", { runId: "run", sources: ["c"] })),
    replied("r2", true),
  ];
  assert.deepEqual(recordedSources(lines), ["a", "b"]);
});

test("a source counts as reviewed when its digest or transcript came back, in any of the run's transcripts", () => {
  const main = [said(use("d1", "mcp__quotient__setup_digest", { source: "s1" })), replied("d1")];
  const reviewer = [
    said(use("d2", "mcp__quotient__setup_digest", { source: "s2" })),
    replied("d2"),
    said(use("d3", "mcp__quotient__setup_digest", { source: "s15" })),
    replied("d3", true),
    said(use("r", "Read", { file_path: "/home/op/.claude/projects/-repo/s3.jsonl" })),
    replied("r"),
    said(use("r2", "Read", { file_path: "/home/op/code/app/notes.md" })),
    replied("r2"),
  ];
  assert.deepEqual(reviewedSources([main, reviewer]).sort(), ["s1", "s2", "s3"]);
});

test("a resumed run's summary passes when each top row shows what was stored, before or after the resume", () => {
  const first = submitted("f1", [LINT], [{ status: "new", frictionId: "lint" }]);
  const second = [...submitted("f2", [NODE], [{ status: "new", frictionId: "node" }]), ...summarized(row(LINT), row(NODE))];
  assert.deepEqual(topFailures(first, second), []);
});

test("a top row that differs from the stored friction fails, naming the field", () => {
  const first = submitted("f1", [LINT], [{ status: "new", frictionId: "lint" }]);
  const second = summarized({ ...row(LINT), severity: "high", sessions: 1 });
  assert.deepEqual(topFailures(first, second), [
    `the summary shows severity high for "${LINT.title}", where Quotient stored medium`,
    `the summary shows sessions 1 for "${LINT.title}", where Quotient stored 4`,
  ]);
});

test("a friction with no title is matched by its description", () => {
  const untitled = { ...LINT, title: undefined };
  const first = submitted("f1", [untitled], [{ status: "new", frictionId: "lint" }]);
  const second = summarized({ ...row(LINT), description: LINT.description });
  assert.deepEqual(topFailures(first, second), []);
});

test("the last values sent for a friction are the stored ones, across both runs", () => {
  const first = [
    ...submitted("f1", [LINT, NODE], [{ status: "new", frictionId: "lint" }, { status: "new", frictionId: "node" }]),
  ];
  const updated = { ...LINT, severity: "high", affectedSessionCount: 6 };
  const second = [...submitted("f2", [{ ...updated, frictionId: "lint" }], [{ status: "updated", frictionId: "lint" }]), ...summarized(row(updated), row(NODE))];
  assert.deepEqual(topFailures(first, second), []);
});

test("a refused friction or a failed call stores nothing", () => {
  const first = [
    ...submitted("f1", [LINT], [{ status: "refused", reason: "too vague" }]),
    said(use("f2", SUBMIT, { runId: "run", frictions: [NODE] })),
    replied("f2", true),
  ];
  const second = summarized(row(LINT));
  assert.deepEqual(topFailures(first, second), [
    `the summary's top row "${LINT.title}" matches no friction the runs stored`,
    "no friction found before the resume reached the summary's top rows, so their stored values weren't checked",
  ]);
});

test("a summary whose top rows were all sent after the resume says the resume wasn't checked", () => {
  const first = submitted("f1", [LINT], [{ status: "new", frictionId: "lint" }]);
  const second = [...submitted("f2", [NODE], [{ status: "new", frictionId: "node" }]), ...summarized(row(NODE))];
  assert.deepEqual(topFailures(first, second), ["no friction found before the resume reached the summary's top rows, so their stored values weren't checked"]);
});
