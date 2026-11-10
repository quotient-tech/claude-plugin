import assert from "node:assert/strict";
import { test } from "node:test";

import { recordedSources, reviewedSources, textDuringRun } from "../scripts/check-setup.ts";

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
