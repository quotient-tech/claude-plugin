// What the behavior checks need to run quotient's skills against a local
// Quotient: a plugin copy that reaches it, the environment a run starts in,
// and a check that no call went to production.
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalQuotient, PLUGIN } from "./run-setup-fixture.ts";

type Line = Record<string, unknown>;

/**
 * Copies quotient's plugin to a new folder whose .mcp.json names the given
 * Quotient, so the committed .mcp.json keeps production's URL.
 * @param url - The Quotient MCP URL the copy reaches.
 * @returns The copy's folder, to pass to `--plugin-dir`, and `remove`, which
 *   the caller calls to delete the copy and the temporary folder that holds it.
 * @throws When the URL isn't on this machine.
 */
export function pluginPointingAt(url: string): { dir: string; remove: () => void } {
  if (!isLocalQuotient(url)) throw new Error(`the plugin copy reaches only a local Quotient, not ${url}`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-plugin-")));
  const dir = join(root, "quotient");
  cpSync(PLUGIN, dir, { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify({ mcpServers: { agex: { type: "http", url } } }, null, 2)}\n`);
  return { dir, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * The environment a check runs `claude` in. It uses the checks' own config
 * folder, signed in once to the local Quotient, so no installed quotient
 * plugin reaches production beside the copy under test. Its Quotient sign-in
 * is kept where files can't show it, so whether it holds one shows only in a
 * run's init message. The token from `claude setup-token` signs in to Claude
 * itself, and the env var turns claude.ai's servers off.
 * @param base - The environment to start from, usually `process.env`.
 * @returns The run's environment, its config folder, and a new empty folder to
 *   start `claude` in, which the caller removes.
 * @throws When there's no token or its saved file is readable by others, or the
 *   checks folder is missing or has an installed plugin.
 */
export function runEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; configDir: string; cwd: string } {
  const token = base.CLAUDE_CODE_OAUTH_TOKEN || savedToken(base);
  const configDir = join(configHome(base), "quotient", "claude-checks");
  if (!existsSync(configDir)) throw new Error(`no checks folder at ${configDir}: sign in to the local Quotient there once first`);
  const installed = installedPlugins(configDir);
  if (installed.length > 0) throw new Error(`${configDir} has installed plugins, which could reach production: ${installed.join(", ")}`);
  // Claude Code deletes transcripts older than cleanupPeriodDays (30 unless
  // set) in the background as it starts, which would take the fixture's
  // dated sessions before setup lists them.
  const settingsFile = join(configDir, "settings.json");
  const settings = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(settingsFile, `${JSON.stringify({ ...settings, cleanupPeriodDays: 100_000 }, null, 2)}\n`);
  // An earlier run's transcripts would be reviewed as the operator's sessions.
  rmSync(join(configDir, "projects"), { recursive: true, force: true });
  // A project's .claude/settings.json can turn plugins on, so start where there is none.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-cwd-")));
  return { env: { ...base, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: configDir, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, configDir, cwd };
}

/**
 * The folder that holds the checks' token and config folder.
 * @param base - The environment to read it from.
 * @returns `$XDG_CONFIG_HOME`, or `~/.config`.
 * @throws When neither XDG_CONFIG_HOME nor HOME is set.
 */
function configHome(base: NodeJS.ProcessEnv): string {
  const home = base.XDG_CONFIG_HOME || (base.HOME && join(base.HOME, ".config"));
  if (!home) throw new Error("set HOME or XDG_CONFIG_HOME to find the checks' config folder");
  return home;
}

/**
 * Lists the plugins installed in a Claude Code config folder.
 * @param configDir - The config folder.
 * @returns The installed plugins' names; none when the folder has no list.
 */
function installedPlugins(configDir: string): string[] {
  const file = join(configDir, "plugins", "installed_plugins.json");
  if (!existsSync(file)) return [];
  const { plugins } = JSON.parse(readFileSync(file, "utf8")) as { plugins?: Record<string, unknown> };
  return Object.keys(plugins ?? {});
}

/**
 * Reads the token saved for the checks. A file, unlike an exported env var,
 * leaves the operator's own `claude` sessions on their usual sign-in.
 * @param base - The environment whose config folder holds the file.
 * @returns The token.
 * @throws When the file is missing or empty, or anyone else can read it.
 */
function savedToken(base: NodeJS.ProcessEnv): string {
  const config = base.XDG_CONFIG_HOME || (base.HOME && join(base.HOME, ".config"));
  const file = config ? join(config, "quotient", "check-token") : "$XDG_CONFIG_HOME/quotient/check-token";
  const token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (token === "") throw new Error(`set CLAUDE_CODE_OAUTH_TOKEN, or save it in ${file}, from \`claude setup-token\` first`);
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`others can read ${file}: run chmod 600 on it`);
  return token;
}

