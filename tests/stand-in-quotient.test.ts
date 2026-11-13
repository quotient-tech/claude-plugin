import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { test } from "node:test";

import { productionCalls, runEnv } from "../scripts/stand-in-quotient.ts";

type Line = Record<string, unknown>;

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
