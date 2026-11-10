import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const CONFIG = '/home/op/.claude'
const RUNS = '/home/op/.local/share/quotient'
const REPO = '/home/op/code/app'
const AGEX = 'mcp__plugin_quotient_agex__'

/**
 * Answers what the guard reads beneath it: the environment, the session's
 * folder, the folders and repos the reach lookup prints, real paths (a link
 * under the config folder leads to ~/.ssh), the running agents, and the
 * session's own verdict, which allows every call.
 *
 * @param on - The test's `on`
 * @param opts - The daily run's kind, if any, the subagents running, whether the folder lookup fails,
 *   the exit code of the check for teammates' text by transcript (1, none, when not given), and
 *   paths that can't be resolved
 * @returns What the guard asked for
 */
function engine(on: On, opts: {
    kind?: string
    agents?: { id: string; type: string }[]
    cwdFails?: boolean
    grepExit?: Record<string, number>
    missing?: string[]
    below?: Awaited<ReturnType<Engine['tool']['check']>>
    links?: Record<string, string>
  } = {}) {
  const seen = { lookups: 0 }
  mock.env(on, opts.kind === undefined ? { HOME: '/home/op' } : { HOME: '/home/op', QUOTIENT_DAILY_RUN_KIND: opts.kind })
  on('session.cwd', () => {
    if (opts.cwdFails) throw new Error('no folder')
    return { value: RUNS }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'grep') {
      const exitCode = opts.grepExit?.[e.argv.at(-1) ?? ''] ?? 1
      return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const script = e.argv[2] ?? ''
    seen.lookups += script.startsWith('printf') ? 1 : 0
    const stdout = script.startsWith('printf')
      ? `${CONFIG}\n/home/op\n${RUNS}\n`
      : script.startsWith('find')
        ? `${CONFIG}/projects/-home-op-code-app/1.jsonl\n${CONFIG}/projects/-private-tmp-probe/2.jsonl\n`
        : `${REPO}\n/home/op\n/\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', (_, e) => {
    if (opts.missing?.includes(e.path)) throw new Error('ENOENT')
    const path = opts.links?.[e.path] ?? (e.path === `${CONFIG}/skills/link` ? '/home/op/.ssh/id_rsa' : e.path)
    const kind = /\.\w+$/.test(path) ? 'file' : 'dir'
    return { value: { kind, size: 1, mtimeMs: 0, isLink: path !== e.path, realPath: path } }
  })
  on('agent.list', () => ({ value: (opts.agents ?? []).map(agent => ({ ...agent, description: '', status: 'running' })) }))
  on('command.run', () => ({ text: 'ran' }))
  on('tool.check', () => opts.below ?? { decision: 'allow' })
  return seen
}

/**
 * Asks the guard about a model call.
 *
 * @param $ - The engine
 * @param tool - The tool
 * @param input - Its input
 * @param agentId - The subagent that made it, if any
 * @returns The decision
 */
async function check($: Engine, tool: string, input: Record<string, unknown> = {}, agentId?: string) {
  const verdict = await $.tool.check({ tool, input, ...(agentId === undefined ? {} : { agentId }) } as Parameters<Engine['tool']['check']>[0])
  return verdict.decision
}

test("an operator's own session is left alone: any tool, any read", async ($, on) => {
  engine(on)

  expect(await check($, 'Bash', { command: 'ls' })).toBe('allow')
  expect(await check($, 'mcp__slack__send_message')).toBe('allow')
  expect(await check($, 'Read', { file_path: '/home/op/.ssh/id_rsa' })).toBe('allow')
})

test("a daily run may call only its own Quotient tools, whatever the operator's rules allow", async ($, on) => {
  engine(on, { kind: 'find-solutions' })

  expect(await check($, `${AGEX}list_teammate_frictions`)).toBe('allow')
  expect(await check($, `${AGEX}submit_solutions`)).toBe('allow')
  expect(await check($, 'mcp__claude_ai_Quotient__submit_solution')).toBe('allow')
  expect(await check($, 'ToolSearch', { query: 'select:x' })).toBe('allow')
  expect(await check($, 'Skill', { skill: 'quotient:find-solutions' })).toBe('allow')
  for (const tool of ['Bash', 'Write', 'mcp__slack__send_message', `${AGEX}submit_friction`, 'mcp__claude_ai_Linear__list_teams']) {
    expect(await check($, tool)).toBe('deny')
  }
  expect(await check($, 'Skill', { skill: 'quotient:setup' })).toBe('deny')
  expect(await check($, 'Skill', { skill: 'find-solutions' })).toBe('deny')
  expect(await check($, 'Skill', { skill: '/Quotient:Find-Solutions' })).toBe('allow')
})

test('a find-solutions run reads only the config folder, and never a repo', async ($, on) => {
  engine(on, { kind: 'find-solutions' })

  expect(await check($, 'Read', { file_path: `${CONFIG}/CLAUDE.md` })).toBe('allow')
  expect(await check($, 'Grep', { pattern: 'x', path: `${CONFIG}/projects/-home-op-code-app` })).toBe('allow')
  expect(await check($, 'Read', { file_path: `${REPO}/package.json` })).toBe('deny')
  expect(await check($, 'Read', { file_path: '/home/op/.ssh/id_rsa' })).toBe('deny')
  expect(await check($, 'Read', { file_path: `${CONFIG}/.credentials.json` })).toBe('deny')
})

test('a sandboxed agent searches the user settings with Grep and never reads them whole', async ($, on) => {
  engine(on, { kind: 'find-solutions' })

  expect(await check($, 'Grep', { pattern: 'PreToolUse', path: `${CONFIG}/settings.json` })).toBe('allow')
  expect(await check($, 'Read', { file_path: `${CONFIG}/settings.json` })).toBe('deny')
  expect(await check($, 'Read', { file_path: '~/.claude/settings.json' })).toBe('deny')
  expect(await check($, 'Read', { file_path: `${CONFIG}/settings.json`, limit: 2000 })).toBe('deny')
})

test('user settings linked into a readable repo are still never read whole', async ($, on) => {
  const target = `${REPO}/dotfiles/claude/settings.json`
  engine(on, { kind: 'review-frictions', links: { [`${CONFIG}/settings.json`]: target } })

  expect(await check($, 'Read', { file_path: target })).toBe('deny')
  expect(await check($, 'Read', { file_path: `${CONFIG}/settings.json` })).toBe('deny')
  expect(await check($, 'Read', { file_path: `${REPO}/package.json` })).toBe('allow')
})

test("the teammate check may send a page of answers in one call", async ($, on) => {
  engine(on, { agents: [{ id: 'a1', type: 'quotient:teammate-check' }] })

  expect(await check($, `${AGEX}submit_solutions`, {}, 'a1')).toBe('allow')
  expect(await check($, 'Read', { file_path: `${CONFIG}/settings.json` }, 'a1')).toBe('deny')
})

test('a link that leads outside is judged by where it lands', async ($, on) => {
  engine(on, { kind: 'find-solutions' })

  expect(await check($, 'Read', { file_path: `${CONFIG}/skills/link` })).toBe('deny')
})

test("a review-frictions run also reads its sessions' repos, one file at a time, never their secrets", async ($, on) => {
  engine(on, { kind: 'review-frictions' })

  expect(await check($, `${AGEX}submit_review`)).toBe('allow')
  expect(await check($, `${AGEX}submit_solution`)).toBe('deny')
  expect(await check($, 'Read', { file_path: `${REPO}/package.json` })).toBe('allow')
  expect(await check($, 'Read', { file_path: `${REPO}/.claude/settings.local.json` })).toBe('allow')
  expect(await check($, 'Read', { file_path: `${REPO}/.env` })).toBe('deny')
  expect(await check($, 'Grep', { pattern: 'x', path: REPO })).toBe('deny')
  expect(await check($, 'Glob', { pattern: '**/*.yml', path: REPO })).toBe('allow')
})

test('the home folder and the root are never repos, even when a session ran there', async ($, on) => {
  engine(on, { kind: 'review-frictions' })

  expect(await check($, 'Read', { file_path: '/home/op/notes.txt' })).toBe('deny')
  expect(await check($, 'Read', { file_path: '/etc/hosts' })).toBe('deny')
})

test('the reach is looked up once per session', async ($, on) => {
  const seen = engine(on, { kind: 'review-frictions' })

  await check($, 'Read', { file_path: `${REPO}/a.json` })
  await check($, 'Read', { file_path: `${REPO}/b.json` })

  expect(seen.lookups).toBe(1)
})

test("setup's teammate-check subagent is held to its tools and the config folder; other subagents aren't", async ($, on) => {
  engine(on, { agents: [{ id: 'a1', type: 'quotient:teammate-check' }, { id: 'a2', type: 'general-purpose' }] })

  expect(await check($, `${AGEX}submit_solution`, {}, 'a1')).toBe('allow')
  expect(await check($, 'Read', { file_path: `${CONFIG}/CLAUDE.md` }, 'a1')).toBe('allow')
  expect(await check($, 'Read', { file_path: `${REPO}/package.json` }, 'a1')).toBe('deny')
  expect(await check($, 'Bash', { command: 'ls' }, 'a1')).toBe('deny')
  expect(await check($, `${AGEX}submit_friction`, {}, 'a1')).toBe('deny')
  expect(await check($, 'Bash', { command: 'ls' }, 'a2')).toBe('allow')
})

test("a subagent of any other type can't reach teammates' frictions, whichever type the model started", async ($, on) => {
  engine(on, { agents: [{ id: 'a2', type: 'general-purpose' }] })

  expect(await check($, 'Skill', { skill: 'quotient:find-solutions' }, 'a2')).toBe('deny')
  expect(await check($, 'Skill', { skill: 'find-solutions' }, 'a2')).toBe('deny')
  expect(await check($, `${AGEX}list_teammate_frictions`, {}, 'a2')).toBe('deny')
  expect(await check($, 'mcp__claude_ai_Quotient__submit_solution', {}, 'a2')).toBe('deny')
  expect(await check($, 'Skill', { skill: 'quotient:find-solutions' })).toBe('allow')
})

test("a daily run of an unknown kind may call none of Quotient's tools", async ($, on) => {
  engine(on, { kind: 'something-else' })

  expect(await check($, `${AGEX}submit_solution`)).toBe('deny')
})

test('a check that fails in a daily run denies the call', async ($, on) => {
  engine(on, { kind: 'find-solutions', cwdFails: true })

  expect(await check($, 'Read', { file_path: `${CONFIG}/settings.json` })).toBe('deny')
})

const SENDS = ['submit_friction', 'submit_solution', 'submit_review']
const CONNECTOR = 'mcp__claude_ai_Quotient__'

/**
 * Asks the guard about a model call and returns its whole verdict.
 *
 * @param $ - The engine
 * @param tool - The tool
 * @param input - Its input
 * @param agentId - The subagent that made it, if any
 * @returns The verdict
 */
async function verdict($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) {
  return $.tool.check({ tool, input, ...(agentId === undefined ? {} : { agentId }) } as Parameters<Engine['tool']['check']>[0])
}

test("a send to Quotient whose text holds a home path, an email or a secret is refused in the operator's session, under any server's name", async ($, on) => {
  engine(on)

  for (const prefix of [AGEX, CONNECTOR, 'mcp__quotient_dev__']) {
    for (const name of SENDS) {
      expect(await check($, `${prefix}${name}`, { frictionId: 'f1', description: 'Fails in /home/op/code/app' })).toBe('deny')
      expect(await check($, `${prefix}${name}`, { frictionId: 'f1', prompt: 'Ask jane@example.com' })).toBe('deny')
      expect(await check($, `${prefix}${name}`, { frictionId: 'f1', tags: ['ghp_0123456789abcdefghijABCDEFGHIJ012345'] })).toBe('deny')
    }
  }
})

test('a page of answers sent together is refused when any answer holds private text', async ($, on) => {
  engine(on, { agents: [{ id: 'a1', type: 'quotient:teammate-check' }] })
  const clean = { frictionId: 'f1', description: 'Run lint in the pre-commit hook.', prompt: 'Add lint to .husky/pre-commit' }
  const send = (answers: Record<string, unknown>[]) => ({ answers, source: 'local' })

  expect(await check($, `${AGEX}submit_solutions`, send([clean, { frictionId: 'f2' }]), 'a1')).toBe('allow')
  expect(await check($, `${AGEX}submit_solutions`, send([clean, { frictionId: 'f2', prompt: 'Ask jane@example.com' }]), 'a1')).toBe('deny')
  const found = await verdict($, `${CONNECTOR}submit_solutions`, send([clean, { frictionId: 'f2', description: 'See /home/op/notes' }]))
  expect(JSON.stringify(found)).toContain('`answers[1].description`')
  expect(JSON.stringify(found)).not.toContain('/home/op/notes')
})

test('the refusal names the field and what it holds, never the text, and asks for a rewrite', async ($, on) => {
  engine(on)

  const found = await verdict($, `${AGEX}submit_solution`, { frictionId: 'f1', prompt: 'Ask jane@example.com' })

  expect(found.decision).toBe('deny')
  const reason = JSON.stringify(found)
  expect(reason).toContain('`prompt`')
  expect(reason).toContain('an email address')
  expect(reason).toContain('Rewrite that field')
  expect(reason).not.toContain('jane@example.com')
})

test('private text is refused in a daily run and in the teammate-check subagent too', async ($, on) => {
  engine(on, { kind: 'review-frictions' })

  expect(await check($, `${AGEX}submit_review`, { frictionId: 'f1', description: 'Fixed in /Users/jane/app' })).toBe('deny')
  expect(await check($, `${AGEX}submit_review`, { frictionId: 'f1', description: 'Fixed in .husky/pre-commit' })).toBe('allow')
})

test('the teammate-check subagent may send a clean answer, never one with private text', async ($, on) => {
  engine(on, { agents: [{ id: 'a1', type: 'quotient:teammate-check' }] })

  expect(await check($, `${AGEX}submit_solution`, { frictionId: 'f1', prompt: 'Edit ~/.claude/settings.json' }, 'a1')).toBe('allow')
  expect(await check($, `${AGEX}submit_solution`, { frictionId: 'f1', prompt: 'Edit /home/op/.claude/settings.json' }, 'a1')).toBe('deny')
})

test('clean sends, other Quotient tools and other tools are left to the checks beneath', async ($, on) => {
  engine(on)

  expect(await check($, `${AGEX}submit_friction`, { title: 'Lint fails in CI after passing on commit', tags: ['ci'] })).toBe('allow')
  expect(await check($, `${AGEX}list_my_frictions`, { cursor: 'jane@example.com' })).toBe('allow')
  expect(await check($, 'mcp__slack__send_message', { text: 'jane@example.com' })).toBe('allow')
})

test("a send to Quotient is refused when the home folder can't be read, and other tools aren't", async ($, on) => {
  on('env.get', (_, e) => {
    if (e.name === 'HOME') throw new Error('no home')
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.check', () => ({ decision: 'allow' }))

  expect(await check($, `${AGEX}submit_friction`, { title: 'Lint fails in CI' })).toBe('deny')
  expect(await check($, 'Bash', { command: 'ls' })).toBe('allow')
})

const SHOWN = `${CONFIG}/projects/-home-op-code-app/fixes.jsonl`
const PLAIN = `${CONFIG}/projects/-home-op-code-app/plain.jsonl`

const COMMAND = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

test("after review-frictions or setup starts, a transcript that holds teammates' fixes isn't read, until fix-friction or list-fixes", async ($, on) => {
  engine(on, { grepExit: { [SHOWN]: 0, [`${CONFIG}/projects`]: 0 } })

  expect(await check($, 'Read', { file_path: SHOWN })).toBe('allow')
  await $.command.run({ ...COMMAND, command: 'quotient:review-frictions' })

  expect(await check($, 'Read', { file_path: SHOWN })).toBe('deny')
  expect(await check($, 'Read', { file_path: PLAIN })).toBe('allow')
  expect(await check($, 'Grep', { pattern: 'x', path: SHOWN })).toBe('deny')
  expect(await check($, 'Read', { file_path: '/home/op/code/app/notes.md' })).toBe('allow')

  await $.command.run({ ...COMMAND, command: 'quotient:fix-friction' })
  expect(await check($, 'Read', { file_path: SHOWN })).toBe('allow')
})

test('a Grep of the projects folder, or a folder holding it, counts as reading every transcript', async ($, on) => {
  engine(on, { grepExit: { [`${CONFIG}/projects`]: 0 } })
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'Grep', { pattern: 'x', path: `${CONFIG}/projects` })).toBe('deny')
  expect(await check($, 'Grep', { pattern: 'x', path: CONFIG })).toBe('deny')
  expect(await check($, 'Grep', { pattern: 'x', path: '/home/op' })).toBe('deny')
  expect(await check($, 'Grep', { pattern: 'x', path: '/' })).toBe('deny')
  expect(await check($, 'Grep', { pattern: 'x', path: '/home/op/code/app' })).toBe('allow')
})

test("once setup holds transcripts back, a Bash command naming them is refused while one holds teammates' fixes", async ($, on) => {
  engine(on, { grepExit: { [`${CONFIG}/projects`]: 0 } })
  const bash = async (command: string) => check($, 'Bash', { command })

  expect(await bash('grep -r x ~/.claude/projects')).toBe('allow')
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await bash('grep -r x ~/.claude/projects')).toBe('deny')
  expect(await bash(`cat ${SHOWN}`)).toBe('deny')
  expect(await bash('cd ~/.claude && grep -rl x projects')).toBe('deny')
  expect(await bash('jq . "$CLAUDE_CONFIG_DIR/projects/-home-op-code-app/plain.jsonl"')).toBe('deny')
  expect(await check($, 'Bash', { command: 'grep -r x ~/.claude/projects' }, 'sub-1')).toBe('deny')
  expect(await bash('cat ~/.claude/settings.json')).toBe('allow')
  expect(await bash('git status')).toBe('allow')
})

test('once setup holds transcripts back, a Bash command naming them goes on when none holds teammate text', async ($, on) => {
  engine(on)
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'Bash', { command: 'grep -r x ~/.claude/projects' })).toBe('allow')
})

test("the refusal of a Bash command naming transcripts points to Read, not Grep, which a session may lack", async ($, on) => {
  engine(on, { grepExit: { [`${CONFIG}/projects`]: 0 } })
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: `cat ${SHOWN}` } } as Parameters<Engine['tool']['check']>[0])

  expect(verdict.reason).toContain('read transcripts with Read, one session at a time')
  expect(verdict.reason).not.toContain('Grep')
})

test("setup's reviewer subagent reads the listed sessions, but never a transcript that holds teammates' fixes or teammates' frictions", async ($, on) => {
  engine(on, { agents: [{ id: 'rev-1', type: 'quotient:setup-reviewer' }], grepExit: { [SHOWN]: 0 } })
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'Read', { file_path: SHOWN }, 'rev-1')).toBe('deny')
  expect(await check($, 'Read', { file_path: PLAIN }, 'rev-1')).toBe('allow')
  expect(await check($, 'mcp__quotient__setup_digest', { source: 'plain' }, 'rev-1')).toBe('allow')
  expect(await check($, `${AGEX}list_teammate_frictions`, {}, 'rev-1')).toBe('deny')
})

const DEFAULT_ASK = { decision: 'ask', reason: "Claude requested permissions to use Agent, but you haven't granted it yet." } as const
const REVIEWER = { subagent_type: 'quotient:setup-reviewer', description: 'Review batch 1', prompt: 'Review these sources.' }

test("during setup, the main agent's start of a setup-reviewer is allowed in place of Claude Code's default ask", async ($, on) => {
  engine(on, { below: DEFAULT_ASK })
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'Agent', REVIEWER)).toBe('allow')
})

for (const [why, below] of [
  ['an ask rule', { decision: 'ask', rule: 'Agent' }],
  ['a deny rule', { decision: 'deny', rule: 'Agent' }],
  ["a settings hook's ask", { decision: 'ask', hook: 'PreToolUse' }],
  ["another plugin's ask", { decision: 'ask', plugin: 'another-plugin' }],
] as const) {
  test(`the operator's ${why} for Agent stands over a setup-reviewer start`, async ($, on) => {
    engine(on, { below })
    await $.command.run({ ...COMMAND, command: 'quotient:setup' })

    expect(await check($, 'Agent', REVIEWER)).toBe(below.decision)
  })
}

