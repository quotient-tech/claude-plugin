// Measures one /quotient:setup run from its transcripts: wall time, tokens and
// the frictions it found. Run it with the main session's transcript:
//   node scripts/measure-setup.ts ~/.claude/projects/<folder>/<session>.jsonl
// Its subagents' transcripts, in the folder named after the session, count too.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TranscriptFile, type UsageRow, usageRows } from "../plugins/quotient/hooks/usageRows.ts";

/** Token totals for a set of requests. */
export type Tokens = { requests: number; input: number; cacheWrite: number; cacheRead: number; output: number };

/** What one setup run cost and found. */
export type SetupMeasurement = {
  wallSeconds: number;
  total: Tokens;
  subagents: Tokens;
  bySkill: Record<string, Tokens>;
  newFrictions: number | null;
};

const SETUP_COMMAND = "<command-message>quotient:setup</command-message>";
const FINISH_TOOL = /__finish_setup_run$/;
const SUMMARY_TOOL = /^mcp__quotient__setup_summary$/;

/**
 * Adds up the token counts of some requests.
 * @param rows - The requests.
 * @returns Their totals.
 */
function sum(rows: readonly UsageRow[]): Tokens {
  return rows.reduce<Tokens>(
    (t, r) => ({
      requests: t.requests + 1,
      input: t.input + r.inputTokens,
      cacheWrite: t.cacheWrite + r.cacheCreationTokens,
      cacheRead: t.cacheRead + r.cacheReadTokens,
      output: t.output + r.outputTokens,
    }),
    { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  );
}

/**
 * Parses each line of the files that is a JSON object.
 * @param files - The transcripts.
 * @returns The parsed lines.
 */
function parsed(files: readonly TranscriptFile[]): Record<string, unknown>[] {
  return files.flatMap(({ text }) =>
    text.split("\n").flatMap((raw) => {
      try {
        const line: unknown = JSON.parse(raw);
        return typeof line === "object" && line !== null && !Array.isArray(line) ? [line as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    }),
  );
}

/**
 * The content blocks of a line's message.
 * @param line - A transcript line.
 * @returns Its blocks, or none when its content is text.
 */
function blocks(line: Record<string, unknown>): Record<string, unknown>[] {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

/**
 * The text of a line's message, whether its content is a string or blocks.
 * @param line - A transcript line.
 * @returns The text.
 */
function messageText(line: Record<string, unknown>): string {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

/**
 * Finds the reply to the first call of a tool, on a line with a timestamp:
 * Claude Code also writes untimed copies of some lines.
 * @param lines - Every line of the run.
 * @param tool - Matches the tool's name.
 * @returns The reply's line and block, or undefined when the tool was never answered.
 */
function replyTo(
  lines: readonly Record<string, unknown>[],
  tool: RegExp,
): { line: Record<string, unknown>; block: Record<string, unknown> } | undefined {
  const ids = new Set(
    lines.flatMap((line) => blocks(line).filter((b) => b.type === "tool_use" && tool.test(String(b.name))).map((b) => b.id)),
  );
  for (const line of lines) {
    if (line.timestamp === undefined) continue;
    const block = blocks(line).find((b) => b.type === "tool_result" && ids.has(b.tool_use_id));
    if (block !== undefined) return { line, block };
  }
  return undefined;
}

/**
 * Reads `newCount` from the reply to the run's `finish_setup_run` call.
 * @param lines - Every line of the run.
 * @returns The count, or null when the run never finished.
 */
function newFrictions(lines: readonly Record<string, unknown>[]): number | null {
  const content = replyTo(lines, FINISH_TOOL)?.block.content;
  const parts = Array.isArray(content) ? (content as { text?: unknown }[]) : [{ text: content }];
  for (const part of parts) {
    try {
      const reply = JSON.parse(String(part.text)) as { newCount?: unknown };
      if (typeof reply.newCount === "number") return reply.newCount;
    } catch {
      // Not the JSON reply.
    }
  }
  return null;
}

/**
 * Measures one setup run.
 * @param files - The main session's transcript, then its subagents'.
 * @returns Its wall time, tokens and the frictions it found.
 * @throws When no line ran /quotient:setup.
 */
export function measureSetup(files: readonly TranscriptFile[]): SetupMeasurement {
  const lines = parsed(files);
  const times = lines.map((line) => Date.parse(String(line.timestamp))).filter((t) => !Number.isNaN(t));
  const start = lines.find((line) => line.type === "user" && messageText(line).includes(SETUP_COMMAND));
  if (start === undefined) throw new Error("no /quotient:setup in these transcripts");
  // The summary ends the run; without one, the session's last line does.
  const summary = replyTo(lines, SUMMARY_TOOL)?.line.timestamp;
  const end = summary === undefined ? Math.max(...times) : Date.parse(String(summary));
  const begin = Date.parse(String(start.timestamp));
  const rows = usageRows(files, end + 1).filter((r) => {
    const at = Date.parse(r.occurredAt);
    return at >= begin && at <= end;
  });
  const bySkill: Record<string, Tokens> = {};
  for (const skill of new Set(rows.map((r) => r.skill))) bySkill[skill] = sum(rows.filter((r) => r.skill === skill));
  return {
    wallSeconds: Math.round((end - begin) / 1000),
    total: sum(rows),
    subagents: sum(rows.filter((r) => r.isSubagent)),
    bySkill,
    newFrictions: newFrictions(lines),
  };
}

/**
 * Reads a session's transcript and its subagents' transcripts.
 * @param transcript - The main session's `.jsonl` path.
 * @returns The files, main first.
 */
export function readSession(transcript: string): TranscriptFile[] {
  const files = [{ path: transcript, text: readFileSync(transcript, "utf8") }];
  const subagents = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  if (existsSync(subagents)) {
    for (const name of readdirSync(subagents).sort()) {
      if (name.endsWith(".jsonl")) files.push({ path: join(subagents, name), text: readFileSync(join(subagents, name), "utf8") });
    }
  }
  return files;
}

if (import.meta.main) {
  const transcript = process.argv[2];
  if (transcript === undefined) {
    console.error("usage: node scripts/measure-setup.ts <session>.jsonl");
    process.exit(2);
  }
  console.log(JSON.stringify(measureSetup(readSession(transcript)), null, 2));
}
