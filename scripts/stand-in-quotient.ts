// A stand-in for Quotient that the behavior checks run quotient's skills
// against, so a check sends nothing to dev or production.
//
// Its replies follow Quotient's tools in apps/nextjs/src/lib/mcp/mcpServer.ts
// and the lib/agex code it calls, as of Quotient commit a679bc409. Keep them
// in step: the mod shows nothing on a reply it can't read, so a drifted shape
// fails the checks for the wrong reason.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
  /**
   * What may never be shown to the operator: every id the stand-in issued,
   * and the teammate names and emails it planted.
   */
  bait(): { ids: readonly string[]; names: readonly string[]; emails: readonly string[] };
  /** Stops the server. */
  close(): Promise<void>;
};

type Severity = "high" | "medium" | "low";

/** A setup run, while it's open. */
type SetupRun = { runId: string; startedAt: string; reviewedSources: string[]; alreadyReported: Set<string> };

/**
 * One of the operator's own frictions, as list_my_frictions gives it, and
 * where it was found, which the stand-in keeps to itself.
 */
type OwnFriction = {
  id: string;
  title: string | null;
  description: string;
  frequency: string;
  impact: string;
  severity: Severity;
  tags: string[];
  discoveredAt: string;
  affectedSessionCount: number | null;
  reviewedSessionCount: number | null;
  solutions: never[];
  lastReviewedAt: string | null;
  lastCloudReviewedAt: string | null;
  foundIn: { runId: string } | { sessionId: string } | null;
};

/** Everything one stand-in remembers, for as long as it runs. */
type State = {
  calls: Call[];
  ids: string[];
  run: SetupRun | undefined;
  /** The operator's own frictions, oldest first. */
  own: OwnFriction[];
  /** Teammates' frictions the operator hasn't answered, as list_teammate_frictions gives them. */
  teammates: Record<string, unknown>[];
  /** The ids of the frictions the operator has answered. */
  answered: Set<string>;
};

// Teammates the stand-in plants in their frictions' descriptions, where only an
// agent quoting them could carry them to the operator. Titles stay clean:
// the mod draws teammates' titles itself, and Quotient's agents write titles
// without names.
const TEAMMATES = [
  { name: "Priya Raman", email: "priya.raman@example.test" },
  { name: "Tomás Okafor", email: "tomas.okafor@example.test" },
  { name: "Wen Halvorsen", email: "wen.halvorsen@example.test" },
];

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };

/** A tool the stand-in serves, and how it answers. */
type Tool = {
  description: string;
  inputSchema: Record<string, unknown>;
  answer(state: State, args: Record<string, unknown>): Reply;
};

/**
 * A successful reply, as Quotient's tools give one: their JSON as text.
 * @param value - The reply's JSON.
 * @returns The tool result.
 */
const ok = (value: unknown): Reply => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/**
 * A refusal, as Quotient's tools give one: the reason as text, marked as an error.
 * @param reason - Why nothing was done.
 * @returns The tool result.
 */
const refuse = (reason: string): Reply => ({ content: [{ type: "text", text: reason }], isError: true });

/**
 * Issues a new id, shaped like Quotient's cuids so skills and the mod treat it
 * as real, and the same on every run so checks are repeatable.
 * @param state - The stand-in's state, which records the id as bait.
 * @returns The id.
 */
function newId(state: State): string {
  const id = `c${createHash("sha256").update(`quotient-stand-in-${state.ids.length}`).digest("hex").slice(0, 24)}`;
  state.ids.push(id);
  return id;
}

/**
 * Quotient's refusal for a run that is missing or finished.
 * @param runId - The run the call named.
 * @returns The refusal's text.
 */
const unknownRun = (runId: unknown): string =>
  `You have no unfinished setup run with the id ${String(runId)}. Call start_setup_run for the run to resume. Nothing was recorded.`;

/**
 * Finds the open setup run a call names.
 * @param state - The stand-in's state.
 * @param runId - The run the call named.
 * @returns The run, or undefined when it isn't open.
 */
