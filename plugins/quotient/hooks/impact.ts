// The kinds of harm a friction can do, and the short label each one shows as.

import type { FrictionImpact } from '../types'

/**
 * Every impact category, in the order the skills tell agents to pick from:
 * the first one that applies wins.
 */
export const IMPACTS: readonly FrictionImpact[] = ['SAFETY', 'QUALITY', 'BLOCKED', 'OPERATOR_ATTENTION', 'COST', 'TIME']

/** The label shown for each friction impact category. */
export const IMPACT_LABELS: ReadonlyMap<string, string> = new Map<FrictionImpact, string>([
  ['SAFETY', 'Safety & privacy'],
  ['QUALITY', 'Quality'],
  ['BLOCKED', 'Blocked'],
  ['OPERATOR_ATTENTION', 'Operator effort'],
  ['COST', 'Token cost'],
  ['TIME', 'Time lost'],
])

/**
 * Names a friction's impact for display. Frictions sent before impact became
 * a category hold freeform text, which shows as it was sent.
 *
 * @param impact - The impact, a category or freeform text
 * @returns The category's label, or the text unchanged
 */
export function impactLabel(impact: string): string {
  return IMPACT_LABELS.get(impact) ?? impact
}
