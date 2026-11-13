import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { pluginPointingAt, productionCalls, runEnv, startStandIn } from "../scripts/stand-in-quotient.ts";

type Line = Record<string, unknown>;

const COMMITTED_MCP = join(import.meta.dirname, "../plugins/quotient/.mcp.json");

/**
 * Sends one JSON-RPC message to the stand-in, as Claude Code's HTTP client does.
 * @param url - The stand-in's MCP URL.
 * @param body - The message.
 * @returns The HTTP status, and the parsed reply when there is one.
 */
async function post(url: string, body: Record<string, unknown>): Promise<{ status: number; reply: Record<string, unknown> | undefined }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  const text = await response.text();
  return { status: response.status, reply: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>) };
}

test("the stand-in listens on loopback and answers initialize with the client's protocol version", async () => {
  const standIn = await startStandIn();
  try {
    assert.match(standIn.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const { reply } = await post(standIn.url, { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const result = reply?.result as { protocolVersion: string; capabilities: { tools: unknown } };
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.ok(result.capabilities.tools);
  } finally {
    await standIn.close();
  }
});

test("the stand-in accepts a notification without a reply, and lists its tools", async () => {
  const standIn = await startStandIn();
  try {
    assert.deepEqual(await post(standIn.url, { method: "notifications/initialized" }), { status: 202, reply: undefined });
    const { reply } = await post(standIn.url, { id: 2, method: "tools/list" });
    assert.ok(Array.isArray((reply?.result as { tools: unknown }).tools));
  } finally {
    await standIn.close();
  }
});

test("a call to a tool the stand-in doesn't serve gets an error naming it, and is logged", async () => {
  const standIn = await startStandIn();
  try {
    const { reply } = await post(standIn.url, { id: 3, method: "tools/call", params: { name: "drop_everything", arguments: { all: true } } });
    assert.match(String((reply?.error as { message: string }).message), /drop_everything/);
    assert.deepEqual(standIn.calls(), [{ tool: "drop_everything", args: { all: true } }]);
  } finally {
    await standIn.close();
  }
});

/**
 * Calls one of the stand-in's tools.
 * @param url - The stand-in's MCP URL.
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns The reply's text, parsed when it's JSON, and whether it's an error.
 */
async function callTool(url: string, name: string, args: Record<string, unknown> = {}): Promise<{ body: any; isError: boolean }> {
  const { reply } = await post(url, { id: 9, method: "tools/call", params: { name, arguments: args } });
  const result = reply?.result as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]!.text;
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { body, isError: result.isError === true };
}

const SETUP_FRICTION = { description: "Tests ran twice", frequency: "3 of 14 sessions", impact: "time", severity: "low", tags: [], origin: "setup" };

test("a second start_setup_run resumes the open run with the sources and frictions it recorded", async () => {
  const standIn = await startStandIn();
  try {
    const { body: first } = await callTool(standIn.url, "start_setup_run");
    assert.deepEqual(first.reviewedSources, []);
    assert.deepEqual(first.frictionsInRun, []);
    assert.equal(first.nextCursor, null);
    assert.equal(first.joinedCompany, null);
    assert.equal(typeof first.startedAt, "string");
    const { body: submitted } = await callTool(standIn.url, "submit_frictions", { frictions: [{ ...SETUP_FRICTION, runId: first.runId }] });
    const recorded = await callTool(standIn.url, "record_setup_progress", { runId: first.runId, sources: ["a", "b", "a"] });
    assert.deepEqual(recorded, { body: { reviewedSourceCount: 2 }, isError: false });
    const { body: resumed } = await callTool(standIn.url, "start_setup_run");
    assert.equal(resumed.runId, first.runId);
    assert.deepEqual(resumed.reviewedSources, ["a", "b"]);
    assert.deepEqual(resumed.frictionsInRun, [{ id: submitted.frictions[0].frictionId, description: "Tests ran twice" }]);
  } finally {
    await standIn.close();
  }
});

test("submit_frictions gives each friction a new id in order, updates one sent with its id, and every id is bait", async () => {
  const standIn = await startStandIn();
  try {
    const { body: run } = await callTool(standIn.url, "start_setup_run");
    const { body } = await callTool(standIn.url, "submit_frictions", {
      frictions: [{ ...SETUP_FRICTION, runId: run.runId }, { ...SETUP_FRICTION, description: "Lint was skipped", runId: run.runId }],
    });
    assert.deepEqual(body.frictions.map((f: { status: string }) => f.status), ["new", "new"]);
    const [first, second] = body.frictions.map((f: { frictionId: string }) => f.frictionId);
    assert.notEqual(first, second);
    const { body: again } = await callTool(standIn.url, "submit_frictions", { frictions: [{ ...SETUP_FRICTION, frictionId: first, runId: run.runId }] });
    assert.deepEqual(again.frictions, [{ status: "updated", frictionId: first }]);
    const ids = standIn.bait().ids;
    for (const id of [run.runId, first, second, ...run.reportedFrictions.map((f: { id: string }) => f.id)]) assert.ok(ids.includes(id), `${id} is bait`);
    assert.ok(run.reportedFrictions.length > 0, "the operator has earlier frictions for setup to leave out");
  } finally {
    await standIn.close();
  }
});

test("finish_setup_run counts the run's frictions, and a finished run takes no more progress", async () => {
  const standIn = await startStandIn();
  try {
    const { body: run } = await callTool(standIn.url, "start_setup_run");
    await callTool(standIn.url, "submit_frictions", { frictions: [{ ...SETUP_FRICTION, severity: "high", runId: run.runId }, { ...SETUP_FRICTION, description: "x", runId: run.runId }] });
    const finished = await callTool(standIn.url, "finish_setup_run", { runId: run.runId });
    assert.deepEqual(finished, { body: { counts: { high: 1, medium: 0, low: 1, other: 0 }, newCount: 2, alreadyReportedCount: 0 }, isError: false });
    const refused = await callTool(standIn.url, "record_setup_progress", { runId: run.runId, sources: ["c"] });
    assert.equal(refused.isError, true);
    assert.match(refused.body, new RegExp(`no unfinished setup run with the id ${run.runId}`));
    const { body: next } = await callTool(standIn.url, "start_setup_run");
    assert.notEqual(next.runId, run.runId);
  } finally {
    await standIn.close();
  }
});

test("submit_frictions to a run that isn't open refuses each friction, and the whole call when all are refused", async () => {
  const standIn = await startStandIn();
  try {
    const { body, isError } = await callTool(standIn.url, "submit_frictions", { frictions: [{ ...SETUP_FRICTION, runId: "nope" }] });
    assert.equal(isError, true);
    assert.match(body, /^None of these frictions was recorded\. \{"frictions":\[\{"status":"refused","reason":"You have no unfinished setup run/);
  } finally {
    await standIn.close();
  }
});

test("teammates' frictions carry the planted names and emails in their descriptions only, and turn setup's teammate check on", async () => {
  const standIn = await startStandIn();
  try {
    const { body, isError } = await callTool(standIn.url, "list_teammate_frictions");
    assert.equal(isError, false);
    assert.equal(body.nextCursor, null);
    const { ids, names, emails } = standIn.bait();
    assert.ok(names.length > 0 && emails.length > 0);
    // The mod's teammateTitlesFrom keeps each friction with a string id and a
    // non-empty title; with none kept, setup skips its teammate check.
    for (const friction of body.frictions) {
      assert.ok(ids.includes(friction.id));
      assert.ok(typeof friction.title === "string" && friction.title.trim() !== "");
      for (const planted of [...names, ...emails]) assert.ok(!friction.title.includes(planted), "the mod draws titles itself, so they hold no bait");
    }
    const descriptions = body.frictions.map((f: { description: string }) => f.description).join("\n");
    for (const planted of [...names, ...emails]) assert.ok(descriptions.includes(planted), `${planted} is planted`);
  } finally {
    await standIn.close();
  }
});

test("submit_solutions records each answer once, and refuses one to a friction nobody raised", async () => {
  const standIn = await startStandIn();
  try {
    const { body: listed } = await callTool(standIn.url, "list_teammate_frictions");
    const [first, second] = listed.frictions.map((f: { id: string }) => f.id);
    const { body } = await callTool(standIn.url, "submit_solutions", {
      answers: [{ frictionId: first, description: "Add a test filter" }, { frictionId: second }, { frictionId: "nope" }],
      source: "local",
    });
    assert.deepEqual(body.answers, [
      { frictionId: first, status: "recorded" },
      { frictionId: second, status: "recorded" },
      { frictionId: "nope", status: "refused", reason: "No friction you or a teammate raised has this id." },
    ]);
    const { body: again } = await callTool(standIn.url, "submit_solutions", { answers: [{ frictionId: first }], source: "local" });
    assert.deepEqual(again.answers, [{ frictionId: first, status: "alreadyRecorded" }]);
    const refused = await callTool(standIn.url, "submit_solutions", { answers: [{ frictionId: "nope" }], source: "local" });
    assert.equal(refused.isError, true);
    assert.match(refused.body, /^None of these answers was recorded\. /);
  } finally {
    await standIn.close();
  }
});

test("submit_solution records one answer, and refuses an id nobody raised", async () => {
  const standIn = await startStandIn();
  try {
    const { body: listed } = await callTool(standIn.url, "list_teammate_frictions");
    assert.deepEqual(await callTool(standIn.url, "submit_solution", { frictionId: listed.frictions[0].id, source: "local" }), { body: { status: "recorded" }, isError: false });
    const refused = await callTool(standIn.url, "submit_solution", { frictionId: "nope", source: "local" });
    assert.deepEqual(refused, { body: "No friction you or a teammate raised has the id nope. Nothing was recorded.", isError: true });
  } finally {
    await standIn.close();
  }
});

test("the plugin copy names the stand-in, and the committed .mcp.json keeps production's URL", () => {
  const before = readFileSync(COMMITTED_MCP, "utf8");
  const copy = pluginPointingAt("http://127.0.0.1:4321/mcp");
  try {
    const config = JSON.parse(readFileSync(join(copy, ".mcp.json"), "utf8")) as { mcpServers: { agex: { type: string; url: string } } };
    assert.deepEqual(config.mcpServers.agex, { type: "http", url: "http://127.0.0.1:4321/mcp" });
    assert.ok(existsSync(join(copy, "skills/setup/SKILL.md")));
    assert.equal(readFileSync(COMMITTED_MCP, "utf8"), before);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("the plugin copy refuses any URL that isn't on this machine", () => {
  assert.throws(() => pluginPointingAt("https://mcp.getquotient.com/mcp"), /local/);
  assert.throws(() => pluginPointingAt("http://127.0.0.1.example.com/mcp"), /local/);
});

/**
 * A model response that calls one tool.
 * @param name - The tool's name.
 * @returns The transcript line.
 */
const calls = (name: string): Line => ({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input: {} }] } });

test("a call to the claude.ai Quotient connector is found in any of the run's transcripts", () => {
  const main = [calls("mcp__plugin_quotient_agex__start_setup_run"), calls("Read")];
  const reviewer = [calls("mcp__claude_ai_Quotient__list_teammate_frictions")];
  assert.deepEqual(productionCalls([main, reviewer]), ["mcp__claude_ai_Quotient__list_teammate_frictions"]);
});

test("a run gets its own empty config folder, keeps the token, and turns off claude.ai's servers", () => {
  const { env, configDir } = runEnv({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "token" });
  try {
    assert.equal(env.CLAUDE_CONFIG_DIR, configDir);
    assert.deepEqual(readdirSync(configDir), []);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "token");
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(env.PATH, "/bin");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("a run refuses to start without a token, since a new config folder isn't signed in", () => {
  assert.throws(() => runEnv({ PATH: "/bin" }), /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("a run never reuses the operator's config folder", () => {
  const { configDir } = runEnv({ CLAUDE_CODE_OAUTH_TOKEN: "token", CLAUDE_CONFIG_DIR: "/home/op/.claude" });
  try {
    assert.notEqual(configDir, "/home/op/.claude");
    assert.ok(existsSync(configDir));
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("a run that reaches Quotient only through the plugin's server has no production calls", () => {
  assert.deepEqual(productionCalls([[calls("mcp__plugin_quotient_agex__submit_frictions")], []]), []);
});
