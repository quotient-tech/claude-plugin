// Builds the synthetic Claude Code sessions that /quotient:setup is measured
// and checked against: plugins/quotient/tests/fixtures/setup-sessions/. Each
// planted friction is listed in that folder's MANIFEST.md. No real content.
//   node scripts/build-setup-fixture.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_ROOT = join(import.meta.dirname, "../plugins/quotient/tests/fixtures/setup-sessions");
export const PROJECT = "-fixture-quotient-setup-acme-shop";
const CWD = "/Users/op/Development/acme-shop";
const VERSION = "2.1.317";

type Step =
  | { kind: "prompt"; text: string }
  | { kind: "say"; text: string }
  | { kind: "call"; tool: string; input: Record<string, unknown>; result: string; isError?: boolean };

type Session = { id: string; start: string; entrypoint: "cli" | "sdk-cli"; steps: Step[] };

/**
 * A prompt the operator typed.
 * @param text - The prompt.
 * @returns The step.
 */
const prompt = (text: string): Step => ({ kind: "prompt", text });

/**
 * Text the agent wrote.
 * @param text - The text.
 * @returns The step.
 */
const say = (text: string): Step => ({ kind: "say", text });

/**
 * A tool call and its result.
 * @param tool - The tool's name.
 * @param input - Its input.
 * @param result - Its result text.
 * @param isError - Whether the call failed.
 * @returns The step.
 */
const call = (tool: string, input: Record<string, unknown>, result: string, isError = false): Step => ({
  kind: "call",
  tool,
  input,
  result,
  isError,
});

/**
 * A long, repetitive tool result, standing in for a large file or log.
 * @param line - One line of it.
 * @param count - How many lines.
 * @returns The text.
 */
const long = (line: string, count: number): string => Array.from({ length: count }, (_, i) => `${i + 1}\t${line}`).join("\n");

const ZSH_GLOB = call("Bash", { command: "grep -rn 'formatPrice' --include=*.ts src" }, "(eval):1: no matches found: --include=*.ts", true);

const LINT_IN_CI = [
  call("Bash", { command: "git commit -am 'Add discount codes' && git push" }, "[feat/discounts 4f2a1c9] Add discount codes\n 3 files changed"),
  call("Bash", { command: "gh run watch" }, "X lint failed: src/cart/discount.ts:14:7 no-unused-vars 'legacyRate' is assigned a value but never used", true),
  say("CI's lint step failed on an unused variable that nothing checked before the commit. I'll fix it and push again."),
  call("Edit", { file_path: `${CWD}/src/cart/discount.ts`, old_string: "const legacyRate = 0.1\n", new_string: "" }, "The file has been updated."),
  call("Bash", { command: "git commit -am 'Fix lint' && git push" }, "[feat/discounts 9b1e2d0] Fix lint"),
];

// What makes a real transcript large but holds no friction: the agent's
// thinking with its signature, and context a hook adds to each prompt. Each
// tool result is also kept twice, as Claude Code does, in `toolUseResult`.
const THINKING = "Weighing which file to open next and what the operator asked for. ".repeat(12);
const SIGNATURE = "c2lnbmF0dXJl".repeat(80);
const HOOK_CONTEXT = "Prefer the project's own scripts; keep diffs small and explain each change. ".repeat(30);

