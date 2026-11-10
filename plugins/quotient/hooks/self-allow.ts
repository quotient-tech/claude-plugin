// Lets quotient's own mods reach Quotient. Claude Code puts a mod's
// `$.mcp.call` through the session's permission check, so without an allow
// rule auto mode, or a session with nobody to ask, denies it. For a call
// quotient's own hooks made to a tool its mods call, this hears the session's
// verdict first and allows only in place of Claude Code's default ask. An
// allow, ask or deny from the operator's rules, a settings hook or a setting
// stands as it is. The model's calls, and every other tool, go on unchanged.
// guard.ts registers the module's one tool.check hook, which uses these.
import type { EngineInterface } from 'claude-code'

type ToolCheckResult = Awaited<ReturnType<EngineInterface['tool']['check']>>

const PLUGIN = 'quotient'
const MOD_TOOLS = [
  'list_my_frictions',
  'mark_solution_implemented',
  'send_thank_you',
  'claim_daily_run',
  'complete_daily_run',
  'record_usage',
  'check_thank_yous',
]

/**
 * Tells whether a call is one quotient's mods make to Quotient, under any
 * server's name: the plugin's own, the claude.ai connector, or a server the
 * operator set up by hand that Claude Code runs in its place.
 *
 * @param plugin - The plugin whose hook made the call, `engine` for the model
 * @param tool - The tool's full name, as `mcp__<server>__<tool>`
 * @returns Whether quotient made the call to a tool its mods call
 */
export function isOwnQuotientCall(plugin: string, tool: string): boolean {
  return plugin === PLUGIN && tool.startsWith('mcp__') && MOD_TOOLS.some(name => tool.endsWith(`__${name}`))
}

/**
 * Decides quotient's own call from the session's verdict on it. Only Claude
 * Code's default ask, which no rule, settings hook, setting or other plugin's
 * hook made, and no limit the organization set on the tool, becomes an allow.
 *
 * @param verdict - The session's verdict on the call
 * @param reason - Why quotient allows it
 * @returns An allow in place of the default ask, else the verdict unchanged
 */
export function ownCallVerdict(verdict: ToolCheckResult, reason = "quotient's own call to Quotient"): ToolCheckResult {
  const isDefaultAsk =
    verdict.decision === 'ask' && !verdict.rule && !verdict.hook && !verdict.setting && !verdict.plugin && !verdict.ceiling
  return isDefaultAsk ? { decision: 'allow', reason } : verdict
}