test('no other Agent start is allowed: outside setup, from a subagent, or of another type', async ($, on) => {
  engine(on, { below: DEFAULT_ASK })
  expect(await check($, 'Agent', REVIEWER)).toBe('ask')

  await $.command.run({ ...COMMAND, command: 'quotient:setup' })
  expect(await check($, 'Agent', REVIEWER, 'sub-1')).toBe('ask')
  expect(await check($, 'Agent', { ...REVIEWER, subagent_type: 'general-purpose' })).toBe('ask')
  expect(await check($, 'Agent', { ...REVIEWER, subagent_type: 'quotient:teammate-check' })).toBe('ask')
})

const CTX_FILE = 'mcp__plugin_context-mode_context-mode__ctx_execute_file'

test("once setup holds transcripts back, another server's tool naming them is refused while one holds teammates' fixes", async ($, on) => {
  engine(on, { grepExit: { [`${CONFIG}/projects`]: 0 } })
  const ctx = async (input: Record<string, unknown>) => check($, CTX_FILE, input)

  expect(await ctx({ path: PLAIN, language: 'javascript', code: 'print(1)' })).toBe('allow')
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await ctx({ path: PLAIN, language: 'javascript', code: 'print(1)' })).toBe('deny')
  expect(await check($, 'mcp__plugin_context-mode_context-mode__ctx_execute', { code: 'cat ~/.claude/projects/*/*.jsonl' })).toBe('deny')
  expect(await check($, CTX_FILE, { path: PLAIN }, 'sub-1')).toBe('deny')
  expect(await ctx({ path: '/home/op/code/app/notes.md' })).toBe('allow')
})