export const SESSIONS: Session[] = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    start: "2020-01-02T09:00:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("Where is the shipping rate table configured? Change the EU rate to 7.5."),
      call("Grep", { pattern: "shippingRate", path: "src" }, "No matches found"),
      call("Grep", { pattern: "shipping_rate", path: "src" }, "No matches found"),
      call("Grep", { pattern: "EU", path: "src/config" }, "No matches found"),
      call("Glob", { pattern: "**/*rate*" }, "No files found"),
      call("Grep", { pattern: "rates", path: "." }, "packages/legacy-config/rates.yaml:3:rates:"),
      call("Read", { file_path: `${CWD}/packages/legacy-config/rates.yaml` }, "rates:\n  eu: 7.0\n  us: 5.0"),
      say("The shipping rates live in packages/legacy-config/rates.yaml, outside src/, with nothing in src pointing to it."),
      call("Edit", { file_path: `${CWD}/packages/legacy-config/rates.yaml`, old_string: "eu: 7.0", new_string: "eu: 7.5" }, "The file has been updated."),
    ],
  },
  { id: "a0000000-0000-4000-8000-000000000002", start: "2020-01-03T10:00:00.000Z", entrypoint: "cli", steps: [prompt("Add discount codes to the cart."), ...LINT_IN_CI] },
  { id: "a0000000-0000-4000-8000-000000000003", start: "2020-01-05T14:00:00.000Z", entrypoint: "cli", steps: [prompt("Add a free-shipping threshold to the cart."), ...LINT_IN_CI] },
  { id: "a0000000-0000-4000-8000-000000000004", start: "2020-01-08T11:00:00.000Z", entrypoint: "cli", steps: [prompt("Let the cart apply two promotions at once."), ...LINT_IN_CI] },
  {
    id: "a0000000-0000-4000-8000-000000000005",
    start: "2020-01-04T15:00:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("Run the code reviewer on my checkout branch, then open the PR."),
      call("Agent", { subagent_type: "code-reviewer", prompt: "Review the checkout branch." }, "No issues found. The change is ready to merge."),
      call("Bash", { command: "gh pr create --fill" }, "https://github.com/acme/shop/pull/412"),
      prompt("The reviewer missed the console.log calls in src/checkout/pay.ts again. We ban console.log in src. Remove them."),
      call("Edit", { file_path: `${CWD}/src/checkout/pay.ts`, old_string: "console.log(order)\n", new_string: "" }, "The file has been updated."),
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000006",
    start: "2020-01-06T09:30:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("Fix the typo in the footer."),
      call("Read", { file_path: `${CWD}/CLAUDE.md` }, long("Always follow the house style guide section below for every change.", 900)),
      call("Edit", { file_path: `${CWD}/src/ui/Footer.tsx`, old_string: "Copyrigth", new_string: "Copyright" }, "The file has been updated."),
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000007",
    start: "2020-01-07T13:00:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("Why did last night's order import fail?"),
      call("Read", { file_path: `${CWD}/logs/import.log` }, long("INFO import batch ok", 4000)),
      call("Read", { file_path: `${CWD}/logs/import.log` }, long("INFO import batch ok", 4000)),
      call("Grep", { pattern: "ERROR", path: `${CWD}/logs/import.log` }, "3998:ERROR supplier feed timed out after 30s"),
      say("The import failed because the supplier feed timed out. I read the whole 4,000-line log twice before searching it."),
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000008",
    start: "2020-01-09T10:00:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("Verify the change before you finish, as CLAUDE.md says."),
      call("Bash", { command: "make verify" }, "make: *** No rule to make target `verify'.  Stop.", true),
      call("Bash", { command: "npm run verify" }, "npm error Missing script: \"verify\"", true),
      say("CLAUDE.md says to run `make verify`, but the repo has no such target or script. I ran the tests instead."),
      call("Bash", { command: "npm test" }, "Tests: 212 passed"),
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000009",
    start: "2020-01-10T16:00:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("The product page shows a blank screen in dev. Fix it."),
      say("I can't see the dev server's output from here. Could you paste the errors from the terminal running `npm run dev`?"),
      prompt("TypeError: Cannot read properties of undefined (reading 'price') at ProductCard.tsx:22"),
      call("Edit", { file_path: `${CWD}/src/ui/ProductCard.tsx`, old_string: "product.price", new_string: "product?.price" }, "The file has been updated."),
    ],
  },
  { id: "a0000000-0000-4000-8000-000000000010", start: "2020-01-11T09:00:00.000Z", entrypoint: "cli", steps: [prompt("Find every caller of formatPrice."), ZSH_GLOB, call("Grep", { pattern: "formatPrice", glob: "*.ts" }, "src/cart/total.ts:8\nsrc/ui/Price.tsx:4")] },
  { id: "a0000000-0000-4000-8000-000000000011", start: "2020-01-12T09:00:00.000Z", entrypoint: "cli", steps: [prompt("Is formatPrice still used in checkout?"), ZSH_GLOB, call("Grep", { pattern: "formatPrice", path: "src/checkout" }, "No matches found")] },
  {
    id: "a0000000-0000-4000-8000-000000000012",
    start: "2020-01-12T15:00:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("Rename the Basket type to Cart."),
      call("Bash", { command: "npm run typecheck" }, "Found 4 errors in 3 files."),
      call("Bash", { command: "npm run typecheck" }, "Found 0 errors."),
      say("Renamed Basket to Cart; the typecheck caught the four places I missed."),
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000013",
    start: "2020-01-13T10:00:00.000Z",
    entrypoint: "cli",
    steps: [prompt("Bump the copyright year."), call("Edit", { file_path: `${CWD}/src/ui/Footer.tsx`, old_string: "2019", new_string: "2020" }, "The file has been updated.")],
  },
  {
    id: "a0000000-0000-4000-8000-000000000014",
    start: "2020-01-13T02:00:00.000Z",
    entrypoint: "sdk-cli",
    steps: [
      prompt("Nightly: update the sitemap."),
      call("Bash", { command: "npm run sitemap" }, "sh: sitemap-gen: command not found", true),
      call("Bash", { command: "npx sitemap-gen" }, "npm error 404 Not Found - sitemap-gen", true),
      say("The sitemap script needs sitemap-gen, which isn't installed on the runner and isn't in package.json."),
    ],
  },
  {
    id: "a0000000-0000-4000-8000-000000000015",
    start: "2020-01-14T11:00:00.000Z",
    entrypoint: "cli",
    steps: [
      prompt("Show me my teammates' fixes."),
      call("mcp__plugin_quotient_agex__list_teammate_frictions", {}, '{"frictions":[{"title":"Synthetic teammate friction","fix":"Synthetic teammate fix text"}]}'),
    ],
  },
];

