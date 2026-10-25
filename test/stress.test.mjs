import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'
import { commandApproved, isApproval, pathApproved } from '../lib/rules.js'

/**
 * Adversarial pressure tests.
 *
 * These do not exercise happy paths — the happy paths live in gate.test.mjs.
 * Each case here is something a hostile, confused, or merely unlucky model
 * could do to the gate, and the assertion is always the safe outcome.
 */

function host(options = {}) {
  const listeners = new Map()
  const tools = []
  const sections = []
  const warnings = []

  const ctx = {
    logger: {
      info() {},
      warn(message) {
        warnings.push(String(message))
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    inject(_names, callback) {
      callback({ systemPrompt: { section: (section) => sections.push(section) } })
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
  const user = (text, sessionId = 's1', sourceKind = 'user') =>
    emit('session/event', { id: sessionId }, {
      type: 'user/message',
      data: { source: { kind: sourceKind }, content: [{ type: 'text', text }] },
    })

  const planTool = () => tools.find((entry) => entry.name === 'propose_plan')
  const propose = (args, agent) => planTool().execute(args, { agent, callId: 'c1' })

  return { ctx, tools, sections, warnings, emit, runPre, user, propose }
}

const agent = { session: { id: 's1' } }
const write = (path, who = agent) => ({ name: 'write', arguments: { file_path: path }, agent: who })
const pwsh = (command, who = agent) => ({ name: 'pwsh', arguments: { command }, agent: who })

async function approved(h, args = {}, who = agent) {
  await h.propose({ plan: '# 计划', tools: ['write'], files: ['a.txt'], ...args }, who)
  await h.user('同意', who.session.id)
}

// ---------------------------------------------------------------- approvals

test('negations and mixed sentences never approve', () => {
  assert.equal(isApproval('不同意'), false)
  assert.equal(isApproval('同意，但是先改第 3 步'), false)
  assert.equal(isApproval('先把 a.txt 改了再同意'), false)
  assert.equal(isApproval('我不同意'), false)
})

test('approval survives punctuation and case', () => {
  assert.equal(isApproval('同意！'), true)
  assert.equal(isApproval('同意。'), true)
  assert.equal(isApproval(' ok '), true)
  assert.equal(isApproval('OK'), true)
  assert.equal(isApproval('好的'), true)
})

test('a long sentence containing 同意 is feedback, not approval', () => {
  const text = '我看了方案，整体没问题，但是第 2 步的路径写错了，应该是 src/auth，先改成这个再同意'
  assert.equal(isApproval(text), false)
})

test('approval with nothing pending changes nothing', async () => {
  const h = host()
  apply(h.ctx, {})
  await h.user('同意')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /EXECUTION_OFF/)
})

test('approval cannot cross sessions', async () => {
  const h = host()
  apply(h.ctx, {})
  await h.propose({ plan: '# 计划', tools: ['write'], files: ['a.txt'] }, agent)
  await h.user('同意', 's2')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
})

test('a non-user source cannot approve', async () => {
  const h = host()
  apply(h.ctx, {})
  await h.propose({ plan: '# 计划', tools: ['write'], files: ['a.txt'] }, agent)
  await h.user('同意', 's1', 'user-question-reply')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
})

// ---------------------------------------------------------------- scope

test('tool names compare case-insensitively', async () => {
  const h = host()
  apply(h.ctx, {})
  await h.propose({ plan: '# 计划', tools: ['Write'], files: ['a.txt'] }, agent)
  await h.user('同意')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('a parent-relative path must not escape the approved file', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  const decision = await h.runPre(write('../a.txt'))
  assert.equal(decision.kind, 'deny', 'writing ../a.txt escaped the approved scope')
})

test('an absolute path outside the approved file must be denied', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  const decision = await h.runPre(write('C:/other/a.txt'))
  assert.equal(decision.kind, 'deny', 'an absolute path matched by suffix escaped the approved scope')
})

test('a directory scope stops at the separator', () => {
  assert.equal(pathApproved('src/a.js', ['src/']), true)
  assert.equal(pathApproved('srcx/a.js', ['src/']), false)
})

test('windows casing does not defeat the file scope', () => {
  assert.equal(pathApproved('a.txt', ['A.txt']), true)
})

test('command injection is not covered by an exact entry', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h, { tools: ['pwsh'], commands: ['pnpm test'] })
  const decision = await h.runPre(pwsh('pnpm test; rm -rf x'))
  assert.equal(decision.kind, 'deny')
})

test('command whitespace is normalised before matching', () => {
  assert.equal(commandApproved('pnpm   test', ['pnpm test']), true)
})

test('an approved tool still needs its own network allowance', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h, { tools: ['web_fetch'], files: ['a.txt'] })
  const decision = await h.runPre({ name: 'web_fetch', arguments: { url: 'https://x' }, agent })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /NETWORK_NOT_APPROVED/)
})