test("once setup holds transcripts back, another server's tool naming them goes on when none holds teammate text", async ($, on) => {
  engine(on)
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, CTX_FILE, { path: PLAIN })).toBe('allow')
})

test("quotient's own setup_digest may name a transcript while they're held back", async ($, on) => {
  engine(on, { grepExit: { [`${CONFIG}/projects`]: 0 } })
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'mcp__quotient__setup_digest', { source: 'plain' })).toBe('allow')
})

test("a daily review-frictions run never reads a transcript that holds teammates' fixes", async ($, on) => {
  engine(on, { kind: 'review-frictions', grepExit: { [SHOWN]: 0 } })

  expect(await check($, 'Read', { file_path: SHOWN })).toBe('deny')
  expect(await check($, 'Read', { file_path: PLAIN })).toBe('allow')
})

test("a find-solutions run reads teammates' text by design, so its transcripts aren't held back", async ($, on) => {
  engine(on, { kind: 'find-solutions', grepExit: { [SHOWN]: 0 } })

  expect(await check($, 'Read', { file_path: SHOWN })).toBe('allow')
})

test("a transcript that can't be checked for teammates' fixes is refused", async ($, on) => {
  engine(on, { grepExit: { [PLAIN]: 2 } })
  await $.command.run({ ...COMMAND, command: 'quotient:review-frictions' })

  expect(await check($, 'Read', { file_path: PLAIN })).toBe('deny')
})

