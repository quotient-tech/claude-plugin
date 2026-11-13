// A stand-in for Quotient that the behavior checks run quotient's skills
// against, so a check sends nothing to dev or production.

type Line = Record<string, unknown>;

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
