// A stand-in for Quotient that the behavior checks run quotient's skills
// against, so a check sends nothing to dev or production.
import { cpSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalQuotient, PLUGIN } from "./run-setup-fixture.ts";

type Line = Record<string, unknown>;

/** One tools/call the stand-in received. */
export type Call = { tool: string; args: unknown };

/** A running stand-in. */
export type StandIn = {
  /** The MCP URL, such as http://127.0.0.1:53817/mcp. */
  url: string;
  /** Every tools/call the stand-in received, in order. */
  calls(): readonly Call[];
  /** Stops the server. */
  close(): Promise<void>;
};

/** Everything one stand-in remembers, for as long as it runs. */
type State = { calls: Call[] };

/** A tool the stand-in serves, and how it answers. */
type Tool = {
  description: string;
  inputSchema: Record<string, unknown>;
  answer(state: State, args: Record<string, unknown>): { content: { type: "text"; text: string }[]; isError?: boolean };
};

const TOOLS: Record<string, Tool> = {};

// JSON-RPC's codes for an unknown method and for bad params, which MCP uses
// for an unknown tool.
const UNKNOWN_METHOD = -32601;
const BAD_PARAMS = -32602;

/**
 * Answers one JSON-RPC message.
 * @param state - The stand-in's state.
 * @param message - The parsed message.
 * @returns The reply, or undefined for a notification, which gets none.
 */
function answer(state: State, message: Record<string, unknown>): Record<string, unknown> | undefined {
  if (message.id === undefined) return undefined;
  const reply = (body: Record<string, unknown>) => ({ jsonrpc: "2.0", id: message.id, ...body });
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize":
      return reply({ result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "quotient-stand-in", version: "0" } } });
    case "ping":
      return reply({ result: {} });
    case "tools/list":
      return reply({ result: { tools: Object.entries(TOOLS).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) } });
    case "tools/call": {
      const tool = String(params.name);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      state.calls.push({ tool, args });
      const served = TOOLS[tool];
      if (served === undefined) return reply({ error: { code: BAD_PARAMS, message: `the stand-in doesn't serve ${tool}` } });
      return reply({ result: served.answer(state, args) });
    }
    default:
      return reply({ error: { code: UNKNOWN_METHOD, message: `the stand-in doesn't answer ${String(message.method)}` } });
  }
}

/**
 * Reads a request's whole body.
 * @param request - The request.
 * @returns Its text.
 */
async function bodyOf(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

/**
 * Serves MCP over HTTP, replying to each POST with JSON. It offers no event
 * stream and asks for no sign-in.
 * @param state - The stand-in's state.
 * @param request - The request.
 * @param response - Where the reply goes.
 */
async function serve(state: State, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url !== "/mcp") return void response.writeHead(404).end();
  if (request.method !== "POST") return void response.writeHead(405, { allow: "POST" }).end();
  const reply = answer(state, JSON.parse(await bodyOf(request)) as Record<string, unknown>);
  if (reply === undefined) return void response.writeHead(202).end();
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
}

/**
 * Starts a stand-in on a free loopback port, with nothing recorded yet.
 * @returns The running stand-in.
 */
export async function startStandIn(): Promise<StandIn> {
  const state: State = { calls: [] };
  const server = createServer((request, response) => {
    serve(state, request, response).catch(() => response.writeHead(400).end());
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls: () => [...state.calls],
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}

/**
 * Copies quotient's plugin to a new folder whose .mcp.json names the given
 * Quotient, so the committed .mcp.json keeps production's URL.
 * @param url - The Quotient MCP URL the copy reaches.
 * @returns The copy's folder, which the caller removes.
 * @throws When the URL isn't on this machine.
 */
export function pluginPointingAt(url: string): string {
  if (!isLocalQuotient(url)) throw new Error(`the plugin copy reaches only a local Quotient, not ${url}`);
  const copy = join(realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-plugin-"))), "quotient");
  cpSync(PLUGIN, copy, { recursive: true });
  writeFileSync(join(copy, ".mcp.json"), `${JSON.stringify({ mcpServers: { agex: { type: "http", url } } }, null, 2)}\n`);
  return copy;
}

/**
 * The environment a check runs `claude` in. A new config folder loads none of
 * the operator's plugins, so no installed quotient plugin reaches production
 * beside the copy under test, and no claude.ai server. Because the folder
 * holds no sign-in, the run signs in with a token from `claude setup-token`.
 * The env var turns claude.ai's servers off as well, in case the token's
 * account would otherwise bring them.
 * @param base - The environment to start from, usually `process.env`.
 * @returns The run's environment, and its config folder, which the caller removes.
 * @throws When `CLAUDE_CODE_OAUTH_TOKEN` is unset.
 */
export function runEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; configDir: string } {
  if (!base.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` first: see CONTRIBUTING.md");
  // realpath: on macOS mkdtemp gives /var/..., but Claude Code reports /private/var/...
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-config-")));
  return { env: { ...base, CLAUDE_CONFIG_DIR: configDir, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, configDir };
}

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