test("once a review holds transcripts back, a read whose check fails is refused", async ($, on) => {
  engine(on, { cwdFails: true })
  await $.command.run({ ...COMMAND, command: 'quotient:review-frictions' })

  expect(await check($, 'Read', { file_path: PLAIN })).toBe('deny')
})

test("once a review holds transcripts back, a transcript that can't be resolved is refused, and another path isn't", async ($, on) => {
  engine(on, { missing: [PLAIN, '/home/op/notes.txt'] })
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'Read', { file_path: PLAIN })).toBe('deny')
  expect(await check($, 'Read', { file_path: '/home/op/notes.txt' })).toBe('allow')
})

test("setup's session can't read the teammate check's output by its id", async ($, on) => {
  engine(on, { agents: [{ id: 'a1', type: 'quotient:teammate-check' }] })
  await check($, `${AGEX}submit_solution`, {}, 'a1')

  expect(await check($, 'Read', { file_path: '/tmp/claude-501/x/tasks/a1.output' })).toBe('deny')
  expect(await check($, 'Bash', { command: 'cat /tmp/claude-501/x/tasks/a1.output' })).toBe('deny')
  expect(await check($, 'Read', { file_path: '/tmp/claude-501/x/tasks/a2.output' })).toBe('allow')
})

test("another subagent can't read the teammate check's output by its id either", async ($, on) => {
  engine(on, { agents: [{ id: 'a1', type: 'quotient:teammate-check' }, { id: 'a2', type: 'general-purpose' }] })
  await check($, `${AGEX}submit_solution`, {}, 'a1')

  expect(await check($, 'Read', { file_path: '/tmp/claude-501/x/tasks/a1.output' }, 'a2')).toBe('deny')
})

