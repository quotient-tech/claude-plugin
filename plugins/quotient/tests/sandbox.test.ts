import { expect, test } from 'claude-code/testing'

import {
  fullPath,
  globRoot,
  isGlobAllowed,
  isQuotientSkill,
  isQuotientTool,
  isReadAllowed,
  isSecretPath,
  isSettingsFile,
  isSkippedProject,
  projectFolder,
  safeRepos,
} from '../hooks/sandbox'
import type { Reach } from '../hooks/sandbox'

const DIRS = { config: '/home/op/.claude', home: '/home/op', runs: '/home/op/.local/share/quotient' }
const REPO = '/home/op/code/app'
const CONFIG = DIRS.config
// A dotfiles repo that holds the config folder itself.
const CONFIG_REPO = '/home/op/.claude'
const REACH: Reach = { dirs: DIRS, repos: [REPO] }
const CWD = '/home/op/.local/share/quotient'
const RUNS_PROJECT = projectFolder(DIRS.runs)

/**
 * Reads a path as a sandboxed agent's Read would.
 *
 * @param path - The path the call names
 * @param reach - Where the agent may read
 * @returns Whether the read is allowed
 */
function canRead(path: string, reach: Reach = REACH): boolean {
  const full = fullPath(path, DIRS, CWD)
  return full !== null && isReadAllowed(full, reach, false)
}

/**
 * Searches a folder as a sandboxed agent's Grep would.
 *
 * @param path - The folder the call names
 * @returns Whether the search is allowed
 */
function canGrepFolder(path: string): boolean {
  const full = fullPath(path, DIRS, CWD)
  return full !== null && isReadAllowed(full, REACH, true)
}

/**
 * Lists names as a sandboxed agent's Glob would.
 *
 * @param input - The Glob call's input
 * @returns Whether the Glob is allowed
 */
function canGlob(input: Record<string, unknown>): boolean {
  const root = globRoot(input, DIRS, CWD)
  return root !== null && isGlobAllowed(root, REACH, input.pattern)
}

test('a path is made absolute from ~ or the working directory, and any .. is refused', () => {
  expect(fullPath('~/.claude/settings.json', DIRS, CWD)).toBe('/home/op/.claude/settings.json')
  expect(fullPath('notes/./a.md', DIRS, CWD)).toBe(`${CWD}/notes/a.md`)
  expect(fullPath('/home/op/.claude//skills/', DIRS, CWD)).toBe('/home/op/.claude/skills')
  expect(fullPath('~/.claude/projects/../.credentials.json', DIRS, CWD)).toBe(null)
  expect(fullPath('', DIRS, CWD)).toBe(null)
  expect(fullPath(undefined, DIRS, CWD)).toBe(null)
})

test("the config folder's safe parts can be read, and nothing else there", () => {
  for (const path of [
    '~/.claude/settings.json',
    '~/.claude/CLAUDE.md',
    '~/.claude/skills/lint/SKILL.md',
    '~/.claude/plugins/cache/x/plugin.json',
    '~/.claude/projects/-home-op-code-app/1.jsonl',
    '~/.claude/projects/-home-op-code-app/memory/MEMORY.md',
  ]) {
    expect(canRead(path)).toBe(true)
  }
  for (const path of ['~/.claude/.credentials.json', '~/.claude', '~/.claude/settings.local.json', '~/.claude/todos/a.json']) {
    expect(canRead(path)).toBe(false)
  }
})

test('the temporary folders skipped are the four the skills name', () => {
  for (const prefix of ['-private-tmp-', '-tmp-', '-var-folders-', '-private-var-folders-']) {
    expect(isSkippedProject(`${prefix}x`, DIRS)).toBe(true)
  }
  expect(isSkippedProject('-tmpfiles-x', DIRS)).toBe(false)
})

test("quotient's own daily-run transcripts and temporary folders' transcripts are never read", () => {
  for (const project of [RUNS_PROJECT, '-private-tmp-claude-501-scratchpad-probe', '-tmp-x', '-var-folders-ab-T-y']) {
    expect(isSkippedProject(project, DIRS)).toBe(true)
    expect(canRead(`~/.claude/projects/${project}/1.jsonl`)).toBe(false)
    expect(canGrepFolder(`~/.claude/projects/${project}`)).toBe(false)
  }
  expect(isSkippedProject('-home-op-code-app', DIRS)).toBe(false)
})

test('a Grep of every project folder at once is refused, since it would read the skipped ones too', () => {
  expect(canGrepFolder('~/.claude/projects')).toBe(false)
  expect(canGrepFolder('~/.claude/projects/-home-op-code-app')).toBe(true)
  expect(canGrepFolder('~/.claude/skills')).toBe(true)
  expect(canGrepFolder('~/.claude')).toBe(false)
})

test("a repo's files can be read one by one, but not its secrets or a whole folder", () => {
  expect(canRead(`${REPO}/package.json`)).toBe(true)
  expect(canRead(`${REPO}/.github/workflows/ci.yml`)).toBe(true)
  expect(canRead(REPO)).toBe(false)
  expect(canGrepFolder(REPO)).toBe(false)
  expect(canGrepFolder(`${REPO}/src`)).toBe(false)
  for (const path of [
    '.env',
    '.env.local',
    '.envrc',
    '.dev.vars',
    'infra/prod.tfvars',
    'infra/prod.tfvars.json',
    'infra/terraform.tfstate',
    'infra/terraform.tfstate.backup',
    '.docker/config.json',
    'certs/server.pem',
    '.npmrc',
    '.git/config',
    'deploy/.ssh/id_ed25519',
    'credentials.json',
  ]) {
    expect(canRead(`${REPO}/${path}`)).toBe(false)
  }
})

