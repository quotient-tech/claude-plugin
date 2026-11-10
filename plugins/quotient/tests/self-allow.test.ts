import { expect, mock, test } from 'claude-code/testing'

import { isOwnQuotientCall, ownCallVerdict } from '../hooks/self-allow'

const MOD_TOOLS = [
  'list_my_frictions',
  'mark_solution_implemented',
  'send_thank_you',
  'claim_daily_run',
  'complete_daily_run',
  'record_usage',
  'check_thank_yous',
]
// The plugin's own server, the claude.ai connector, and a server the operator
// set up by hand that Claude Code runs in place of the plugin's.
const PREFIXES = ['mcp__plugin_quotient_agex__', 'mcp__claude_ai_Quotient__', 'mcp__quotient-local__']

test("quotient's own call to each tool its mods call is its own, under any server's name", () => {
  for (const prefix of PREFIXES) {
    for (const tool of MOD_TOOLS) expect(isOwnQuotientCall('quotient', `${prefix}${tool}`)).toBe(true)
  }
})

test("the model's call to the same tools is not quotient's own", () => {
  for (const tool of MOD_TOOLS) expect(isOwnQuotientCall('engine', `mcp__plugin_quotient_agex__${tool}`)).toBe(false)
})

test("another plugin's call to the same tools is not quotient's own", () => {
  expect(isOwnQuotientCall('quotient-extra', 'mcp__plugin_quotient_agex__list_my_frictions')).toBe(false)
})

test("quotient's call to a tool its mods don't call is not covered", () => {
  for (const tool of ['Bash', 'Read', 'mcp__plugin_quotient_agex__submit_frictions', 'mcp__slack__send_list_my_frictions']) {
    expect(isOwnQuotientCall('quotient', tool)).toBe(false)
  }
})

test("Claude Code's default ask on quotient's own call becomes an allow", () => {
  const decided = ownCallVerdict({ decision: 'ask', reason: "Claude requested permissions, but you haven't granted it yet." })

  expect(decided.decision).toBe('allow')
})

test("the operator's allow rule stands as it is, so quotient never rewords it", () => {
  const verdict = { decision: 'allow', rule: 'mcp__plugin_quotient_agex' } as const

  expect(ownCallVerdict(verdict)).toBe(verdict)
})

test("an ask from a rule, a settings hook, a setting or another plugin's hook stands", () => {
  for (const verdict of [
    { decision: 'ask', rule: 'mcp__plugin_quotient_agex__list_my_frictions' },
    { decision: 'ask', hook: 'PreToolUse' },
    { decision: 'ask', setting: 'permissions.blockReadsOutsideWorkingDirectories' },
    { decision: 'ask', plugin: 'cc-plugin-privacy' },
  ] as const) {
    expect(ownCallVerdict(verdict)).toBe(verdict)
  }
})

test("an ask the organization set as the tool's limit stands", () => {
  const verdict = { decision: 'ask', ceiling: 'ask' } as const

  expect(ownCallVerdict(verdict)).toBe(verdict)
})

test('a deny stands', () => {
  const verdict = { decision: 'deny', reason: 'denied by your settings' } as const

  expect(ownCallVerdict(verdict)).toBe(verdict)
})

test("a check the model's call raises still goes to the session's own rules", async ($, on) => {
  mock.env(on, {})
  on('tool.check', () => ({ decision: 'ask', reason: 'not granted yet' }))

  const decided = await $.tool.check({ tool: 'mcp__plugin_quotient_agex__list_my_frictions', input: {} })

  expect(decided.decision).toBe('ask')
})
