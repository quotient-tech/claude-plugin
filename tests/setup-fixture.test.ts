// Keeps setup's synthetic sessions in step with their generator and manifest.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURE_ROOT, PROJECT, SESSIONS, transcript } from "../scripts/build-setup-fixture.ts";

const FOLDER = join(FIXTURE_ROOT, PROJECT);

test("setup fixture: the committed sessions are the generator's output", () => {
  assert.deepEqual(readdirSync(FOLDER).sort(), SESSIONS.map((s) => `${s.id}.jsonl`).sort());
  for (const session of SESSIONS) {
    assert.equal(readFileSync(join(FOLDER, `${session.id}.jsonl`), "utf8"), transcript(session), `${session.id} is stale: run node scripts/build-setup-fixture.ts`);
  }
});

test("setup fixture: every session the manifest names exists", () => {
  const manifest = readFileSync(join(FIXTURE_ROOT, "MANIFEST.md"), "utf8");
  const named = [...manifest.matchAll(/a0000000-0000-4000-8000-0000000000\d\d/g)].map((m) => m[0]);
  assert.ok(named.length > 0);
  for (const id of named) assert.ok(existsSync(join(FOLDER, `${id}.jsonl`)), `${id} is missing`);
});

test("setup fixture: one automated run, told apart the way setup tells them", () => {
  const automated = SESSIONS.filter((s) => transcript(s).includes('"entrypoint":"sdk-'));
  assert.equal(automated.length, 1);
});