test("a repo's Claude Code and agent steering stays readable, but not a secret put there", () => {
  for (const path of ['.claude/settings.local.json', 'settings.local.json', '.claude/agents/review.md', '.agents/AGENTS.md']) {
    expect(canRead(`${REPO}/${path}`)).toBe(true)
  }
  for (const path of ['.claude/.env', '.agents/deploy.pem', '.claude/credentials.json']) {
    expect(canRead(`${REPO}/${path}`)).toBe(false)
  }
  expect(isSecretPath(['.claude', 'settings.local.json'])).toBe(false)
})

test('secret and skipped names are matched ignoring case, as macOS does', () => {
  for (const path of ['.ENV', 'Deploy/.SSH/id_rsa', 'certs/Server.PEM', '.Git/config']) {
    expect(canRead(`${REPO}/${path}`)).toBe(false)
  }
  expect(isSkippedProject('-Private-Tmp-probe', DIRS)).toBe(true)
  expect(isSkippedProject(RUNS_PROJECT.toUpperCase(), DIRS)).toBe(true)
})

test('inside the config folder only its own rule decides, even when a repo holds it', () => {
  const dotfiles: Reach = { dirs: DIRS, repos: [CONFIG_REPO] }

  expect(canRead('~/.claude/.credentials.json', dotfiles)).toBe(false)
  expect(canRead('~/.claude/history.jsonl', dotfiles)).toBe(false)
  expect(canRead('~/.claude/settings.json', dotfiles)).toBe(true)
  expect(isSecretPath(['.credentials.json'])).toBe(true)
})

test("only the settings file at the config folder's top level is the user settings", () => {
  expect(isSettingsFile(`${CONFIG}/settings.json`, DIRS)).toBe(true)
  expect(isSettingsFile(`${CONFIG}/settings.local.json`, DIRS)).toBe(false)
  expect(isSettingsFile(`${CONFIG}/plugins/x/settings.json`, DIRS)).toBe(false)
  expect(isSettingsFile(`${REPO}/.claude/settings.json`, DIRS)).toBe(false)
})

test('a repo that holds the home or config folder, or the root folder, is never one to read in', () => {
  expect(safeRepos([REPO, '/', '/home', '/home/op', CONFIG_REPO, `${CONFIG}/plugins/marketplaces/x`], DIRS)).toEqual([
    REPO,
    `${CONFIG}/plugins/marketplaces/x`,
  ])
})

test('nothing outside the config folder and the repos can be read', () => {
  for (const path of ['~/.ssh/id_rsa', '~/.aws/credentials', '/etc/passwd', '~/code/other/package.json', `${CWD}/notes.md`]) {
    expect(canRead(path)).toBe(false)
  }
  expect(canRead(`${REPO}/package.json`, { dirs: DIRS, repos: [] })).toBe(false)
})

test('a Glob is held to where it starts listing, including an absolute pattern', () => {
  expect(canGlob({ pattern: '~/.claude/projects/*/*.jsonl' })).toBe(true)
  expect(canGlob({ pattern: '**/*.md', path: '~/.claude/skills' })).toBe(true)
  expect(canGlob({ pattern: '**/*', path: REPO })).toBe(true)
  expect(canGlob({ pattern: '/home/op/.ssh/*' })).toBe(false)
  expect(canGlob({ pattern: '~/*' })).toBe(false)
  expect(canGlob({ pattern: '*', path: '~/.claude' })).toBe(true)
  expect(canGlob({ pattern: '**/*', path: '~/.claude' })).toBe(false)
  expect(canGlob({ pattern: 'todos/*', path: '~/.claude' })).toBe(false)
  expect(canGlob({ pattern: '../*', path: '~/.claude/skills' })).toBe(false)
  expect(canGlob({ pattern: '{..,a}/.credentials.json', path: '~/.claude/skills' })).toBe(false)
  expect(canGlob({ pattern: '~/.claude/skills/{..,x}/.credentials.json' })).toBe(false)
  expect(canGlob({ pattern: '*.md' })).toBe(false)
})

test("only Quotient's own tools by exact name, under its server or the connector, count as Quotient's", () => {
  expect(isQuotientTool('mcp__plugin_quotient_agex__submit_solution', ['submit_solution'])).toBe(true)
  expect(isQuotientTool('mcp__claude_ai_Quotient__submit_solution', ['submit_solution'])).toBe(true)
  expect(isQuotientTool('mcp__slack__submit_solution', ['submit_solution'])).toBe(false)
  expect(isQuotientTool('mcp__plugin_quotient_agex__submit_friction', ['submit_solution'])).toBe(false)
})

test("a skill counts as quotient's only with its namespace, unless the check is a refusal", () => {
  for (const skill of ['quotient:find-solutions', '/Quotient:Find-Solutions', ' quotient:find-solutions ']) {
    expect(isQuotientSkill(skill, ['find-solutions'])).toBe(true)
  }
  expect(isQuotientSkill('find-solutions', ['find-solutions'])).toBe(false)
  expect(isQuotientSkill('find-solutions', ['find-solutions'], true)).toBe(true)
  expect(isQuotientSkill('other:find-solutions', ['find-solutions'], true)).toBe(false)
  expect(isQuotientSkill(undefined, ['find-solutions'], true)).toBe(false)
})
