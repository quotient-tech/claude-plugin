import assert from "node:assert/strict";
import { test } from "node:test";

import { heldVerdict, transcriptFindArgs } from "../plugins/quotient/hooks/sessions.ts";

const PROJECTS = "/home/op/.claude/projects";
const FIND = ["find", PROJECTS, "-mindepth", "2", "-maxdepth", "2", "-type", "f", "-name", "*.jsonl"];

test("the last days' transcripts are found by modification age", () => {
  assert.deepEqual(transcriptFindArgs(PROJECTS, { days: 14 }), [...FIND, "-mtime", "-14"]);
});

test("a pinned window finds the transcripts modified within its days", () => {
  assert.deepEqual(transcriptFindArgs(PROJECTS, { start: "2020-01-01", end: "2020-01-15" }), [
    ...FIND,
    "-newermt",
    "2020-01-01",
    "!",
    "-newermt",
    "2020-01-15",
  ]);
});

test("grep's exit code says whether a transcript holds teammates' fixes", () => {
  assert.equal(heldVerdict(0), "holds");
  assert.equal(heldVerdict(1), "clean");
  assert.equal(heldVerdict(2), "unchecked");
  assert.equal(heldVerdict(undefined), "unchecked");
});
