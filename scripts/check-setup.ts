// Checks how /quotient:setup behaves, headless on the synthetic sessions
// against a local Quotient whose tables were just dropped:
//   - stopped after its first recorded batch and run again, it reviews no
//     source the first run recorded;
//   - it never reviews the session that holds teammates' fixes.
// Then it prints both runs' numbers, with the status lines each wrote
// between the start message and the summary. Claude Code asks the model for
// visible text when a turn ends with none, so it writes them while waiting on
// reviewers; quotient's mod draws them as nothing, which a headless run can't
// show, so they're counted rather than failed on.
//   node scripts/check-setup.ts [--permission-mode <mode>]
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SESSIONS } from "./build-setup-fixture.ts";
import { measureSetup, readSession } from "./measure-setup.ts";
import { install, isLocalQuotient, pluginUrl, SETUP_ENV, setupArgs, transcriptOf } from "./run-setup-fixture.ts";

type Line = Record<string, unknown>;
type Block = Record<string, unknown>;

const START = "mcp__quotient__setup_start";
const SUMMARY = "mcp__quotient__setup_summary";
const DIGEST = "mcp__quotient__setup_digest";
const RECORD = /__record_setup_progress$/;

/**
 * Lists a transcript's content blocks of one type, in order.
 * @param lines - The transcript's lines.
 * @param type - The block type, such as `tool_use` or `text`.
 * @returns The blocks.
 */
function blocks(lines: readonly Line[], type: string): Block[] {
  return lines.flatMap((line) => {
    const content = (line.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? (content as Block[]).filter((block) => block.type === type) : [];
  });
}

/**
 * Lists the tool calls whose reply came back without an error.
 * @param lines - The transcript's lines.
 * @returns The calls.
 */
function succeeded(lines: readonly Line[]): Block[] {
  const failed = new Set(blocks(lines, "tool_result").filter((r) => r.is_error === true).map((r) => r.tool_use_id));
  const answered = new Set(blocks(lines, "tool_result").map((r) => r.tool_use_id));
  return blocks(lines, "tool_use").filter((call) => answered.has(call.id) && !failed.has(call.id));
}

/**
 * Finds the text the agent wrote between the start message and the summary.
 * @param lines - The main transcript's lines.
 * @returns Each text it wrote there.
 */
export function textDuringRun(lines: readonly Line[]): string[] {
  const found: string[] = [];
  let isRunning = false;
  for (const line of lines) {
    if (line.type !== "assistant") continue;
    for (const block of blocks([line], "tool_use")) {
      if (block.name === START) isRunning = true;
      if (block.name === SUMMARY) isRunning = false;
    }
    if (isRunning) for (const block of blocks([line], "text")) if (String(block.text).trim() !== "") found.push(String(block.text));
  }
  return found;
}

/**
 * Lists the sources a run recorded as reviewed.
 * @param lines - The main transcript's lines.
 * @returns The sources each successful `record_setup_progress` sent.
 */
export function recordedSources(lines: readonly Line[]): string[] {
  return succeeded(lines)
    .filter((call) => RECORD.test(String(call.name)))
    .flatMap((call) => ((call.input as { sources?: unknown }).sources as string[] | undefined) ?? []);
}

/**
 * Lists the sources a run reviewed: each digest or transcript that came back,
 * in the main transcript or a subagent's.
 * @param files - Each transcript's lines.
 * @returns The sources, by transcript name.
 */
export function reviewedSources(files: readonly (readonly Line[])[]): string[] {
  return files.flatMap((lines) =>
    succeeded(lines).flatMap((call) => {
      const input = call.input as Record<string, unknown>;
      if (call.name === DIGEST && typeof input.source === "string") return [input.source];
      const path = String(input.file_path ?? "");
      return call.name === "Read" && /\/projects\/[^/]+\/[^/]+\.jsonl$/.test(path) ? [basename(path, ".jsonl")] : [];
    }),
  );
}

/**
 * Parses a transcript's lines.
 * @param text - The `.jsonl` text.
 * @returns Its lines.
 */
const parse = (text: string): Line[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);

// How long either run may take before the check gives up on it.
const RUN_TIMEOUT_MS = 45 * 60_000;

/**
 * Runs setup until it records its first batch, then stops it.
 * @param projects - The Claude Code projects folder.
 * @param mode - The permission mode.
 * @returns The run's session id, and whether it was stopped before it finished.
 * @throws When claude can't start, or the run records no batch in time.
 */
async function runUntilRecorded(projects: string, mode: string): Promise<{ sessionId: string; isStopped: boolean }> {
  const sessionId = randomUUID();
  const cwd = mkdtempSync(join(tmpdir(), "setup-check-"));
  const child = spawn("claude", [...setupArgs(mode), "--session-id", sessionId], { cwd, stdio: "ignore", env: SETUP_ENV });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  let isDone = false;
  let spawnError: Error | undefined;
  void exited.then(() => (isDone = true));
  child.once("error", (error) => {
    spawnError = error;
    isDone = true;
  });
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (!isDone) {
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`the first run recorded no batch within ${RUN_TIMEOUT_MS / 60_000} minutes`);
    }
    await new Promise((wait) => setTimeout(wait, 1_000));
    const transcript = readdirSync(projects).map((folder) => join(projects, folder, `${sessionId}.jsonl`)).find(existsSync);
    if (transcript !== undefined && recordedSources(parse(readFileSync(transcript, "utf8"))).length > 0) {
      child.kill("SIGTERM");
      await exited;
      return { sessionId, isStopped: true };
    }
  }
  if (spawnError !== undefined) throw spawnError;
  return { sessionId, isStopped: false };
}

