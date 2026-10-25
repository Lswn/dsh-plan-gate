import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { classifyReply } from '../lib/rules.js'

/**
 * Second adversarial round, aimed at the widened vocabulary.
 *
 * The dangerous direction is a FALSE APPROVAL: a sentence that merely looks
 * like one must never unlock execution. Missing an approval only costs another
 * round trip; granting one by accident costs the whole guarantee.
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

  const session = (id) => ({
    runPre: (exec) => emit('tools/pre-execute', exec, () => ({ kind: 'allow' })),
    user: (text) =>
      emit('session/event', { id }, {
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
      }),
    propose: (args, agent) =>
      tools.find((entry) => entry.name === 'propose_plan').execute(args, { agent, callId: `c-${id}` }),
  })

  return { ctx, tools, session }
}

const write = (path, agent) => ({ name: 'write', arguments: { file_path: path }, agent })
const PLAN = { plan: '# 计划', tools: ['write'], files: ['a.txt'] }

// ---------------------------------------------------------------- past tense

test('a past-tense "了" is not an approval', () => {
  assert.notEqual(classifyReply('按你说的做了').kind, 'approve')
  assert.notEqual(classifyReply('听你的了').kind, 'approve')
})

// ---------------------------------------------------------------- lookalikes

test('words that merely end in an approval character are not approvals', () => {
  for (const text of ['集中', '办妥了', '完成了', '调整', '我来安排', '往前冲']) {
    assert.notEqual(classifyReply(text).kind, 'approve', text)
  }
})

// ---------------------------------------------------------------- reported speech

test('quoting someone else is not approving', () => {
  assert.notEqual(classifyReply('他说同意').kind, 'approve')
  assert.notEqual(classifyReply('客户说可以').kind, 'approve')
  assert.notEqual(classifyReply('文档里写着「同意」').kind, 'approve')
})

// ---------------------------------------------------------------- negations

test('negation variants never approve', () => {
  for (const text of ['不太同意', '没同意', '不太行', '先别动', '不用了', 'not ok', "don't do it"]) {
    assert.notEqual(classifyReply(text).kind, 'approve', text)
  }
})

// ---------------------------------------------------------------- punctuation

test('trailing punctuation and emoji do not block an approval', () => {
  assert.deepEqual(classifyReply('同意！'), { kind: 'approve' })
  assert.deepEqual(classifyReply('同意。'), { kind: 'approve' })
  assert.deepEqual(classifyReply('同意——'), { kind: 'approve' })
  assert.deepEqual(classifyReply('同意👍'), { kind: 'approve' })
  assert.deepEqual(classifyReply('收到👌'), { kind: 'approve' })
})

// ---------------------------------------------------------------- mixed language

test('mixed language does not turn an approval into a requirement', () => {
  assert.deepEqual(classifyReply('ok，那就这样'), { kind: 'approve' })
  assert.deepEqual(classifyReply('好的，就这么办'), { kind: 'approve' })
})

// ---------------------------------------------------------------- long input

test('an approval buried in a long message is not a plain approval', () => {
  const long = '我看了方案，' + '细节很多，'.repeat(40) + '同意'
  assert.notEqual(classifyReply(long).kind, 'approve')
})

// ---------------------------------------------------------------- repeated and isolated

test('a duplicate approval does not revoke execution', async () => {
  const h = host()
  apply(h.ctx, {})
  const s = h.session('s1')
  const agent = { session: { id: 's1' } }
  await s.propose(PLAN, agent)
  await s.user('同意')
  assert.equal((await s.runPre(write('a.txt', agent))).kind, 'allow')
  await s.user('同意')
  assert.equal((await s.runPre(write('a.txt', agent))).kind, 'allow')
})

test('parallel sessions keep separate approvals', async () => {
  const h = host()
  apply(h.ctx, {})
  const a = h.session('a')
  const b = h.session('b')
  const agentA = { session: { id: 'a' } }
  const agentB = { session: { id: 'b' } }

  await a.propose(PLAN, agentA)
  await a.user('同意')
  await b.propose({ plan: '# 另一个', tools: ['write'], files: ['b.txt'] }, agentB)

  assert.equal((await a.runPre(write('a.txt', agentA))).kind, 'allow')
  assert.equal((await b.runPre(write('b.txt', agentB))).kind, 'deny')
  assert.equal((await b.runPre(write('a.txt', agentB))).kind, 'deny')
})
