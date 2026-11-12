// Checks the numbers scripts/measure-setup.ts reports for one setup run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureSetup } from "../scripts/measure-setup.ts";

const SESSION = "11111111-1111-1111-1111-111111111111";

/**
 * Builds one assistant request line a quotient skill made.
 * @param requestId - The request's id.
 * @param at - Its timestamp.
 * @param usage - Its token counts.
 * @param options - The skill it's attributed to, and whether a subagent made it.
 * @returns The JSONL line.
 */
function request(
  requestId: string,
  at: string,
  usage: { input: number; write: number; read: number; output: number },
  options: { skill?: string; isSubagent?: boolean; content?: unknown[] } = {},
): string {
  return JSON.stringify({
    type: "assistant",
    attributionPlugin: "quotient",
    attributionSkill: options.skill ?? "quotient:setup",
    requestId,
    sessionId: SESSION,
    timestamp: at,
    isSidechain: options.isSubagent ?? false,
    uuid: `u-${requestId}-${at}`,
    message: {
      model: "claude-opus-5-5",
      content: options.content ?? [],
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.write,
        cache_read_input_tokens: usage.read,
        output_tokens: usage.output,
      },
    },
  });
}

const START = JSON.stringify({
  type: "user",
  sessionId: SESSION,
  timestamp: "2026-11-09T10:00:00.000Z",
  uuid: "u-start",
  message: { content: "<command-message>quotient:setup</command-message>\n<command-name>/quotient:setup</command-name>" },
});

const FINISH_CALL = request("r3", "2026-11-09T10:15:00.000Z", { input: 1, write: 0, read: 100, output: 10 }, {
  content: [{ type: "tool_use", id: "toolu_finish", name: "mcp__plugin_quotient_agex__finish_setup_run", input: { runId: "x" } }],
});

const FINISH_REPLY = JSON.stringify({
  type: "user",
  sessionId: SESSION,
  timestamp: "2026-11-09T10:15:30.000Z",
  uuid: "u-finish",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_finish",
        content: [{ type: "text", text: JSON.stringify({ counts: { high: 2, medium: 3, low: 1, other: 0 }, newCount: 6, alreadyReportedCount: 2 }) }],
      },
    ],
  },
});

const MAIN = {
  path: `/p/${SESSION}.jsonl`,
  text: [
    START,
    request("r1", "2026-11-09T10:00:05.000Z", { input: 10, write: 1000, read: 5000, output: 200 }),
    // The same response written over two lines counts once.
    request("r1", "2026-11-09T10:00:05.000Z", { input: 10, write: 1000, read: 5000, output: 200 }),
    FINISH_CALL,
    FINISH_REPLY,
  ].join("\n"),
};

const REVIEWER = {
  path: `/p/${SESSION}/subagents/agent-a.jsonl`,
  text: request("r2", "2026-11-09T10:05:00.000Z", { input: 5, write: 400, read: 2000, output: 50 }, { isSubagent: true }),
};

const TEAMMATE_CHECK = {
  path: `/p/${SESSION}/subagents/agent-b.jsonl`,
  text: request("r4", "2026-11-09T10:16:00.000Z", { input: 2, write: 100, read: 300, output: 20 }, {
    skill: "quotient:find-solutions",
    isSubagent: true,
  }),
};

test("measure-setup: totals every quotient request across the session and its subagents, each once", () => {
  const measured = measureSetup([MAIN, REVIEWER, TEAMMATE_CHECK]);
  assert.deepEqual(measured.total, { requests: 4, input: 18, cacheWrite: 1500, cacheRead: 7400, output: 280 });
});

test("measure-setup: splits the tokens by skill and by main session or subagent", () => {
  const measured = measureSetup([MAIN, REVIEWER, TEAMMATE_CHECK]);
  assert.deepEqual(measured.bySkill["quotient:find-solutions"], { requests: 1, input: 2, cacheWrite: 100, cacheRead: 300, output: 20 });
  assert.deepEqual(measured.subagents, { requests: 2, input: 7, cacheWrite: 500, cacheRead: 2300, output: 70 });
});

test("measure-setup: wall time runs from the setup command to the last line in any file", () => {
  assert.equal(measureSetup([MAIN, REVIEWER, TEAMMATE_CHECK]).wallSeconds, 16 * 60);
});

