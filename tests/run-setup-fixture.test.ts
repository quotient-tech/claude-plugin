// The fixture runner must never send a measured run to dev or production.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOWED_TOOLS, isLocalQuotient } from "../scripts/run-setup-fixture.ts";
import { readFrontmatter } from "./helpers/frontmatter.ts";

test("run-setup-fixture: only a Quotient on this machine counts as local", () => {
  assert.equal(isLocalQuotient("http://localhost:3000/mcp"), true);
  assert.equal(isLocalQuotient("http://127.0.0.1:3000/mcp"), true);
  assert.equal(isLocalQuotient(undefined), false);
  assert.equal(isLocalQuotient("https://mcp.getquotient.com/mcp"), false);
  assert.equal(isLocalQuotient("https://mcp.dev.example.com/mcp"), false);
  assert.equal(isLocalQuotient("http://localhost.evil.example/mcp"), false);
});

test("run-setup-fixture: allows no tool that writes on this machine", () => {
  for (const tool of ["Bash", "Write", "Edit", "NotebookEdit"]) assert.ok(!ALLOWED_TOOLS.includes(tool), `${tool} is allowed`);
});

// Naming Grep or Glob in --allowedTools adds them, and an operator's session
// has neither, so a measured run would get tools the operator doesn't.
test("run-setup-fixture: adds no tool an operator's session lacks", () => {
  for (const tool of ["Grep", "Glob"]) assert.ok(!ALLOWED_TOOLS.includes(tool), `${tool} is allowed`);
});

// A headless run prompts for, or denies, any Quotient tool setup calls that
// isn't allowed here, which would skew what it measures.
test("run-setup-fixture: allows every tool the setup skill calls on the plugin's server", () => {
  const { data } = readFrontmatter(join(import.meta.dirname, "../plugins/quotient/skills/setup/SKILL.md"));
  const tools = (data["allowed-tools"] ?? "").split(/,\s*/).filter((rule) => rule.startsWith("mcp__plugin_quotient_agex__"));
  assert.ok(tools.length > 0);
  for (const tool of tools) assert.ok(ALLOWED_TOOLS.includes(tool), `${tool} isn't allowed`);
});
