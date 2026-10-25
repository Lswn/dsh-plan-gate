import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { classifyReply } from '../lib/rules.js'

/**
 * "同意，但还要加个日志" is not a plain approval and not a fresh instruction.
 * It means: the direction is right, fold this in, and ask me again.
 *
 * Word order must not matter either: "先这样，我同意" and "日志要加，我同意"
 * are ordinary replies and have to be read the way a human reads them.
 */

function host() {
  const listeners = new Map()
  const tools = []

  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    inject(_names, callback) {
      callback({ systemPrompt: { section() {} } })
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
  }

  const emit = async (event, ...args) => {
    let result
    for (const handler of listeners.get(event) ?? []) result = await handler(...args)
    return result
  }

  const runPre = (exec) => emit('tools/pre-execute', exec, () => ({ kind: 'allow' }))
  const user = (text) =>
    emit('session/event', { id: 's1' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    })

  const propose = (args, agent) =>
    tools.find((entry) => entry.name === 'propose_plan').execute(args, { agent, callId: 'c1' })

  return { ctx, tools, runPre, user, propose }
}

const agent = { session: { id: 's1' } }
const write = (path) => ({ name: 'write', arguments: { file_path: path }, agent })
const PLAN = { plan: '# 计划', tools: ['write'], files: ['a.txt'] }

async function drafted(h, args = PLAN) {
  await h.propose(args, agent)
}

// ---------------------------------------------------------------- classification

test('a reply is an approval, an amendment, or a new instruction', () => {
  assert.deepEqual(classifyReply('同意'), { kind: 'approve' })
  assert.deepEqual(classifyReply('好的'), { kind: 'approve' })
  assert.deepEqual(classifyReply('行'), { kind: 'approve' })

  assert.deepEqual(classifyReply('同意，但还要加个日志'), { kind: 'amend', note: '但还要加个日志' })
  assert.deepEqual(classifyReply('好的，顺便把 README 也更新'), {
    kind: 'amend',
    note: '顺便把 README 也更新',
  })
  assert.deepEqual(classifyReply('我同意，但再加个日志'), { kind: 'amend', note: '但再加个日志' })

  assert.deepEqual(classifyReply('不同意'), { kind: 'other' })
  assert.deepEqual(classifyReply('我不同意，再想想'), { kind: 'other' })
  assert.deepEqual(classifyReply('行距调大一点'), { kind: 'other' })
  assert.deepEqual(classifyReply('再帮我加个功能'), { kind: 'other' })
})

