// Reads a Markdown file's `key: value` frontmatter. Enough for skill files,
// whose frontmatter is flat, without adding a YAML dependency.
import { readFileSync } from "node:fs";

export function readFrontmatter(path: string): { data: Record<string, string>; body: string } {
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path} has no frontmatter`);
  const data: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]!] = kv[2]!.trim();
  }
  return { data, body: match[2]! };
}
