// setup leaves out a session whose first typed prompt ran one of quotient's
// own skills. The mod's tests can't run a process, so this runs the awk
// program setup.tsx uses, read from its source, against sample transcripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SETUP = readFileSync(join(import.meta.dirname, "../plugins/quotient/hooks/setup.tsx"), "utf8");
const PROGRAM = /const QUOTIENT_STARTED = String\.raw`([^`]+)`/.exec(SETUP)?.[1] ?? "";

// One transcript per case, each a list of JSONL records, and whether setup
// should leave it out.
const CASES: { name: string; lines: string[]; isQuotient: boolean }[] = [
  {
    name: "typed /quotient:setup first",
    lines: [
      '{"type":"file-history-snapshot","messageId":"m"}',
      '{"type":"user","message":{"role":"user","content":"<command-message>quotient:setup</command-message>\\n<command-name>/quotient:setup</command-name>"}}',
    ],
    isQuotient: true,
  },
  {
    name: "a daily run, its command name first",
    lines: [
      '{"type":"user","entrypoint":"sdk-cli","message":{"role":"user","content":"<command-name>/quotient:find-solutions</command-name>\\n<command-args>daily run-1</command-args>"}}',
    ],
    isQuotient: true,
  },
  {
    name: "a command's caveat, then /quotient:fix-friction",
    lines: [
      '{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat</local-command-caveat>"}}',
      '{"type":"user","message":{"role":"user","content":"<command-message>quotient:fix-friction</command-message>"}}',
    ],
    isQuotient: true,
  },
  {
    name: "JSON written with spaces",
    lines: ['{"type": "user", "message": {"role": "user", "content": "<command-message>quotient:review-frictions</command-message>"}}'],
    isQuotient: true,
  },
  {
    name: "ordinary work, then /quotient:list-fixes later",
    lines: [
      '{"type":"user","message":{"role":"user","content":"fix the build"}}',
      '{"type":"user","message":{"role":"user","content":"<command-message>quotient:list-fixes</command-message>"}}',
    ],
    isQuotient: false,
  },
  {
    name: "a first prompt that only quotes a quotient command",
    lines: [
      '{"type":"user","message":{"role":"user","content":"why does <command-name>/quotient:setup</command-name> show here?"}}',
    ],
    isQuotient: false,
  },
  {
    name: "another plugin whose name starts with quotient",
    lines: ['{"type":"user","message":{"role":"user","content":"<command-message>quotientx:run</command-message>"}}'],
    isQuotient: false,
  },
  { name: "an empty transcript", lines: [], isQuotient: false },
];

test("setup.tsx's quotient-session program can be read from its source", () => {
  assert.match(PROGRAM, /nextfile/);
});

test("awk prints only the transcripts whose first typed prompt ran a quotient skill", () => {
  const dir = mkdtempSync(join(tmpdir(), "quotient-started-"));
  const files = CASES.map((one, i) => {
    const file = join(dir, `s${i}.jsonl`);
    writeFileSync(file, one.lines.map((line) => `${line}\n`).join(""));
    return file;
  });

  const printed = execFileSync("awk", [PROGRAM, ...files], { encoding: "utf8" }).split("\n").filter(Boolean);

  for (const [i, one] of CASES.entries()) {
    assert.equal(printed.includes(files[i]!), one.isQuotient, one.name);
  }
});
