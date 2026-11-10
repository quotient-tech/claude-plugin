// Checks and wording that the plugin's drawings share: text the operator
// sees must hold no id or email, and counts read naturally.

export const MAX_TEXT = 200

// Where the README explains why Claude Code may deny the plugin's calls to Quotient.
export const DENIED_HELP = 'https://github.com/quotient-tech/claude-plugin#if-claude-code-denies-quotients-calls'

// A friction id, a UUID (session ids), or an email: never shown to the operator.
export const FORBIDDEN = [
  /\bfr-\d{8}-\d+/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
]

/**
 * Checks one piece of text the operator will see.
 *
 * @param field - The field's name, for the refusal
 * @param value - The value
 * @param hiddenIds - Ids that never show, beyond the usual shapes
 * @param maxLength - The longest the text may be
 * @returns The refusal, or undefined when the text is fine
 */
export function textError(
  field: string,
  value: unknown,
  hiddenIds: readonly string[] = [],
  maxLength: number = MAX_TEXT,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return `${field}: must be text`
  if (value.length > maxLength) return `${field}: must be at most ${maxLength} characters`
  if (FORBIDDEN.some(pattern => pattern.test(value)) || hiddenIds.some(id => value.includes(id))) {
    return `${field}: must not hold an id or email`
  }
  return undefined
}

/**
 * Counts a noun, in the singular for one.
 *
 * @param count - How many
 * @param noun - The noun in the singular
 * @param nouns - The noun in the plural, when adding "s" doesn't make it
 * @returns The count and noun, such as "1 friction" or "5 frictions"
 */
export function plural(count: number, noun: string, nouns: string = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`
}

// A terminal escape sequence: CSI (`ESC [`) with its parameters, OSC
// (`ESC ]`) up to its BEL or ST, or a two-character escape.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// Control characters, and the marks that reorder how text around them reads.
const CONTROLS = /[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g

/**
 * Makes text a teammate's agent wrote safe to draw: no escape sequence, no control
 * character, and each run of whitespace one space.
 *
 * @param value - The text, or null
 * @returns The text on one line, or null when nothing printable is left
 */
export function cleanText(value: string | null): string | null {
  if (value === null) return null
  const text = value.replace(ESCAPES, '').replace(/\s/g, ' ').replace(CONTROLS, '').replace(/ +/g, ' ').trim()
  return text === '' ? null : text
}
