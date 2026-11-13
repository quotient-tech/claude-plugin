import assert from "node:assert/strict";
import { test } from "node:test";

import { productionCalls } from "../scripts/stand-in-quotient.ts";

type Line = Record<string, unknown>;

/**
 * A model response that calls one tool.
 * @param name - The tool's name.
 * @returns The transcript line.
 */
const calls = (name: string): Line => ({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input: {} }] } });

test("a call to the claude.ai Quotient connector is found in any of the run's transcripts", () => {
  const main = [calls("mcp__plugin_quotient_agex__start_setup_run"), calls("Read")];
  const reviewer = [calls("mcp__claude_ai_Quotient__list_teammate_frictions")];
  assert.deepEqual(productionCalls([main, reviewer]), ["mcp__claude_ai_Quotient__list_teammate_frictions"]);
});

test("a run that reaches Quotient only through the plugin's server has no production calls", () => {
  assert.deepEqual(productionCalls([[calls("mcp__plugin_quotient_agex__submit_frictions")], []]), []);
});