test("measure-setup: the run ends at setup_summary's reply, leaving out the session's later work", () => {
  const summaryCall = request("r5", "2026-11-09T10:17:00.000Z", { input: 1, write: 0, read: 10, output: 5 }, {
    content: [{ type: "tool_use", id: "toolu_summary", name: "mcp__quotient__setup_summary", input: {} }],
  });
  const summaryReply = JSON.stringify({
    type: "user",
    sessionId: SESSION,
    timestamp: "2026-11-09T10:17:10.000Z",
    uuid: "u-summary",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_summary", content: "shown" }] },
  });
  const later = request("r6", "2026-11-09T12:00:00.000Z", { input: 9, write: 9, read: 9, output: 9 }, { skill: "quotient:list-fixes" });
  const main = { path: MAIN.path, text: [MAIN.text, summaryCall, summaryReply, later].join("\n") };
  const measured = measureSetup([main, REVIEWER, TEAMMATE_CHECK]);
  assert.equal(measured.wallSeconds, 17 * 60 + 10);
  assert.equal(measured.total.requests, 5);
  assert.equal(measured.bySkill["quotient:list-fixes"], undefined);
});

// Claude Code also writes copies of some lines with no timestamp, and a copy
// can come before the line it copies.
test("measure-setup: the run ends at setup_summary's reply even after an untimed copy of it", () => {
  const summaryCall = request("r5", "2026-11-09T10:17:00.000Z", { input: 1, write: 0, read: 10, output: 5 }, {
    content: [{ type: "tool_use", id: "toolu_summary", name: "mcp__quotient__setup_summary", input: {} }],
  });
  const result = { type: "tool_result", tool_use_id: "toolu_summary", content: "shown" };
  const untimedCopy = JSON.stringify({ type: "tools-used", sessionId: SESSION, message: { content: [result] } });
  const summaryReply = JSON.stringify({
    type: "user",
    sessionId: SESSION,
    timestamp: "2026-11-09T10:17:10.000Z",
    uuid: "u-summary",
    message: { content: [result] },
  });
  const closed = JSON.stringify({ type: "system", sessionId: SESSION, timestamp: "2026-11-09T12:00:00.000Z", uuid: "u-closed" });
  const main = { path: MAIN.path, text: [MAIN.text, summaryCall, untimedCopy, summaryReply, closed].join("\n") };
  assert.equal(measureSetup([main, REVIEWER, TEAMMATE_CHECK]).wallSeconds, 17 * 60 + 10);
});

test("measure-setup: reports finish_setup_run's newCount as the frictions found", () => {
  assert.equal(measureSetup([MAIN, REVIEWER]).newFrictions, 6);
});

test("measure-setup: a run that never finished has no friction count", () => {
  const unfinished = { path: MAIN.path, text: [START, request("r1", "2026-11-09T10:00:05.000Z", { input: 1, write: 1, read: 1, output: 1 })].join("\n") };
  assert.equal(measureSetup([unfinished]).newFrictions, null);
});

/**
 * Builds a `submit_frictions` call and its reply, as two JSONL lines.
 * @param id - The call's tool_use id.
 * @param at - The call's timestamp; the reply comes a second later.
 * @param frictions - The frictions the call sends.
 * @param replies - The reply's entry for each friction, in the same order.
 * @returns The call line and the reply line.
 */
function submitFrictions(
  id: string,
  at: string,
  frictions: Record<string, unknown>[],
  replies: Record<string, unknown>[],
): [string, string] {
  const call = request(`r-${id}`, at, { input: 1, write: 0, read: 1, output: 1 }, {
    content: [{ type: "tool_use", id, name: "mcp__plugin_quotient_agex__submit_frictions", input: { frictions } }],
  });
  const reply = JSON.stringify({
    type: "user",
    sessionId: SESSION,
    timestamp: new Date(Date.parse(at) + 1000).toISOString(),
    uuid: `u-${id}`,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: JSON.stringify({ frictions: replies }) }] }] },
  });
  return [call, reply];
}

const LINT = { title: "Lint fails in CI after passing on commit", impact: "QUALITY", severity: "medium", affectedSessionCount: 2 };
const ZSH = { title: "zsh glob breaks grep", impact: "TIME", severity: "low", affectedSessionCount: 1 };

