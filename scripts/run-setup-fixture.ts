// Runs /quotient:setup headless against the synthetic sessions, with this
// repo's plugin and a local Quotient, then measures the run.
//   node scripts/run-setup-fixture.ts [--permission-mode <mode>]
// It copies the sessions into ~/.claude/projects for the run and removes them
// after. They are dated January 2020 and the window is pinned to those days,
// so the run reviews them and nothing else.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ROOT, PROJECT } from "./build-setup-fixture.ts";
import { measureSetup, readSession } from "./measure-setup.ts";

const PLUGIN = join(import.meta.dirname, "../plugins/quotient");
const WINDOW_END = "2020-01-15";
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;
const AGEX = "mcp__plugin_quotient_agex__";
const QUOTIENT_TOOLS = ["start_setup_run", "record_setup_progress", "submit_friction", "finish_setup_run", "list_teammate_frictions", "submit_solution"];
export const ALLOWED_TOOLS = [
  "Read",
  "Agent",
  "ToolSearch",
  "RemoteTrigger",
  "mcp__quotient__setup_start",
  "mcp__quotient__setup_digest",
  "mcp__quotient__setup_summary",
  ...QUOTIENT_TOOLS.map((tool) => AGEX + tool),
];

/**
 * Tells whether a Quotient MCP URL is on this machine.
 * @param url - The URL, or undefined when unset (which means production).
 * @returns Whether it's local.
 */
export function isLocalQuotient(url: string | undefined): boolean {
  return url !== undefined && LOCAL.test(url);
}

/**
 * The arguments that run /quotient:setup headless with this repo's plugin and an operator's tools.
 * @param mode - The permission mode.
 * @returns The arguments for `claude`.
 */
export function setupArgs(mode: string): string[] {
  return ["-p", "/quotient:setup", "--plugin-dir", PLUGIN, "--permission-mode", mode, "--allowedTools", ...ALLOWED_TOOLS, "--output-format", "json"];
}

/**
 * The environment that points the run at a local Quotient and pins its window to the sessions' days.
 * @param url - The local Quotient's MCP URL.
 * @returns The environment.
 */
export function setupEnv(url: string): NodeJS.ProcessEnv {
  return { ...process.env, AGEX_MCP_URL: url, QUOTIENT_SETUP_WINDOW_END: WINDOW_END };
}

/**
 * Copies the sessions into the projects folder, each modified on the day of its last line.
 * @param projects - The Claude Code projects folder.
 * @returns The copied project folder.
 * @throws When the folder is already there, so a run never overwrites one.
 */
export function install(projects: string): string {
  const folder = join(projects, PROJECT);
  if (existsSync(folder)) throw new Error(`${folder} already exists: remove it first`);
  cpSync(join(FIXTURE_ROOT, PROJECT), folder, { recursive: true });
  for (const name of readdirSync(folder)) {
    const lines = readFileSync(join(folder, name), "utf8").trim().split("\n");
    const last = new Date(JSON.parse(lines.at(-1) ?? "{}").timestamp);
    utimesSync(join(folder, name), last, last);
  }
  return folder;
}

/**
 * Finds a session's transcript under the projects folder.
 * @param projects - The Claude Code projects folder.
 * @param sessionId - The session's id.
 * @returns Its path.
 * @throws When it isn't there.
 */
export function transcriptOf(projects: string, sessionId: string): string {
  for (const folder of readdirSync(projects)) {
    const path = join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  throw new Error(`no transcript for session ${sessionId}`);
}

if (import.meta.main) {
  const url = process.env.AGEX_MCP_URL ?? "http://localhost:3000/mcp";
  if (!isLocalQuotient(url)) throw new Error(`AGEX_MCP_URL must be a local Quotient, not ${url}`);
  const modeAt = process.argv.indexOf("--permission-mode");
  const mode = modeAt === -1 ? "default" : process.argv[modeAt + 1];
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const folder = install(projects);
  try {
    const cwd = mkdtempSync(join(tmpdir(), "setup-fixture-"));
    const ran = spawnSync("claude", setupArgs(mode ?? "default"), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 45 * 60_000,
      env: setupEnv(url),
    });
    const out = JSON.parse(ran.stdout) as { session_id: string; result?: string };
    const transcript = transcriptOf(projects, out.session_id);
    console.log(JSON.stringify({ transcript, result: out.result, ...measureSetup(readSession(transcript)) }, null, 2));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
