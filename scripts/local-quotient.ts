// What the behavior checks need to run quotient's skills against a local
// Quotient: a plugin copy that reaches it, the environment a run starts in,
// and a check that no call went to production.
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalQuotient, PLUGIN } from "./run-setup-fixture.ts";

type Line = Record<string, unknown>;

/**
 * Copies quotient's plugin to a new folder whose .mcp.json names the given
 * Quotient, so the committed .mcp.json keeps production's URL.
 * @param url - The Quotient MCP URL the copy reaches.
 * @returns The copy's folder, which the caller removes.
 * @throws When the URL isn't on this machine.
 */
export function pluginPointingAt(url: string): string {
  if (!isLocalQuotient(url)) throw new Error(`the plugin copy reaches only a local Quotient, not ${url}`);
  const copy = join(realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-plugin-"))), "quotient");
  cpSync(PLUGIN, copy, { recursive: true });
  writeFileSync(join(copy, ".mcp.json"), `${JSON.stringify({ mcpServers: { agex: { type: "http", url } } }, null, 2)}\n`);
  return copy;
}

/**
 * The environment a check runs `claude` in. A new config folder loads none of
 * the operator's plugins, so no installed quotient plugin reaches production
 * beside the copy under test, and no claude.ai server. Because the folder
 * holds no sign-in, the run signs in with a token from `claude setup-token`.
 * The env var turns claude.ai's servers off as well, in case the token's
 * account would otherwise bring them.
 * @param base - The environment to start from, usually `process.env`.
 * @returns The run's environment, and its config folder, which the caller removes.
 * @throws When there's no token, or its saved file is readable by others.
 */
export function runEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; configDir: string } {
  const token = base.CLAUDE_CODE_OAUTH_TOKEN || savedToken(base);
  // realpath: on macOS mkdtemp gives /var/..., but Claude Code reports /private/var/...
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-config-")));
  // Claude Code deletes transcripts older than cleanupPeriodDays (30 unless
  // set) in the background as it starts, which would take the fixture's
  // dated sessions before setup lists them.
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 100_000 }));
  return { env: { ...base, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: configDir, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, configDir };
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
