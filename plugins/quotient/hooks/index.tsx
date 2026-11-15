// The quotient plugin's hooks module. hooks.json takes one module, so this
// one adds each feature's hooks: the /quotient:list-fixes pane, the fix
// flow's card and outcome rows, /quotient:setup's start message, quiet run
// and summary, the daily runs, the usage sent after each turn, the status
// line's count of frictions with new teammate fixes, the toasts for
// teammates' thank-yous, the permission check that lets the mods' own
// calls reach Quotient, and the sandbox that holds quotient's unattended
// agents to their tools and reads. A session
// may start one unmatched hook per event here, so it registers every
// feature's tools.
import type { Register } from 'claude-code'

import { registerDaily } from './daily'
import { FIX_TOOLS_SPECS, registerFix } from './fix'
import { registerFixStatus } from './fix-status'
import { registerGuard } from './guard'
import { registerListFixes } from './list-fixes'
import { registerReview, REVIEW_TOOLS_SPECS } from './review'
import { registerSetup, SETUP_TOOLS_SPECS } from './setup'
import { registerTeammateText } from './teammate-text'
import { registerThankYous } from './thank-yous'
import { registerUsage } from './usage'

/**
 * Adds every quotient feature's hooks.
 *
 * @param on - Adds the module's hooks
 * @param options - The plugin's options
 */
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    for (const spec of [...SETUP_TOOLS_SPECS, ...REVIEW_TOOLS_SPECS, ...FIX_TOOLS_SPECS]) await $.tool.register(spec)
    return next(e)
  }).catch(($, e, next) => next(e))

  registerGuard(on)
  registerTeammateText(on)

  // A hook added earlier runs outside one added later. The fix-status part's
  // command.run hook has to wrap the list-fixes pane's, which answers the
  // command without calling next.
  registerFixStatus(on)
  registerThankYous(on)
  registerListFixes(on, options)
  registerFix(on, options)
  registerSetup(on, options)
  registerReview(on, options)
  registerDaily(on, options)
  registerUsage(on)
}
