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