test('approval survives inverted word order', () => {
  assert.deepEqual(classifyReply('先这样，我同意'), { kind: 'approve' })
  assert.deepEqual(classifyReply('我觉得可以'), { kind: 'approve' })
  assert.deepEqual(classifyReply('我同意这个方案，执行吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('就这样吧'), { kind: 'approve' })
})

test('colloquial approvals are approvals', () => {
  assert.deepEqual(classifyReply('你执行吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('开始吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('可以开始了'), { kind: 'approve' })
  assert.deepEqual(classifyReply('跑吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('动吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('上吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('搞吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('开工吧'), { kind: 'approve' })
  assert.deepEqual(classifyReply('整吧'), { kind: 'approve' })
})

test('acknowledgements and dialect are approvals', () => {
  assert.deepEqual(classifyReply('收到'), { kind: 'approve' })
  assert.deepEqual(classifyReply('好嘞'), { kind: 'approve' })
  assert.deepEqual(classifyReply('得嘞'), { kind: 'approve' })
  assert.deepEqual(classifyReply('要得'), { kind: 'approve' })
  assert.deepEqual(classifyReply('就这么办'), { kind: 'approve' })
  assert.deepEqual(classifyReply('听你的'), { kind: 'approve' })
  assert.deepEqual(classifyReply('开整！'), { kind: 'approve' })
  assert.deepEqual(classifyReply('我赞同这个方案'), { kind: 'approve' })
})

test('lookalike endings are not approvals', () => {
  assert.notEqual(classifyReply('我来安排').kind, 'approve')
  assert.notEqual(classifyReply('办妥了').kind, 'approve')
  assert.notEqual(classifyReply('集中').kind, 'approve')
  assert.notEqual(classifyReply('完成了').kind, 'approve')
  assert.notEqual(classifyReply('调整').kind, 'approve')
  assert.notEqual(classifyReply('往前冲').kind, 'approve')
})

test('an ambiguous verb needs a particle', () => {
  assert.notEqual(classifyReply('动').kind, 'approve')
  assert.notEqual(classifyReply('动一下').kind, 'approve')
  assert.notEqual(classifyReply('上个文件').kind, 'approve')
  assert.notEqual(classifyReply('来龙去脉').kind, 'approve')
  assert.notEqual(classifyReply('搞不清楚').kind, 'approve')
})

test('operator words extend the vocabulary', () => {
  assert.deepEqual(classifyReply('靠谱吧', { extraWords: ['靠谱'] }), { kind: 'approve' })
  assert.notEqual(classifyReply('靠谱吧').kind, 'approve')
})

test('an inverted approval can still carry a requirement', () => {
  assert.deepEqual(classifyReply('日志要加，我同意'), { kind: 'amend', note: '日志要加' })
  const prefixed = classifyReply('这个方案我同意，但日志要加')
  assert.equal(prefixed.kind, 'amend')
  assert.match(prefixed.note, /日志要加/)
})

test('a question is never an approval', () => {
  assert.deepEqual(classifyReply('可以吗？'), { kind: 'other' })
  assert.deepEqual(classifyReply('同意吗'), { kind: 'other' })
  assert.deepEqual(classifyReply('是否同意这个方案？'), { kind: 'other' })
  assert.deepEqual(classifyReply('收到了吗？'), { kind: 'other' })
})

test('a negated approval is never an approval', () => {
  assert.deepEqual(classifyReply('不同意'), { kind: 'other' })
  assert.deepEqual(classifyReply('没有同意'), { kind: 'other' })
  assert.deepEqual(classifyReply('我不同意，再想想'), { kind: 'other' })
  assert.deepEqual(classifyReply('先别动'), { kind: 'other' })
})

test('a single-character approval word never leads an amendment', () => {
  assert.deepEqual(classifyReply('行距调大一点'), { kind: 'other' })
  assert.deepEqual(classifyReply('好像有点问题'), { kind: 'other' })
})

// ---------------------------------------------------------------- amendment flow

test('an amendment does not execute and carries the requirement', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)

  await h.user('同意，但还要加个日志')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /REVISION_REQUIRED/)
  assert.match(decision.reason, /加个日志/)
})

test('after an amendment, a revised plan goes back to waiting for approval', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)
  await h.user('同意，但还要加个日志')

  await drafted(h, { plan: '# 计划（含日志）', tools: ['write'], files: ['a.txt'] })
  const pending = await h.runPre(write('a.txt'))
  assert.equal(pending.kind, 'deny')
  assert.match(pending.reason, /AWAITING_APPROVAL/)

  await h.user('同意')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('an amendment during execution revokes the approval immediately', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)
  await h.user('同意')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')

  await h.user('同意，还要再改一下 b.txt')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /REVISION_REQUIRED/)
  assert.match(decision.reason, /b\.txt/)
})

test('an amendment while a confirmation is pending replaces it', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)
  await h.user('同意')

  const blocked = await h.runPre({ name: 'edit', arguments: { file_path: 'a.txt' }, agent })
  assert.match(blocked.reason, /TOOL_NOT_APPROVED/)

  await h.user('同意，但换个方式吧')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /REVISION_REQUIRED/)
})

test('a plain approval still executes without an amendment', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)
  await h.user('同意')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('an inverted approval executes', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)
  await h.user('先这样，我同意')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('a colloquial approval executes', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)
  await h.user('收到')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('a configured approval word executes', async () => {
  const h = host()
  apply(h.ctx, { approvalWords: ['靠谱'] })
  await drafted(h)
  await h.user('靠谱吧')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('a sentence that merely starts with 行 is a new instruction', async () => {
  const h = host()
  apply(h.ctx, {})
  await drafted(h)
  await h.user('同意')
  await h.user('行距调大一点')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /EXECUTION_OFF/)
})
