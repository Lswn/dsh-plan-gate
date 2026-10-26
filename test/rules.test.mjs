import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  commandApproved,
  commandOf,
  describeScope,
  detectLocale,
  fileTargets,
  firstHeading,
  isApproval,
  isContinuation,
  isGated,
  isPlanDocument,
  normalizeConfig,
  normalizeScope,
  pathApproved,
  textOf,
} from '../lib/rules.js'

const CONFIG = normalizeConfig({})

test('read-only tools never need a plan', () => {
  for (const tool of ['read', 'glob', 'grep', 'todo_write', 'ask_user_question', 'propose_plan']) {
    assert.equal(isGated(tool, CONFIG), false, tool)
  }
})

test('actions are gated by default', () => {
  for (const tool of ['write', 'edit', 'pwsh', 'subagent', 'workflow', 'web_fetch', 'web_search']) {
    assert.equal(isGated(tool, CONFIG), true, tool)
  }
})

test('config overrides both directions', () => {
  const config = normalizeConfig({ gateTools: ['read'], allowTools: ['write'] })
  assert.equal(isGated('read', config), true)
  assert.equal(isGated('write', config), false)
})

test('approval is a whole short reply and never a negation', () => {
  assert.equal(isApproval('同意'), true)
  assert.equal(isApproval('同意。'), true)
  assert.equal(isApproval('可以'), true)
  assert.equal(isApproval('go ahead'), true)
  assert.equal(isApproval('不同意'), false)
  assert.equal(isApproval('可以，但是先改一下第 3 步'), false)
})

test('继续 is an approval, not a separate state', () => {
  assert.equal(isContinuation('继续'), true)
  assert.equal(isContinuation('继续做'), true)
  assert.equal(isContinuation('同意'), false)
  assert.equal(isApproval('继续'), true)
  assert.equal(isApproval('继续吧'), true)
})

test('locale follows config, then the script', () => {
  assert.equal(detectLocale('帮我改个名字', 'auto'), 'zh')
  assert.equal(detectLocale('rename it', 'auto'), 'en')
  assert.equal(detectLocale('帮我改个名字', 'en'), 'en')
})

test('textOf flattens content parts', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf(undefined), '')
})

test('a plan needs a heading', () => {
  assert.equal(isPlanDocument('# 标题'), true)
  assert.equal(isPlanDocument('标题'), false)
  assert.equal(firstHeading('# 标题\n正文'), '标题')
})

test('a scope needs an explicit tools array', () => {
  assert.throws(() => normalizeScope({ plan: '# x' }), /requires `tools`/)
  const scope = normalizeScope({ plan: '# x', tools: ['Write', 'edit', 'write'] })
  assert.deepEqual(scope.tools, ['write', 'edit'])
  assert.equal(scope.network, false)
  assert.equal(scope.subagents, false)
})

test('file targets come only from file-writing tools', () => {
  assert.deepEqual(fileTargets('write', { file_path: 'a.txt' }), ['a.txt'])
  assert.equal(fileTargets('pwsh', { command: 'x' }), null)
})

test('commands come only from command tools', () => {
  assert.equal(commandOf('pwsh', { command: 'pnpm test' }), 'pnpm test')
  assert.equal(commandOf('write', { file_path: 'a' }), null)
})

test('path scope matches exactly and by directory, never across path kinds', () => {
  assert.equal(pathApproved('a.txt', ['a.txt']), true)
  assert.equal(pathApproved('b.txt', ['a.txt']), false)
  assert.equal(pathApproved('src/a.js', ['src/']), true)
  assert.equal(pathApproved('src/deep/a.js', ['src/']), true)
  assert.equal(pathApproved('other/a.js', ['src/']), false)
  assert.equal(pathApproved('C:\\proj\\src\\a.js', ['src/a.js']), false)
})

test('path scope resolves . and .. lexically and refuses escapes', () => {
  assert.equal(pathApproved('sub/../a.txt', ['a.txt']), true)
  assert.equal(pathApproved('./a.txt', ['a.txt']), true)
  assert.equal(pathApproved('../a.txt', ['a.txt']), false)
  assert.equal(pathApproved('C:/proj/sub/../a.txt', ['C:/proj/a.txt']), true)
  assert.equal(pathApproved('C:/other/a.txt', ['a.txt']), false)
})

test('commands match exactly unless a * prefix is declared', () => {
  assert.equal(commandApproved('pnpm test', ['pnpm test']), true)
  assert.equal(commandApproved('  pnpm   test ', ['PNPM TEST']), true)
  assert.equal(commandApproved('pnpm test --watch', ['pnpm test']), false)
  assert.equal(commandApproved('pnpm test --watch', ['pnpm test*']), true)
})

test('describeScope lists what was approved', () => {
  const scope = normalizeScope({
    plan: '# x',
    tools: ['write'],
    files: ['a.txt'],
    commands: ['pnpm test'],
    network: true,
  })
  const summary = describeScope(scope)
  assert.match(summary, /tools: write/)
  assert.match(summary, /files: a\.txt/)
  assert.match(summary, /network: yes/)
})

test('unknown config values fall back instead of throwing', () => {
  const config = normalizeConfig({ locale: 'klingon', allowTools: 'write' })
  assert.equal(config.locale, 'auto')
  assert.deepEqual(config.allowTools, ['write'])
})
