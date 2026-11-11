import { expect, test } from 'claude-code/testing'

import { privateText } from '../hooks/privacy'

const HOME = '/home/op'

test('an absolute path in a home folder is found, on macOS, Linux and Windows', () => {
  expect(privateText({ description: 'Lint fails in /Users/jane/code/app/src/index.ts' }, HOME)).toEqual({
    field: 'description',
    kind: 'an absolute path in a home folder',
  })
  expect(privateText({ impact: 'Builds under /home/jane/app break' }, HOME)).toEqual({
    field: 'impact',
    kind: 'an absolute path in a home folder',
  })
  expect(privateText({ prompt: 'Edit C:\\Users\\jane\\app\\.eslintrc' }, HOME)).toEqual({
    field: 'prompt',
    kind: 'an absolute path in a home folder',
  })
})

test("the session's own home folder is found wherever it is", () => {
  expect(privateText({ prompt: 'Open /srv/op-home/notes.md' }, '/srv/op-home')).toEqual({
    field: 'prompt',
    kind: 'an absolute path in a home folder',
  })
})

test('an email address is found', () => {
  expect(privateText({ title: 'Ask jane.doe@example.com about CI' }, HOME)).toEqual({
    field: 'title',
    kind: 'an email address',
  })
})

test('an email address is found even when text runs on after its domain', () => {
  for (const text of ['Ask jane@example.com-today', 'Ask jane@example.com.1 now', 'Mail jane@example.co.uk']) {
    expect(privateText({ title: text }, HOME)).toEqual({ field: 'title', kind: 'an email address' })
  }
})

test('a secret is found by its well-known shape', () => {
  const secrets = [
    '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
    'ghp_' + '0123456789abcdefghijABCDEFGHIJ012345',
    'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnop',
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'xoxb-' + '1234567890-abcdefghij',
    'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwx',
  ]
  for (const secret of secrets) {
    expect(privateText({ prompt: `Set the token to ${secret} in settings` }, HOME)).toEqual({
      field: 'prompt',
      kind: 'a secret',
    })
  }
})

test("a Claude Code project folder's name is found, since it spells out a path", () => {
  const named = [
    'Read ~/.claude/projects/-Users-jane-Development-app/memory/MEMORY.md',
    'The memory in .claude/projects/-tmp-x holds it',
    'Sessions in -Users-jane-Development-app hit it',
    'Sessions in -home-jane-app hit it',
  ]
  for (const text of named) {
    expect(privateText({ prompt: text }, HOME)).toEqual({ field: 'prompt', kind: "a Claude Code project folder's name" })
  }
})

test("the session's own home folder is found in a project folder's dashed form", () => {
  expect(privateText({ prompt: 'Sessions in -srv-op-home-code-app hit it' }, '/srv/op-home')).toEqual({
    field: 'prompt',
    kind: "a Claude Code project folder's name",
  })
})

test('project folders named in general terms are clean', () => {
  const generic = [
    "Add the rule to this repo's auto-memory",
    'Transcripts live under ~/.claude/projects/, one folder per project',
    'Run git log --root to see the first commit',
    'The pre-home-page banner and a-Users-b widget',
  ]
  for (const text of generic) {
    expect(privateText({ prompt: text }, '/root')).toBe(null)
  }
})

test('each tag is checked, and the result names the tags field', () => {
  expect(privateText({ title: 'CI', tags: ['ci', 'jane@example.com'] }, HOME)).toEqual({
    field: 'tags',
    kind: 'an email address',
  })
})

test('each field of each answer sent together is checked, and the result names the answer and its field', () => {
  const answers = [
    { frictionId: 'f1', description: 'Run lint in the pre-commit hook.' },
    { frictionId: 'f2', description: 'Pin Node.', prompt: 'Edit /Users/jane/app/.nvmrc' },
  ]
  expect(privateText({ answers, source: 'local' }, HOME)).toEqual({
    field: 'answers[1].prompt',
    kind: 'an absolute path in a home folder',
  })
  expect(privateText({ answers: [answers[0]], source: 'local' }, HOME)).toBe(null)
  expect(privateText({ answers: [{ frictionId: 'jane@example.com' }] }, HOME)).toBe(null)
})

test('the result never holds the private text it found', () => {
  const found = privateText({ description: `Token ${'ghp_' + '0123456789abcdefghijABCDEFGHIJ012345'} leaked` }, HOME)
  expect(JSON.stringify(found)).not.toContain('ghp_')
})

test('ids and the repository are never checked', () => {
  const input = {
    frictionId: 'jane@example.com',
    sessionId: '/Users/jane/x',
    runId: 'ghp_' + '0123456789abcdefghijABCDEFGHIJ012345',
    repository: 'jane-doe/app',
    title: 'Lint fails in CI after passing on commit',
  }
  expect(privateText(input, HOME)).toBe(null)
})

test('text that names files, settings and tools without private values is clean', () => {
  const clean = [
    'Edit .husky/pre-commit and tsconfig.json in the repo',
    'Add the rule to ~/.claude/settings.json under permissions',
    'Install it to /usr/local/bin and run it',
    'The email field and the token setting were missing',
    'Rename task-sk-1 and risk-assessment-for-the-whole-team-today',
    'Clone git@github.com:owner/app.git and run npm test',
    'Import @types/node in the package',
    'Pin typescript@5.6.2, actions/checkout@v4.1.1 and claude-code@2.1.317',
    'The friction 3f2a9c1e-0b4d-4e8a-9c7f-1a2b3c4d5e6f was seen twice',
  ]
  for (const text of clean) {
    expect(privateText({ description: text, tags: ['ci', 'lint'] }, HOME)).toBe(null)
  }
})

test("the home folder is found only as a path's start, not inside a repo's path", () => {
  expect(privateText({ prompt: 'Edit src/root/config.ts' }, '/root')).toBe(null)
  for (const text of ['Open /root/.bashrc', 'Open file:///root/.bashrc', 'Open //root/.bashrc']) {
    expect(privateText({ prompt: text }, '/root')).toEqual({
      field: 'prompt',
      kind: 'an absolute path in a home folder',
    })
  }
})

test('a home folder of / is never treated as private', () => {
  expect(privateText({ prompt: 'Run it from /etc/app' }, '/')).toBe(null)
})