const openRun = (state: State, runId: unknown): SetupRun | undefined => (state.run?.runId === runId ? state.run : undefined);

/**
 * Tells whether a friction id is one the operator may answer: a teammate's,
 * or one of the operator's own.
 * @param state - The stand-in's state.
 * @param frictionId - The id an answer names.
 * @returns Whether Quotient knows it.
 */
function isKnownFriction(state: State, frictionId: unknown): boolean {
  return [...state.teammates, ...state.own].some((friction) => friction.id === frictionId);
}

/**
 * Makes one of the operator's frictions from what submit_friction takes.
 * @param id - Its id.
 * @param sent - What the call sent.
 * @param foundIn - The run or session it was found in.
 * @returns The friction.
 */
function ownFriction(id: string, sent: Record<string, unknown>, foundIn: OwnFriction["foundIn"]): OwnFriction {
  return {
    id,
    title: typeof sent.title === "string" ? sent.title : null,
    description: String(sent.description),
    frequency: String(sent.frequency),
    impact: String(sent.impact),
    severity: sent.severity as Severity,
    tags: Array.isArray(sent.tags) ? (sent.tags as string[]) : [],
    discoveredAt: new Date().toISOString(),
    affectedSessionCount: typeof sent.affectedSessionCount === "number" ? sent.affectedSessionCount : null,
    reviewedSessionCount: typeof sent.reviewedSessionCount === "number" ? sent.reviewedSessionCount : null,
    solutions: [],
    lastReviewedAt: null,
    lastCloudReviewedAt: null,
    foundIn,
  };
}

/**
 * Stores a friction the way Quotient does: one sent with its id, or with a
 * description already found in the same run or session, updates that
 * friction; one the operator reported elsewhere is already reported and
 * isn't stored again; any other is new.
 * @param state - The stand-in's state.
 * @param sent - What the call sent.
 * @param foundIn - The run or session it was found in.
 * @returns What was done, and the friction's id.
 */
function storeFriction(state: State, sent: Record<string, unknown>, foundIn: { runId: string } | { sessionId: string }): { status: "new" | "updated" | "alreadyReported"; frictionId: string } {
  const sameFinding = (friction: OwnFriction) => JSON.stringify(friction.foundIn) === JSON.stringify(foundIn);
  const known = state.own.find((friction) => sameFinding(friction) && (friction.id === sent.frictionId || friction.description === sent.description));
  if (known !== undefined) {
    Object.assign(known, ownFriction(known.id, sent, foundIn));
    return { status: "updated", frictionId: known.id };
  }
  const elsewhere = state.own.find((friction) => friction.description === sent.description);
  if (elsewhere !== undefined) return { status: "alreadyReported", frictionId: elsewhere.id };
  const friction = ownFriction(newId(state), sent, foundIn);
  state.own.push(friction);
  return { status: "new", frictionId: friction.id };
}

/**
 * Lists the operator's frictions as list_my_frictions shows them, without
 * where each was found.
 * @param frictions - The frictions.
 * @returns Their views.
 */
const views = (frictions: OwnFriction[]): Omit<OwnFriction, "foundIn">[] => frictions.map(({ foundIn: _, ...view }) => view);

/**
 * Tells whether a time falls on today, in UTC, as Quotient's
 * `notReviewedToday` reads it.
 * @param time - The time, or null.
 * @returns Whether it's today.
 */
const isToday = (time: string | null): boolean => time !== null && time.slice(0, 10) === new Date().toISOString().slice(0, 10);

const CLOUD_OUTCOMES = ["fixed", "no-longer-applies"];

/**
 * Records an answer to a friction, as Quotient does: the first answer counts.
 * @param state - The stand-in's state.
 * @param frictionId - The friction answered.
 * @returns The answer's status.
 */
function recordAnswer(state: State, frictionId: string): "recorded" | "alreadyRecorded" {
  if (state.answered.has(frictionId)) return "alreadyRecorded";
  state.answered.add(frictionId);
  return "recorded";
}

