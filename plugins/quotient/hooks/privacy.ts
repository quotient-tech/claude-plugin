// Teammates read every field quotient's skills send to Quotient but the ids.
// The skills tell the agent what to keep out; these pure rules find what can
// be found reliably, a home folder's path, an email address or a secret's
// well-known shape, so guard.ts can refuse the call and the agent rewrites it.
// Names, internal hosts and customer data have no reliable shape: only the
// skills' rules keep those out.
import { projectFolder } from './sandbox'
import { EMAIL } from './state'

/** What a field was found to hold, as the refusal names it. */
export type PrivateKind =
  | 'an absolute path in a home folder'
  | "a Claude Code project folder's name"
  | 'an email address'
  | 'a secret'

// Fields that hold ids or a deliberate `owner/name`, never prose teammates read.
const UNCHECKED = new Set(['frictionId', 'sessionId', 'runId', 'repository'])
// A home folder's path on macOS, Linux or Windows, with the folder's name.
const HOME_PATH = /(?:^|[^\w.~-])\/(?:Users|home)\/[^\s/\\'"`]+|\b[A-Za-z]:\\Users\\[^\s\\'"`]+/
// A Claude Code project folder is named after its absolute path, so its name
// spells out the username and layout: one named under `.claude/projects/`,
// or a home folder's path in that dashed form, such as `-Users-jane-app`.
const PROJECT_FOLDER = /\.claude\/projects\/[\w-]|(?:^|[^\w-])-(?:Users|home)-[A-Za-z0-9]/
// A git host's SSH user, as in `git@github.com:owner/app.git`, names no one.
const SSH_REMOTE = /^git@/
// An address's domain has a label of letters alone, such as `.com`, wherever
// the match ends; a version pin's, such as `typescript@5.6.2` or
// `checkout@v4.1.1`, never does.
const EMAIL_DOMAIN = /@[^@\s]*\.\p{L}{2,}(?!\p{L})/u
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
]

/**
 * Tells whether a text names the session's own home folder, as a path that
 * starts there, after any slashes as in `file:///root`, not one that merely
 * contains its name, like `src/root/`.
 *
 * @param text - The field's text
 * @param home - The session's home folder
 * @returns Whether the text holds it, followed by a path or nothing
 */
function namesHome(text: string, home: string): boolean {
  const folder = home.replace(/\/+$/, '')
  if (folder === '') return false
  const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\w.~/-])/*${escaped}(?=/|$|[\\s'"\`])`).test(text)
}

/**
 * Tells whether a text names a project folder of the session's own home
 * folder, as Claude Code spells it: `/srv/op-home` as `-srv-op-home`.
 *
 * @param text - The field's text
 * @param home - The session's home folder
 * @returns Whether the text holds that name, alone or starting a longer one
 */
function namesHomeProject(text: string, home: string): boolean {
  const folder = projectFolder(home.replace(/\/+$/, ''))
  if (folder === '') return false
  return new RegExp(`(?:^|[^\\w-])${folder}(?=-|$|[^\\w-])`).test(text)
}

/**
 * Tells whether a text holds an email address, leaving out a git host's SSH
 * user.
 *
 * @param text - The field's text
 * @returns Whether it holds one
 */
function holdsEmail(text: string): boolean {
  for (const match of text.matchAll(new RegExp(EMAIL.source, 'gu'))) {
    if (!SSH_REMOTE.test(match[0]) && EMAIL_DOMAIN.test(match[0])) return true
  }
  return false
}

/**
 * Names what private text a field holds, if any.
 *
 * @param text - The field's text
 * @param home - The session's home folder
 * @returns What it holds, or null
 */
function kindOf(text: string, home: string): PrivateKind | null {
  if (PROJECT_FOLDER.test(text) || namesHomeProject(text, home)) return "a Claude Code project folder's name"
  if (HOME_PATH.test(text) || namesHome(text, home)) return 'an absolute path in a home folder'
  if (SECRETS.some(pattern => pattern.test(text))) return 'a secret'
  if (holdsEmail(text)) return 'an email address'
  return null
}

/**
 * Names the first field of an outgoing Quotient call whose text teammates
 * mustn't see, and what it holds. Checks each string field, each string in
 * an array field, such as `tags`, and each field of an object in an array,
 * such as the `answers` sent together, named like `answers[1].description`;
 * never the ids or `repository`.
 *
 * @param input - The call's input
 * @param home - The session's home folder
 * @returns The field and what it holds, without the text itself, or null when every field is clean
 */
export function privateText(input: Record<string, unknown>, home: string): { field: string; kind: PrivateKind } | null {
  for (const [field, value] of Object.entries(input)) {
    if (UNCHECKED.has(field)) continue
    const items = Array.isArray(value) ? value : [value]
    for (const [index, item] of items.entries()) {
      if (typeof item === 'string') {
        const kind = kindOf(item, home)
        if (kind !== null) return { field, kind }
      } else if (Array.isArray(value) && typeof item === 'object' && item !== null) {
        const found = privateText(item as Record<string, unknown>, home)
        if (found !== null) return { field: `${field}[${index}].${found.field}`, kind: found.kind }
      }
    }
  }
  return null
}