/**
 * Writes one session as Claude Code transcript lines.
 * @param session - The session.
 * @returns The JSONL text.
 */
export function transcript(session: Session): string {
  const lines: Record<string, unknown>[] = [];
  let parent: string | null = null;
  let time = Date.parse(session.start);
  let n = 0;
  const push = (type: "user" | "assistant" | "attachment", message: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => {
    n += 1;
    time += 7_000;
    const uuid = `${session.id.slice(0, 24)}${String(n).padStart(12, "0")}`;
    lines.push({
      parentUuid: parent,
      isSidechain: false,
      userType: "external",
      entrypoint: session.entrypoint,
      cwd: CWD,
      sessionId: session.id,
      version: VERSION,
      gitBranch: "main",
      type,
      message,
      uuid,
      timestamp: new Date(time).toISOString(),
      ...extra,
    });
    parent = uuid;
  };
  const assistant = (content: unknown[]) =>
    push(
      "assistant",
      {
        id: `msg_${session.id.slice(-6)}_${n}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "thinking", thinking: THINKING, signature: SIGNATURE }, ...content],
        usage: { input_tokens: 4, cache_creation_input_tokens: 300, cache_read_input_tokens: 12000, output_tokens: 80 },
      },
      { requestId: `req_${session.id.slice(-6)}_${n}` },
    );
  for (const step of session.steps) {
    if (step.kind === "prompt") {
      push("user", { role: "user", content: step.text });
      push("attachment", undefined, { attachment: { type: "hook_additional_context", content: HOOK_CONTEXT } });
    }
    if (step.kind === "say") assistant([{ type: "text", text: step.text }]);
    if (step.kind === "call") {
      const id = `toolu_${session.id.slice(-6)}_${n}`;
      assistant([{ type: "tool_use", id, name: step.tool, input: step.input }]);
      const result = { tool_use_id: id, type: "tool_result", content: step.result, ...(step.isError ? { is_error: true } : {}) };
      push("user", { role: "user", content: [result] }, { toolUseResult: { stdout: step.result, stderr: "", interrupted: false } });
    }
  }
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

if (import.meta.main) {
  const folder = join(FIXTURE_ROOT, PROJECT);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const session of SESSIONS) writeFileSync(join(folder, `${session.id}.jsonl`), transcript(session));
  console.log(`wrote ${SESSIONS.length} sessions to ${folder}`);
}