test("measure-setup: lists each friction as last sent, matching an update to its original by frictionId", () => {
  const first = submitFrictions("toolu_b1", "2026-11-09T10:05:00.000Z", [LINT, ZSH], [
    { status: "new", frictionId: "f-lint" },
    { status: "new", frictionId: "f-zsh" },
  ]);
  const update = submitFrictions("toolu_b2", "2026-11-09T10:10:00.000Z", [
    { ...LINT, title: "Lint passes locally, fails in CI", severity: "high", affectedSessionCount: 3, frictionId: "f-lint" },
  ], [{ status: "updated", frictionId: "f-lint" }]);
  const main = { path: MAIN.path, text: [START, ...first, ...update].join("\n") };
  assert.deepEqual(measureSetup([main]).frictions, [
    { title: "Lint passes locally, fails in CI", impact: "QUALITY", severity: "high", affectedSessionCount: 3 },
    { title: "zsh glob breaks grep", impact: "TIME", severity: "low", affectedSessionCount: 1 },
  ]);
});

test("measure-setup: counts a submit_frictions call once when an untimed copy repeats it", () => {
  const [call, reply] = submitFrictions("toolu_b1", "2026-11-09T10:05:00.000Z", [ZSH], [{ status: "new", frictionId: "f-zsh" }]);
  const untimedCopy = JSON.stringify({ ...JSON.parse(call), timestamp: undefined });
  const main = { path: MAIN.path, text: [START, call, untimedCopy, reply].join("\n") };
  assert.deepEqual(measureSetup([main]).frictions, [ZSH]);
});

test("measure-setup: a friction with no frictionId in its reply is listed by its title", () => {
  const [call, reply] = submitFrictions("toolu_b1", "2026-11-09T10:05:00.000Z", [ZSH], [{ status: "alreadyReported" }]);
  const main = { path: MAIN.path, text: [START, call, reply].join("\n") };
  assert.deepEqual(measureSetup([main]).frictions, [ZSH]);
});

// Setup rewrites a refused field and sends the whole call again; the refused
// call stored nothing, so its friction has no id until the retry.
test("measure-setup: a refused call's friction is replaced by its corrected retry, not listed twice", () => {
  const refused = submitFrictions("toolu_b1", "2026-11-09T10:05:00.000Z", [{ ...ZSH, severity: "medium" }], []);
  const retry = submitFrictions("toolu_b1r", "2026-11-09T10:06:00.000Z", [ZSH], [{ status: "new", frictionId: "f-zsh" }]);
  const main = { path: MAIN.path, text: [START, ...refused, ...retry].join("\n") };
  assert.deepEqual(measureSetup([main]).frictions, [ZSH]);
});

test("measure-setup: lists only the frictions of the run it measures, not a later setup in the same session", () => {
  const measured = submitFrictions("toolu_b1", "2026-11-09T10:05:00.000Z", [ZSH], [{ status: "new", frictionId: "f-zsh" }]);
  const summaryCall = request("r5", "2026-11-09T10:17:00.000Z", { input: 1, write: 0, read: 10, output: 5 }, {
    content: [{ type: "tool_use", id: "toolu_summary", name: "mcp__quotient__setup_summary", input: {} }],
  });
  const summaryReply = JSON.stringify({
    type: "user",
    sessionId: SESSION,
    timestamp: "2026-11-09T10:17:10.000Z",
    uuid: "u-summary",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_summary", content: "shown" }] },
  });
  const laterStart = JSON.stringify({ ...JSON.parse(START), timestamp: "2026-11-09T11:00:00.000Z", uuid: "u-start-2" });
  const later = submitFrictions("toolu_b9", "2026-11-09T11:05:00.000Z", [LINT], [{ status: "new", frictionId: "f-lint" }]);
  const main = { path: MAIN.path, text: [START, ...measured, summaryCall, summaryReply, laterStart, ...later].join("\n") };
  assert.deepEqual(measureSetup([main]).frictions, [ZSH]);
});

test("measure-setup: a run that submitted no frictions lists none", () => {
  assert.deepEqual(measureSetup([MAIN, REVIEWER]).frictions, []);
});

test("measure-setup: refuses a transcript with no /quotient:setup in it", () => {
  const other = { path: "/p/other.jsonl", text: request("r9", "2026-11-09T10:00:05.000Z", { input: 1, write: 1, read: 1, output: 1 }) };
  assert.throws(() => measureSetup([other]), /no \/quotient:setup/);
});
