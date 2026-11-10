// The test kit has no core `$.mcp.call`, so a test's `mcp.call` hook answers
// `{ deny }` in place of Claude Code's permission check. The kit rejects the
// mod's call with `<plugin>: $.mcp.call: <deny>`, so the reason carries the
// wording Claude Code itself rejects a denied call with.

/**
 * The reason a test's `mcp.call` hook denies with to stand for Claude Code
 * denying the call.
 *
 * @param server - The server's name, as `$.mcp.call` took it
 * @param tool - The tool's name on that server
 * @returns The deny reason
 */
export function denial(server: string, tool: string): string {
  return `$.mcp.call(${server}, ${tool}) refused: The server-side auto mode classifier gave no verdict for this call.`
}
