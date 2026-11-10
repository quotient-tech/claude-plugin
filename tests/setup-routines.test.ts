import assert from "node:assert/strict";
import { test } from "node:test";

import { compactRoutines, DIGEST_BUDGET, runLogDigest } from "../plugins/quotient/hooks/digest.ts";

const LONG = "x".repeat(5_000);

/**
 * A made-up routine as RemoteTrigger's `list` and `get` return it, with the bulky fields setup never reads.
 * @param n - Its number.
 * @returns The routine.
 */
const routine = (n: number) => ({
  id: `trig_0000000000${n}`,
  name: `Nightly check ${n}`,
  cron_expression: "0 6 * * *",
  enabled: true,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  last_run: { status: "failed", failure_reason: "connector unauthorized", finished_at: "2026-11-08T06:10:00Z", session_id: "session_01" },
  mcp_connections: [{ name: "Linear", connector_uuid: "u-1", clear_tool_policy_overrides: false }],
  derived_state: { prompt: `Check the nightly build. ${LONG}`, files: [], folders: [] },
  job_config: { ccr: { environment_id: "env", events: { big: LONG }, session_context: { big: LONG } } },
  session_request: { big: LONG },
});

test("a routine list keeps what setup reads, and drops the job config and session request", () => {
  const json = JSON.stringify({ data: [routine(1), routine(2)], has_more: false });
  const compact = compactRoutines(json);
  assert.ok(compact !== null);
  const parsed = JSON.parse(compact);
  assert.equal(parsed.has_more, false);
  assert.deepEqual(Object.keys(parsed.data[0]).sort(), ["created_at", "cron_expression", "enabled", "id", "last_run", "mcp_connections", "name", "prompt", "updated_at"]);
  assert.equal(parsed.data[0].id, "trig_00000000001");
  assert.deepEqual(parsed.data[0].mcp_connections, ["Linear"]);
  assert.equal(parsed.data[0].last_run.failure_reason, "connector unauthorized");
  assert.match(parsed.data[0].prompt, /^Check the nightly build\. x+… \(prompt cut at 600 of 5,025 characters; RemoteTrigger get has it whole\)$/);
  assert.ok(compact.length < json.length / 10, `${compact.length} of ${json.length}`);
  assert.match(parsed.note, /quotient shortened this reply for setup/);
});

test("one routine, as get returns it, keeps a longer prompt", () => {
  const compact = compactRoutines(JSON.stringify(routine(1)));
  assert.ok(compact !== null);
  const parsed = JSON.parse(compact);
  assert.equal(parsed.id, "trig_00000000001");
  assert.equal(parsed.prompt.length, 5_025);
});

test("a reply that isn't a routine or a list of them is left alone", () => {
  assert.equal(compactRoutines("not json"), null);
  assert.equal(compactRoutines(JSON.stringify({ data: "nope" })), null);
  assert.equal(compactRoutines(JSON.stringify({ note: "x", trigger_id: "trig_1", data: [{ id: "run_1", title: "t" }] })), null);
});

/**
 * A made-up `get_run_log` summary line.
 * @param second - Its second past 06:00, from 0.
 * @param kind - Its kind, such as `user` or `tool_result ERROR`.
 * @param text - Its text.
 * @returns The line.
 */
const event = (second: number, kind: string, text: string) =>
  `[2026-11-08T06:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000000Z] ${kind}: ${text}`;

test("a short run log keeps every event, each numbered, with no cut note", () => {
  const log = [
    "(showing the newest 3 events)",
    event(1, "user", "Check the nightly build."),
    event(2, "assistant", "Running the build now."),
    event(3, "result", "Build passed."),
  ].join("\n");
  const lines = runLogDigest(log).split("\n");
  assert.match(lines[0] ?? "", /quotient digested this log for setup/);
  assert.equal(lines[1], "(showing the newest 3 events)");
  assert.equal(lines[2], "E1 [06:00:01] user: Check the nightly build.");
  assert.equal(lines[3], "E2 [06:00:02] assistant: Running the build now.");
  assert.equal(lines[4], "E3 [06:00:03] result: Build passed.");
  assert.equal(lines.length, 5);
});

test("a full 200-event page fits the budget, keeping every error, prompt and result", () => {
  const events = [event(0, "user", `Check the nightly build. ${LONG}`)];
  for (let i = 1; i < 199; i++) {
    if (i % 50 === 0) events.push(event(i, "tool_result ERROR", `npm error 404 Not Found at step ${i} ${LONG}`));
    else if (i % 2 === 1) events.push(event(i, `tool_use Read`, `{"file_path":"/repo/src/file${i}.ts"} ${LONG}`));
    else events.push(event(i, "tool_result", LONG));
  }
  events.push(event(199, "result", `Build failed. ${LONG}`));
  const log = events.join("\n");
  const digested = runLogDigest(log);
  assert.ok(digested.length <= DIGEST_BUDGET, `${digested.length}`);
  for (const step of [50, 100, 150]) assert.match(digested, new RegExp(`E${step + 1} \\[[^\\]]+\\] tool_result ERROR: npm error 404 Not Found at step ${step}`));
  assert.match(digested, /E1 \[06:00:00\] user: Check the nightly build\./);
  assert.match(digested, /E200 \[06:03:19\] result: Build failed\./);
  assert.match(digested, /\(cut to fit: \d+ plain tool calls\)/);
});

test("plain tool events go before the agent's text when a log runs over budget", () => {
  const log = [
    event(1, "assistant", "I'll look at the failing test."),
    ...Array.from({ length: 40 }, (_, i) => event(i + 2, "tool_result", LONG)),
  ].join("\n");
  const digested = runLogDigest(log, 2_000);
  assert.match(digested, /E1 \[06:00:01\] assistant: I'll look at the failing test\./);
  assert.match(digested, /\(cut to fit: 40 plain tool calls\)$/);
});

test("a tool call that repeats an earlier one is marked and kept over budget", () => {
  const log = [
    event(1, "tool_use Bash", '{"command":"npm test"}'),
    event(2, "tool_result", "1 failing"),
    event(3, "tool_use Bash", '{"command":"npm test"}'),
    ...Array.from({ length: 40 }, (_, i) => event(i + 4, "tool_result", LONG)),
  ].join("\n");
  const digested = runLogDigest(log, 2_000);
  assert.match(digested, /E3 \[06:00:03\] tool_use Bash: \{"command":"npm test"\} \(repeats E1\)/);
  assert.doesNotMatch(digested, /^E1 /m);
});
