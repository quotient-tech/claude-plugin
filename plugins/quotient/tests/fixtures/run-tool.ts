import type { ToolCallResult } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

// `$.tool.call` is typed per tool, and resolving that signature at a call site
// costs the type check hundreds of megabytes, enough to push
// `claude plugin validate` past its memory limit. Tests pass inputs the
// engine's types don't describe anyway, so they call it through a plain one.

/**
 * Calls a tool through the engine, as the engine calls the model's tools.
 *
 * @param $ - The engine
 * @param input - The call: `tool`, its input, and any `tool_use_id` or `agentId`
 * @returns What the call resolved to
 */
export function runTool($: Parameters<TestBody>[0], input: Record<string, unknown>): Promise<ToolCallResult> {
  const tool = $.tool as unknown as { call: (input: Record<string, unknown>) => Promise<ToolCallResult> }
  return tool.call(input)
}
