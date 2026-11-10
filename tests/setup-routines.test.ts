import assert from "node:assert/strict";
import { test } from "node:test";

import { compactRoutines, compactRunLog } from "../plugins/quotient/hooks/digest.ts";

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

test("a run log keeps every event, on one short line each, longest for errors and prompts", () => {
  const log = [
    "(showing the newest 4 events)",
    `[2026-11-08T06:00:01.123456Z] user: Check the nightly build. ${LONG}`,
    `[2026-11-08T06:00:05.000000Z] tool_use Bash: ${LONG}`,
    `[2026-11-08T06:00:09.000000Z] tool_result: ${LONG}`,
    `[2026-11-08T06:00:10.000000Z] tool_result ERROR: npm error 404 Not Found ${LONG}`,
  ].join("\n");
  const compact = compactRunLog(log);
  const lines = compact.split("\n");
  assert.match(lines[0] ?? "", /quotient shortened this log for setup/);
  assert.equal(lines[1], "(showing the newest 4 events)");
  assert.match(lines[2] ?? "", /^\[06:00:01\] user: Check the nightly build\. x{500,}…$/);
  assert.match(lines[5] ?? "", /^\[06:00:10\] tool_result ERROR: npm error 404 Not Found x+…$/);
  assert.ok((lines[4] ?? "").length < 140, `${lines[4]?.length}`);
  assert.ok((lines[5] ?? "").length > (lines[4] ?? "").length);
  assert.ok(compact.length < log.length / 4);
});
