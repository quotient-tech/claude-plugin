// A stand-in for Quotient that the behavior checks run quotient's skills
// against, so a check sends nothing to dev or production.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Line = Record<string, unknown>;

/**
 * The environment a check runs `claude` in. A new config folder loads none of
 * the operator's plugins, so no installed quotient plugin reaches production
 * beside the copy under test, and no claude.ai server. Because the folder
 * holds no sign-in, the run signs in with a token from `claude setup-token`.
 * The env var turns claude.ai's servers off as well, in case the token's
 * account would otherwise bring them.
 * @param base - The environment to start from, usually `process.env`.
 * @returns The run's environment, and its config folder, which the caller removes.
 * @throws When `CLAUDE_CODE_OAUTH_TOKEN` is unset.
 */
export function runEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; configDir: string } {
  if (!base.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` first: see CONTRIBUTING.md");
  // realpath: on macOS mkdtemp gives /var/..., but Claude Code reports /private/var/...
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-config-")));
  return { env: { ...base, CLAUDE_CONFIG_DIR: configDir, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, configDir };
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