const RUN_ID = { type: "string", description: "The `runId` start_setup_run gave." };
const SOURCE = { type: "string", enum: ["local", "cloud"] };
const ANSWER = { type: "object", properties: { frictionId: { type: "string" }, description: { type: "string" }, prompt: { type: "string" } }, required: ["frictionId"] };
const UNKNOWN_FRICTION = "No friction you or a teammate raised has this id.";
const FRICTION = {
  type: "object",
  properties: {
    runId: RUN_ID,
    frictionId: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    frequency: { type: "string" },
    impact: { type: "string", enum: ["SAFETY", "QUALITY", "BLOCKED", "OPERATOR_ATTENTION", "COST", "TIME"] },
    severity: { type: "string", enum: ["high", "medium", "low"] },
    tags: { type: "array", items: { type: "string" } },
    affectedSessionCount: { type: "number" },
    reviewedSessionCount: { type: "number" },
    repository: { type: "string" },
    origin: { type: "string", enum: ["setup", "review", "live"] },
  },
  required: ["description", "frequency", "impact", "severity", "tags", "origin"],
};

const TOOLS: Record<string, Tool> = {
  list_teammate_frictions: {
    description: "List the frictions the signed-in user's teammates raised in the last 14 days that the user hasn't answered, at most 50, in one reply. `nextCursor` is always null.",
    inputSchema: { type: "object", properties: { repository: { type: "string" } } },
    answer: (state) => ok({ frictions: state.teammates, nextCursor: null }),
  },
  submit_solutions: {
    description: "Answer up to 100 frictions in one call, each with the fix found for it. Replies with `answers`, one per friction in the order given, each with its `frictionId` and a `status` of `recorded`, `alreadyRecorded` or `refused`, and a refused answer's `reason`. When every answer is refused, the reply is an error that lists them.",
    inputSchema: { type: "object", properties: { answers: { type: "array", items: ANSWER }, source: SOURCE }, required: ["answers", "source"] },
    answer(state, args) {
      const answers = (args.answers as Record<string, unknown>[] | undefined) ?? [];
      const outcomes = answers.map(({ frictionId }) =>
        isKnownFriction(state, frictionId)
          ? { frictionId, status: recordAnswer(state, String(frictionId)) }
          : { frictionId, status: "refused", reason: UNKNOWN_FRICTION },
      );
      const reply = JSON.stringify({ answers: outcomes });
      return outcomes.every((outcome) => outcome.status === "refused") ? refuse(`None of these answers was recorded. ${reply}`) : ok({ answers: outcomes });
    },
  },
  submit_solution: {
    description: "Answer one of the signed-in user's own or teammates' frictions with the fix found for it. An answer to a teammate's friction with neither a description nor a prompt records that nothing was found.",
    inputSchema: { type: "object", properties: { ...ANSWER.properties, source: SOURCE }, required: ["frictionId", "source"] },
    answer(state, args) {
      if (!isKnownFriction(state, args.frictionId)) return refuse(`No friction you or a teammate raised has the id ${String(args.frictionId)}. Nothing was recorded.`);
      return ok({ status: recordAnswer(state, String(args.frictionId)) });
    },
  },
  start_setup_run: {
    description: "Start the signed-in user's setup run, or resume their unfinished one. Replies with the run's id, the sources it already reviewed, the frictions it already submitted, and the frictions the user reported outside it.",
    inputSchema: { type: "object", properties: { cursor: { type: "string" } } },
    answer(state) {
      state.run ??= { runId: newId(state), startedAt: new Date().toISOString(), reviewedSources: [], alreadyReported: new Set() };
      const { runId, startedAt, reviewedSources } = state.run;
      const inRun = (friction: OwnFriction) => friction.foundIn !== null && "runId" in friction.foundIn && friction.foundIn.runId === runId;
      const brief = ({ id, description }: OwnFriction) => ({ id, description });
      return ok({
        runId,
        startedAt,
        reviewedSources,
        frictionsInRun: state.own.filter(inRun).map(brief),
        joinedCompany: null,
        reportedFrictions: state.own.filter((friction) => !inRun(friction)).map(brief),
        nextCursor: null,
      });
    },
  },
  record_setup_progress: {
    description: "Record the sessions and routine runs a batch reviewed, and the ids of earlier frictions it found again. Replies with how many sources the run has reviewed.",
    inputSchema: {
      type: "object",
      properties: { runId: RUN_ID, sources: { type: "array", items: { type: "string" } }, skippedFrictionIds: { type: "array", items: { type: "string" } } },
      required: ["runId"],
    },
    answer(state, args) {
      const run = openRun(state, args.runId);
      if (run === undefined) return refuse(unknownRun(args.runId));
      for (const source of (args.sources as string[] | undefined) ?? []) if (!run.reviewedSources.includes(source)) run.reviewedSources.push(source);
      return ok({ reviewedSourceCount: run.reviewedSources.length });
    },
  },
  submit_frictions: {
    description: "Submit up to 100 frictions in one call. Replies with `frictions`, one per friction in the order given, each with a `status` and the friction's id, or a refused friction's `reason`. When every friction is refused, the reply is an error that lists them.",
    inputSchema: { type: "object", properties: { frictions: { type: "array", items: FRICTION } }, required: ["frictions"] },
    answer(state, args) {
      const outcomes = ((args.frictions as Record<string, unknown>[] | undefined) ?? []).map((friction) => {
        const run = openRun(state, friction.runId);
        if (run === undefined) return { status: "refused", reason: unknownRun(friction.runId) };
        const stored = storeFriction(state, friction, { runId: run.runId });
        if (stored.status === "alreadyReported") run.alreadyReported.add(stored.frictionId);
        return stored;
      });
      const reply = JSON.stringify({ frictions: outcomes });
      return outcomes.every((outcome) => outcome.status === "refused") ? refuse(`None of these frictions was recorded. ${reply}`) : ok({ frictions: outcomes });
    },
  },
  finish_setup_run: {
    description: "Finish the signed-in user's setup run once every source is recorded and every friction submitted. Replies with `counts` of the run's frictions by severity, `newCount` and `alreadyReportedCount`.",
    inputSchema: { type: "object", properties: { runId: RUN_ID }, required: ["runId"] },
    answer(state, args) {
      const run = openRun(state, args.runId);
      if (run === undefined) return refuse(unknownRun(args.runId));
      state.run = undefined;
      const frictions = state.own.filter((friction) => friction.foundIn !== null && "runId" in friction.foundIn && friction.foundIn.runId === run.runId);
      const count = (severity: Severity) => frictions.filter((one) => one.severity === severity).length;
      return ok({ counts: { high: count("high"), medium: count("medium"), low: count("low"), other: 0 }, newCount: frictions.length, alreadyReportedCount: run.alreadyReported.size });
    },
  },
  list_my_frictions: {
    description: "List the signed-in user's own frictions from the last 30 days with the fixes found for them. Status `open` returns the frictions with no implemented fix, `withTeammateFix` the ones a teammate found a fix for, and `all` every one. Format `json` returns the frictions with their fixes, `rows` one row per friction with a teammate's fix. When `nextCursor` isn't null, call again with it for the next page.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "withTeammateFix", "all"] },
        format: { type: "string", enum: ["json", "rows", "table"] },
        notReviewedToday: { type: "boolean" },
        source: SOURCE,
        cursor: { type: "string" },
      },
    },
    answer(state, args) {
      // No teammate has a fix for the operator's frictions here, so there are
      // no rows, and withTeammateFix finds none.
      if (args.format === "rows") return ok({ frictions: [], nextCursor: null });
      if (args.format === "table") return refuse("The stand-in serves list_my_frictions only as json or rows.");
      const reviewedAt = (friction: OwnFriction) => (args.source === "cloud" ? friction.lastCloudReviewedAt : friction.lastReviewedAt);
      const listed = state.own.filter((friction) => args.status !== "withTeammateFix" && !(args.notReviewedToday === true && isToday(reviewedAt(friction))));
      return ok({ frictions: views(listed), nextCursor: null });
    },
  },
  submit_friction: {
    description: "Submit one friction as the signed-in user's: from a setup run, with its `runId`, or found reviewing a session, with its `sessionId`. To update one already submitted in the same run or session, send its `frictionId`. Replies with `status` (`new`, `updated` or `alreadyReported`) and the friction's id.",
    inputSchema: { type: "object", properties: { ...FRICTION.properties, sessionId: { type: "string" } }, required: FRICTION.required },
    answer(state, args) {
      if (typeof args.sessionId === "string") return ok(storeFriction(state, args, { sessionId: args.sessionId }));
      const run = openRun(state, args.runId);
      return run === undefined ? refuse(unknownRun(args.runId)) : ok(storeFriction(state, args, { runId: run.runId }));
    },
  },
  submit_review: {
    description: "Record a review of one of the signed-in user's own frictions. Outcome `fixed` or `no-longer-applies` needs a description. `teammate-fix` needs its solutionId. `open` records only that the friction was reviewed.",
    inputSchema: {
      type: "object",
      properties: {
        frictionId: { type: "string" },
        outcome: { type: "string", enum: ["fixed", "no-longer-applies", "teammate-fix", "open"] },
        description: { type: "string" },
        solutionId: { type: "string" },
        source: SOURCE,
      },
      required: ["frictionId", "outcome", "source"],
    },
    answer(state, args) {
      const { frictionId, outcome, source } = args;
      if (source === "cloud" && !CLOUD_OUTCOMES.includes(String(outcome))) return refuse("A cloud run records only frictions it fixed or that no longer apply. Leave this friction for a local run.");
      if (CLOUD_OUTCOMES.includes(String(outcome)) && String(args.description ?? "").trim() === "") {
        return refuse("A fixed or no-longer-applies review needs a description of what was fixed or why it no longer applies. Nothing was recorded.");
      }
      if (outcome === "teammate-fix" && args.solutionId === undefined) return refuse("A teammate-fix review needs the solutionId of the teammate's fix that was implemented. Nothing was recorded.");
      const friction = state.own.find((one) => one.id === frictionId);
      if (friction === undefined) return refuse(`None of your frictions has the id ${String(frictionId)}. Nothing was recorded.`);
      if (outcome === "teammate-fix") return refuse(`Friction ${String(frictionId)} has no teammate's fix with the id ${String(args.solutionId)}. Nothing was recorded.`);
      friction[source === "cloud" ? "lastCloudReviewedAt" : "lastReviewedAt"] = new Date().toISOString();
      return ok({ status: "recorded", outcome });
    },
  },
  // The mod calls these itself. No daily run is ever due, so a check never
  // starts quotient's background runs beside the skill it runs.
  claim_daily_run: {
    description: "Claim today's daily run of a kind. Replies with `due`, and the run's `runId` when one is due.",
    inputSchema: { type: "object", properties: { kind: { type: "string" }, source: SOURCE, repository: { type: "string" } }, required: ["kind", "source"] },
    answer: () => ok({ due: false }),
  },
  complete_daily_run: {
    description: "Complete a daily run this user holds.",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, outcome: { type: "string" } }, required: ["runId", "outcome"] },
    answer: () => refuse("The signed-in user holds no daily run with that runId. It may have been resumed by a later claim after its lease ran out."),
  },
  record_usage: {
    description: "Record the plugin's skill usage. Replies with how many requests were stored and how many were duplicates.",
    inputSchema: { type: "object", properties: { requests: { type: "array", items: { type: "object" } } }, required: ["requests"] },
    answer: (_, args) => ok({ storedCount: ((args.requests as unknown[] | undefined) ?? []).length, duplicateCount: 0 }),
  },
  list_thank_yous: {
    description: "List the thank-yous teammates sent the signed-in user that haven't been marked delivered.",
    inputSchema: { type: "object", properties: {} },
    answer: () => ok({ thankYous: [] }),
  },
  mark_thank_yous_delivered: {
    description: "Mark thank-yous from list_thank_yous delivered. Replies with `marked`, how many this call marked.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    answer: () => ok({ marked: 0 }),
  },
  // Setup's summary shows the invite. A link on a reserved domain can't
  // lead anyone anywhere if a check's output is shared.
  get_invite_link: {
    description: "Get the signed-in user's company name, its AgEx invite link, the email domain it accepts, the seats taken and the seat limit.",
    inputSchema: { type: "object", properties: {} },
    answer: () => ok({ companyName: "Stand-in Company", inviteUrl: "https://quotient.example.test/join/stand-in", emailDomain: "example.test", memberCount: 1, maxSeats: null }),
  },
};

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
  const state: State = { calls: [], ids: [], run: undefined, own: [], teammates: [], answered: new Set() };
  state.own = [
    { description: "The agent re-ran the whole test suite after every one-line change", severity: "medium", impact: "TIME" },
    { description: "The agent asked for permission to read files it had already read", severity: "low", impact: "OPERATOR_ATTENTION" },
  ].map((sent) => ownFriction(newId(state), { ...sent, frequency: "5 of 30 sessions", tags: [], affectedSessionCount: 5, reviewedSessionCount: 30 }, null));
  const [priya, tomas, wen] = TEAMMATES as [(typeof TEAMMATES)[number], (typeof TEAMMATES)[number], (typeof TEAMMATES)[number]];
  state.teammates = [
    {
      title: "Lint ran only in CI",
      description: `${priya.name} (${priya.email}) saw the agent push code that failed lint, because no hook ran the linter before a commit.`,
      severity: "medium",
      impact: "QUALITY",
    },
    {
      title: "Permission prompts for read-only git commands",
      description: `The agent stopped to ask before every git status and git diff. Reported by ${tomas.name}; contact ${tomas.email}.`,
      severity: "low",
      impact: "TIME",
    },
    {
      title: "Tests ran without the project's filter",
      description: `Per ${wen.name} <${wen.email}>, the agent ran the whole test suite when the change touched one package.`,
      severity: "medium",
      impact: "TIME",
    },
  ].map((friction) => ({
    id: newId(state),
    ...friction,
    frequency: "4 of 20 sessions",
    tags: [],
    discoveredAt: new Date().toISOString(),
    affectedSessionCount: 4,
    reviewedSessionCount: 20,
  }));
  const server = createServer((request, response) => {
    serve(state, request, response).catch(() => response.writeHead(400).end());
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls: () => [...state.calls],
    bait: () => ({ ids: [...state.ids], names: TEAMMATES.map((one) => one.name), emails: TEAMMATES.map((one) => one.email) }),
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
 * @throws When there's no token, or its saved file is readable by others.
 */
export function runEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; configDir: string } {
  const token = base.CLAUDE_CODE_OAUTH_TOKEN || savedToken(base);
  // realpath: on macOS mkdtemp gives /var/..., but Claude Code reports /private/var/...
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "quotient-check-config-")));
  // Claude Code deletes transcripts older than cleanupPeriodDays (30 unless
  // set) in the background as it starts, which would take the fixture's
  // dated sessions before setup lists them.
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 100_000 }));
  return { env: { ...base, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: configDir, ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, configDir };
}

/**
 * Reads the token saved for the checks. A file, unlike an exported env var,
 * leaves the operator's own `claude` sessions on their usual sign-in.
 * @param base - The environment whose config folder holds the file.
 * @returns The token.
 * @throws When the file is missing or empty, or anyone else can read it.
 */
function savedToken(base: NodeJS.ProcessEnv): string {
  const config = base.XDG_CONFIG_HOME || (base.HOME && join(base.HOME, ".config"));
  const file = config ? join(config, "quotient", "check-token") : "$XDG_CONFIG_HOME/quotient/check-token";
  const token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (token === "") throw new Error(`set CLAUDE_CODE_OAUTH_TOKEN, or save it in ${file}, from \`claude setup-token\` first`);
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`others can read ${file}: run chmod 600 on it`);
  return token;
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