// ---------------------------------------------------------------- state machine

test('a pending confirmation freezes every action', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  await h.runPre({ name: 'edit', arguments: { file_path: 'a.txt' }, agent })
  const second = await h.runPre(write('a.txt'))
  assert.match(second.reason, /AWAITING_CONFIRMATION/)
})

test('refusing a pending request resets the whole turn', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  await h.runPre({ name: 'edit', arguments: { file_path: 'a.txt' }, agent })
  await h.user('不同意')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /EXECUTION_OFF/)
})

test('a redundant approval keeps execution on', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  await h.user('同意')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'allow', 'a duplicate 同意 revoked a standing approval')
})

test('a new instruction during a pending request resets everything', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  await h.runPre({ name: 'edit', arguments: { file_path: 'a.txt' }, agent })
  await h.user('算了，改成别的')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /EXECUTION_OFF/)
})

test('a second proposal revokes the standing approval', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  await h.propose({ plan: '# 新想法', tools: ['write'], files: ['b.txt'] }, agent)
  const decision = await h.runPre(write('a.txt'))
  assert.match(decision.reason, /AWAITING_APPROVAL/)
})

test('concurrent calls do not corrupt the scope', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  const [first, second] = await Promise.all([h.runPre(write('a.txt')), h.runPre(write('a.txt'))])
  assert.equal(first.kind, 'allow')
  assert.equal(second.kind, 'allow')
})

// ---------------------------------------------------------------- hostile input

test('a malformed plan does not register', async () => {
  const h = host()
  apply(h.ctx, {})
  await assert.rejects(() => h.propose({ plan: { a: 1 }, tools: [] }, agent))
  await assert.rejects(() => h.propose({ plan: null, tools: [] }, agent))
  await assert.rejects(() => h.propose({ tools: [] }, agent))
})

test('a 1 MiB plan still registers without crashing', async () => {
  const h = host()
  apply(h.ctx, {})
  const huge = '# 大计划\n' + 'x'.repeat(1024 * 1024)
  const result = await h.propose({ plan: huge, tools: [] }, agent)
  assert.deepEqual(result, { registered: true })
})

test('junk entries in tools are dropped, not trusted', async () => {
  const h = host()
  apply(h.ctx, {})
  await h.propose({ plan: '# 计划', tools: [1, null, ['write'], 'write'], files: ['a.txt'] }, agent)
  await h.user('同意')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('malformed session events do not throw', async () => {
  const h = host()
  apply(h.ctx, {})
  await h.emit('session/event', { id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' } } })
  await h.emit('session/event', { id: 's1' }, { type: 'user/message' })
  await h.emit('session/event', undefined, undefined)
  await h.emit('session/event', { id: 's1' }, { type: 'turn/start' })
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
})

test('a __proto__ payload cannot pollute the rule set', async () => {
  const h = host()
  apply(h.ctx, {})
  const args = JSON.parse('{"plan":"# x","tools":[],"__proto__":{"polluted":true}}')
  await h.propose(args, agent)
  assert.equal({}.polluted, undefined)
  assert.equal((await h.runPre(write('a.txt'))).kind, 'deny')
})

// ---------------------------------------------------------------- fail safety

test('an internal gate error denies instead of allowing', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  const hostile = {
    name: 'write',
    agent,
    get arguments() {
      throw new Error('boom')
    },
  }
  const decision = await h.runPre(hostile)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /PLAN_GATE_ERROR/)
})

// ---------------------------------------------------------------- pressure

test('1000 sequential decisions stay well under a second', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  const started = Date.now()
  for (let index = 0; index < 1000; index += 1) {
    const decision = await h.runPre(write('a.txt'))
    if (decision.kind !== 'allow') throw new Error('unexpected deny under load')
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `1000 decisions took ${elapsed}ms`)
})

test('a 1000-entry file scope still matches in bounded time', async () => {
  const files = Array.from({ length: 1000 }, (_, index) => `src/file-${index}.js`)
  files.push('a.txt')
  const h = host()
  apply(h.ctx, {})
  await approved(h, { files })
  const started = Date.now()
  for (let index = 0; index < 200; index += 1) {
    const decision = await h.runPre(write('a.txt'))
    if (decision.kind !== 'allow') throw new Error('unexpected deny under load')
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `200 decisions over 1000 entries took ${elapsed}ms`)
})