if (import.meta.main) {
  const url = pluginUrl();
  if (!isLocalQuotient(url)) throw new Error(`plugins/quotient/.mcp.json must name a local Quotient, not ${url}: see CONTRIBUTING.md`);
  const modeAt = process.argv.indexOf("--permission-mode");
  const mode = modeAt === -1 ? "default" : (process.argv[modeAt + 1] ?? "default");
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const teammate = SESSIONS.find((session) => session.steps.some((step) => step.kind === "call" && step.tool.endsWith("list_teammate_frictions")))?.id;
  const folder = install(projects);
  const failures: string[] = [];
  try {
    const first = await runUntilRecorded(projects, mode);
    if (!first.isStopped) failures.push("the first run finished before it recorded a batch, so resuming wasn't checked");
    const ran = spawnSync("claude", setupArgs(mode), {
      cwd: mkdtempSync(join(tmpdir(), "setup-check-")),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: RUN_TIMEOUT_MS,
      env: SETUP_ENV,
    });
    const second = (JSON.parse(ran.stdout) as { session_id: string }).session_id;
    const runs = [first.sessionId, second].map((id) => readSession(transcriptOf(projects, id)));
    const [firstFiles, secondFiles] = runs.map((files) => files.map((file) => parse(file.text))) as [Line[][], Line[][]];
    const recorded = recordedSources(firstFiles[0] ?? []);
    for (const [name, files] of [["first", firstFiles], ["second", secondFiles]] as const) {
      if (teammate !== undefined && reviewedSources(files).includes(teammate)) failures.push(`the ${name} run reviewed the session that holds teammates' fixes`);
    }
    for (const source of reviewedSources(secondFiles)) {
      if (recorded.includes(source)) failures.push(`the second run reviewed ${source}, which the first run recorded`);
    }
    if (!blocks(secondFiles[0] ?? [], "tool_use").some((call) => call.name === SUMMARY)) failures.push("the second run never showed the summary");
    const statusLines = [firstFiles, secondFiles].map((files) => textDuringRun(files[0] ?? []).length);
    console.log(JSON.stringify({ recordedByFirst: recorded.length, statusLines, runs: runs.map((files) => measureSetup(files)), failures }, null, 2));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  process.exit(failures.length === 0 ? 0 : 1);
}