/** The parts of a headless run's init message that show what it could reach. */
export type InitMessage = {
  type: "system";
  subtype: "init";
  mcp_servers: { name: string; status: string }[];
  plugins: { name: string; path: string }[];
};

// Claude Code's own mods load with every run and reach no Quotient.
const BUILT_IN = "builtin";

/**
 * Fails a check whose run could have reached anything but the local Quotient.
 * @param init - The run's init message.
 * @param copy - The plugin copy's folder, as `--plugin-dir` named it.
 * @throws When a claude.ai server loaded, a plugin other than the copy and
 *   Claude Code's built-in mods loaded, the copy didn't load, or
 *   `plugin:quotient:agex` isn't connected.
 */
export function assertLocalOnly(init: InitMessage, copy: string): void {
  const connector = init.mcp_servers.find(({ name }) => name.startsWith("claude.ai"));
  if (connector) throw new Error(`the run loaded ${connector.name}, which reaches production`);
  const others = init.plugins.filter(({ path }) => path !== copy && path !== BUILT_IN);
  if (others.length > 0) throw new Error(`the run loaded plugins beside the copy: ${others.map(({ name, path }) => `${name} (${path})`).join(", ")}`);
  if (!init.plugins.some(({ path }) => path === copy)) throw new Error(`the plugin copy at ${copy} didn't load`);
  const agex = init.mcp_servers.find(({ name }) => name === "plugin:quotient:agex");
  if (agex?.status !== "connected") {
    throw new Error(`plugin:quotient:agex is ${agex?.status ?? "missing"}: start the local Quotient on port 3000, and sign in to it from the checks folder`);
  }
}

/** The seed config the checks' database is seeded with, in Quotient's seed config format. */
export const SEED_CONFIG = join(import.meta.dirname, "local-quotient.seed.json");

/**
 * The teammates whose names and emails the seed config plants in their
 * frictions' descriptions. No skill's output may show either.
 */
export const PLANTED_PEOPLE = [
  { name: "Priya Raman", email: "priya.raman@example.test" },
  { name: "Tomás Okafor", email: "tomas.okafor@example.test" },
  { name: "Wen Halvorsen", email: "wen.halvorsen@example.test" },
] as const;

// Quotient's ids are cuids: "c" and 24 lower-case letters and digits, which
// always include a digit, so a long word starting with "c" doesn't match.
const QUOTIENT_ID = /\bc(?=[a-z]*\d)[a-z0-9]{24}\b/g;

/**
 * Finds the Quotient ids in a skill's output, seeded or created by the run.
 * @param text - The output.
 * @returns Each id found, in order.
 */
export function quotientIds(text: string): string[] {
  return text.match(QUOTIENT_ID) ?? [];
}

// The claude.ai Quotient connector always reaches production, whichever
// Quotient the plugin's own server names.
const CONNECTOR = /^mcp__claude_ai_Quotient__/;

/**
 * Lists the calls in a run's transcripts that went to the claude.ai Quotient
 * connector. The mod's own calls never show in a transcript, so this finds
 * only the agents' calls.
 * @param files - Each of the run's transcripts, as lines: the main one and its subagents'.
 * @returns The tool name of each such call, in order.
 */
export function productionCalls(files: readonly (readonly Line[])[]): string[] {
  return files.flatMap((lines) =>
    lines.flatMap((line) => {
      const content = (line.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return [];
      return (content as Line[]).filter((block) => block.type === "tool_use" && CONNECTOR.test(String(block.name))).map((block) => String(block.name));
    }),
  );
}