test('once setup holds transcripts back, no background task output is read, by any path, and a repo tasks folder still is', async ($, on) => {
  engine(on)
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'Read', { file_path: '/private/tmp/claude-501/p/s/tasks/zz9.output' })).toBe('deny')
  expect(await check($, 'Bash', { command: 'cat /private/tmp/claude-501/*/tasks/*.output' })).toBe('deny')
  expect(await check($, 'Glob', { pattern: '/private/tmp/claude-501/p/s/tasks/*' })).toBe('deny')
  expect(await check($, 'Read', { file_path: '/home/op/code/app/src/tasks/run.ts' })).toBe('allow')
})

test('once setup holds transcripts back, a search from above the task outputs, or a relative path into them, is refused', async ($, on) => {
  engine(on)
  await $.command.run({ ...COMMAND, command: 'quotient:setup' })

  expect(await check($, 'Grep', { pattern: 'x', path: '/tmp' })).toBe('deny')
  expect(await check($, 'Grep', { pattern: 'x', path: '/private/tmp/claude-501' })).toBe('deny')
  expect(await check($, 'Glob', { pattern: '**/tasks/*.output', path: '/private/tmp/claude-501/p' })).toBe('deny')
  expect(await check($, 'Read', { file_path: '../../../private/tmp/claude-501/p/s/tasks/a9.output' })).toBe('deny')
  expect(await check($, 'Grep', { pattern: 'x', path: '/home/op/code/app' })).toBe('allow')
})

test("setup's teammate check may hand its report back, which quotient replaces before setup reads it", async ($, on) => {
  engine(on, { agents: [{ id: 'a1', type: 'quotient:teammate-check' }] })

  expect(await check($, 'SubagentHandback', { report: 'done' }, 'a1')).toBe('allow')
})
