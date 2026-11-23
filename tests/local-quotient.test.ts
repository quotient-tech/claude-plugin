import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { assertLocalOnly, type InitMessage, pluginPointingAt, productionCalls, runEnv } from "../scripts/local-quotient.ts";
import { sandbox } from "./helpers/sandbox.ts";

type Line = Record<string, unknown>;

const COMMITTED_MCP = join(import.meta.dirname, "../plugins/quotient/.mcp.json");

test("the plugin copy names the given Quotient, and the committed .mcp.json keeps production's URL", () => {
  const before = readFileSync(COMMITTED_MCP, "utf8");
  const copy = pluginPointingAt("http://127.0.0.1:4321/mcp");
  try {
    const config = JSON.parse(readFileSync(join(copy.dir, ".mcp.json"), "utf8")) as { mcpServers: { agex: { type: string; url: string } } };
    assert.deepEqual(config.mcpServers.agex, { type: "http", url: "http://127.0.0.1:4321/mcp" });
    assert.ok(existsSync(join(copy.dir, "skills/setup/SKILL.md")));
    assert.equal(readFileSync(COMMITTED_MCP, "utf8"), before);
  } finally {
    copy.remove();
  }
});

test("removing the plugin copy leaves no temporary folder behind", () => {
  const copy = pluginPointingAt("http://127.0.0.1:4321/mcp");
  copy.remove();
  assert.ok(!existsSync(dirname(copy.dir)));
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

/**
 * Matches an error whose message names the given text, read literally, so a
 * path's dots and other characters don't act as a pattern.
 * @param text - The text the message must contain.
 * @returns A validator for `assert.throws`.
 */
const messageNaming =
  (text: string) =>
  (error: unknown): boolean =>
    error instanceof Error && error.message.includes(text);

/**
 * Makes the checks' config folder in a sandbox, as the one-time sign-in leaves it.
 * @param env - The sandbox's environment.
 * @returns The folder.
 */
function checksFolder(env: NodeJS.ProcessEnv): string {
  const folder = join(env.XDG_CONFIG_HOME!, "quotient", "claude-checks");
  mkdirSync(join(folder, "plugins"), { recursive: true });
  writeFileSync(join(folder, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
  return folder;
}

/**
 * Saves a token where runEnv looks for one, in a sandbox's config folder.
 * @param env - The sandbox's environment.
 * @param text - The file's text.
 * @param mode - The file's permissions, set after writing so the umask can't narrow them.
 */
function saveToken(env: NodeJS.ProcessEnv, text: string, mode: number): void {
  const folder = join(env.XDG_CONFIG_HOME!, "quotient");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "check-token");
  writeFileSync(file, text);
  chmodSync(file, mode);
}

test("a run uses the checks folder, keeps old transcripts, keeps the token, and turns off claude.ai's servers", () => {
  const { root, env } = sandbox();
  const folder = checksFolder(env);
  const { env: ran, cwd } = runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "token" });
  try {
    assert.equal(ran.CLAUDE_CONFIG_DIR, folder);
    const { cleanupPeriodDays } = JSON.parse(readFileSync(join(folder, "settings.json"), "utf8")) as { cleanupPeriodDays: number };
    const fixtureAgeDays = (Date.now() - Date.parse("2020-01-01")) / 86_400_000;
    assert.ok(cleanupPeriodDays > fixtureAgeDays * 2, "the fixture's 2020 sessions outlive Claude Code's startup cleanup for decades");
    assert.equal(ran.CLAUDE_CODE_OAUTH_TOKEN, "token");
    assert.equal(ran.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(ran.PATH, env.PATH);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run starts in a new empty folder, so no project's settings load plugins into it", () => {
  const { root, env } = sandbox();
  checksFolder(env);
  const first = runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "token" });
  const second = runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "token" });
  try {
    assert.deepEqual(readdirSync(first.cwd), []);
    assert.notEqual(first.cwd, second.cwd);
    assert.ok(!first.cwd.startsWith(join(import.meta.dirname, "..")));
  } finally {
    rmSync(first.cwd, { recursive: true, force: true });
    rmSync(second.cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run empties the checks folder's transcripts and keeps its other files and settings", () => {
  const { root, env } = sandbox();
  const folder = checksFolder(env);
  mkdirSync(join(folder, "projects", "-earlier-run"), { recursive: true });
  writeFileSync(join(folder, "projects", "-earlier-run", "session.jsonl"), "{}\n");
  writeFileSync(join(folder, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(folder, ".claude.json"), "{}");
  const { cwd } = runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "token" });
  try {
    assert.deepEqual(existsSync(join(folder, "projects")) ? readdirSync(join(folder, "projects")) : [], []);
    assert.ok(existsSync(join(folder, ".claude.json")));
    const settings = JSON.parse(readFileSync(join(folder, "settings.json"), "utf8")) as { theme: string; cleanupPeriodDays: number };
    assert.equal(settings.theme, "dark");
    assert.ok(settings.cleanupPeriodDays > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run refuses when the checks folder doesn't exist, since it can't be signed in", () => {
  const { root, env } = sandbox();
  try {
    assert.throws(() => runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "token" }), messageNaming(`${env.XDG_CONFIG_HOME}/quotient/claude-checks`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run refuses a checks folder with an installed plugin, which could reach production", () => {
  const { root, env } = sandbox();
  const folder = checksFolder(env);
  writeFileSync(join(folder, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "quotient@quotient": [{}] } }));
  try {
    assert.throws(() => runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "token" }), /quotient@quotient/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run never uses the operator's own config folder", () => {
  const { root, env } = sandbox();
  const folder = checksFolder(env);
  const { env: ran, cwd } = runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "token", CLAUDE_CONFIG_DIR: "/home/op/.claude" });
  try {
    assert.equal(ran.CLAUDE_CONFIG_DIR, folder);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run refuses to start without a token", () => {
  assert.throws(() => runEnv({ PATH: "/bin" }), /CLAUDE_CODE_OAUTH_TOKEN/);
  const { root, env } = sandbox();
  try {
    assert.throws(() => runEnv(env), messageNaming(`${env.XDG_CONFIG_HOME}/quotient/check-token`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without the env var, a run signs in with the token saved in the config folder", () => {
  const { root, env } = sandbox();
  checksFolder(env);
  saveToken(env, "saved-token\n", 0o600);
  const saved = runEnv(env);
  const fromEnv = runEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "env-token" });
  try {
    assert.equal(saved.env.CLAUDE_CODE_OAUTH_TOKEN, "saved-token");
    assert.equal(fromEnv.env.CLAUDE_CODE_OAUTH_TOKEN, "env-token");
  } finally {
    rmSync(saved.cwd, { recursive: true, force: true });
    rmSync(fromEnv.cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run refuses a saved token that anyone else can read", () => {
  const { root, env } = sandbox();
  checksFolder(env);
  try {
    saveToken(env, "saved-token\n", 0o644);
    assert.throws(() => runEnv(env), /chmod 600/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run that reaches Quotient only through the plugin's server has no production calls", () => {
  assert.deepEqual(productionCalls([[calls("mcp__plugin_quotient_agex__submit_frictions")], []]), []);
});

const COPY = "/tmp/quotient-check-plugin-abc/quotient";
// A headless run's init message as Claude Code wrote it, with the plugin copy
// connected to the local Quotient.
const LOCAL_RUN: InitMessage = {
  type: "system",
  subtype: "init",
  mcp_servers: [
    { name: "plugin:quotient:agex", status: "connected" },
    { name: "quotient", status: "connected" },
  ],
  plugins: [
    { name: "quotient", path: COPY },
    { name: "cc-plugin-agents-md", path: "builtin" },
    { name: "cc-plugin-telemetry", path: "builtin" },
  ],
};

test("a run whose only Quotient is the plugin copy's local server is trusted", () => {
  assert.doesNotThrow(() => assertLocalOnly(LOCAL_RUN, COPY));
});

test("a run is refused when the copy's server didn't connect, as when the folder isn't signed in", () => {
  const failed = { ...LOCAL_RUN, mcp_servers: [{ name: "plugin:quotient:agex", status: "failed" }] };
  assert.throws(() => assertLocalOnly(failed, COPY), /plugin:quotient:agex.*failed/);
  const missing = { ...LOCAL_RUN, mcp_servers: [{ name: "quotient", status: "connected" }] };
  assert.throws(() => assertLocalOnly(missing, COPY), /plugin:quotient:agex/);
});

test("a run is refused when a claude.ai server loaded, since the connector reaches production", () => {
  const withConnector = { ...LOCAL_RUN, mcp_servers: [...LOCAL_RUN.mcp_servers, { name: "claude.ai Quotient", status: "connected" }] };
  assert.throws(() => assertLocalOnly(withConnector, COPY), /claude\.ai Quotient/);
});

test("a run is refused when a plugin other than the copy and the built-in mods loaded", () => {
  const installed = { ...LOCAL_RUN, plugins: [...LOCAL_RUN.plugins, { name: "quotient", path: "/home/op/.claude/plugins/cache/quotient" }] };
  assert.throws(() => assertLocalOnly(installed, COPY), /\/home\/op\/\.claude\/plugins\/cache\/quotient/);
});

test("a run is refused when the copy didn't load, since a missing --plugin-dir starts claude anyway", () => {
  const noCopy = { ...LOCAL_RUN, plugins: LOCAL_RUN.plugins.filter(({ path }) => path === "builtin") };
  assert.throws(() => assertLocalOnly(noCopy, COPY), /copy/);
});
