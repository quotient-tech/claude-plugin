import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { pluginPointingAt, productionCalls, runEnv } from "../scripts/local-quotient.ts";
import { sandbox } from "./helpers/sandbox.ts";

type Line = Record<string, unknown>;

const COMMITTED_MCP = join(import.meta.dirname, "../plugins/quotient/.mcp.json");

test("the plugin copy names the given Quotient, and the committed .mcp.json keeps production's URL", () => {
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

test("a run gets its own config folder that keeps old transcripts, keeps the token, and turns off claude.ai's servers", () => {
  const { env, configDir } = runEnv({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "token" });
  try {
    assert.equal(env.CLAUDE_CONFIG_DIR, configDir);
    assert.deepEqual(readdirSync(configDir), ["settings.json"]);
    const { cleanupPeriodDays } = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as { cleanupPeriodDays: number };
    const fixtureAgeDays = (Date.now() - Date.parse("2020-01-01")) / 86_400_000;
    assert.ok(cleanupPeriodDays > fixtureAgeDays * 2, "the fixture's 2020 sessions outlive Claude Code's startup cleanup for decades");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "token");
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(env.PATH, "/bin");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("a run refuses to start without a token, since a new config folder isn't signed in", () => {
  assert.throws(() => runEnv({ PATH: "/bin" }), /CLAUDE_CODE_OAUTH_TOKEN/);
  const { root, env } = sandbox();
  try {
    assert.throws(() => runEnv(env), new RegExp(`${env.XDG_CONFIG_HOME}/quotient/check-token`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Saves a token where runEnv looks for one, in a sandbox's config folder.
 * @param env - The sandbox's environment.
 * @param text - The file's text.
 * @param mode - The file's permissions.
 */
function saveToken(env: NodeJS.ProcessEnv, text: string, mode: number): void {
  const folder = join(env.XDG_CONFIG_HOME!, "quotient");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "check-token"), text, { mode });
}

test("without the env var, a run signs in with the token saved in the config folder", () => {
  const { root, env } = sandbox();
  try {
    saveToken(env, "saved-token\n", 0o600);
    const { env: ran, configDir } = runEnv(env);
    rmSync(configDir, { recursive: true, force: true });
    assert.equal(ran.CLAUDE_CODE_OAUTH_TOKEN, "saved-token");
    assert.equal(runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "env-token" }).env.CLAUDE_CODE_OAUTH_TOKEN, "env-token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run refuses a saved token that anyone else can read", () => {
  const { root, env } = sandbox();
  try {
    saveToken(env, "saved-token\n", 0o644);
    assert.throws(() => runEnv(env), /chmod 600/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
