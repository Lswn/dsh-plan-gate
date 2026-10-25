import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

/**
 * Minimal stand-in for the cordis Context surface this plugin uses.
 * If a test needs more host than this, the plugin grew a dependency it should
 * not have.
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
    get(name) {
      if (name === 'agents') return options.agents
      return undefined
    },
    tools: {
      register(definition) {
        if (options.registerThrows === true) throw new Error('register failed')
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

  const session = options.sessionId ?? 's1'
  const user = (text) =>
    emit('session/event', { id: session }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    })

  const planTool = () => tools.find((entry) => entry.name === 'propose_plan')
  const propose = (args, agent) => planTool().execute(args, { agent, callId: 'c1' })

  return { ctx, tools, sections, warnings, runPre, user, propose, planTool }
}

const agent = { session: { id: 's1' } }
const write = (path, who = agent) => ({ name: 'write', arguments: { file_path: path }, agent: who })
const pwsh = (command, who = agent) => ({ name: 'pwsh', arguments: { command }, agent: who })

async function approved(h, args = {}) {
  await h.propose({ plan: '# 计划\n步骤', tools: ['write'], files: ['a.txt'], ...args }, agent)
  await h.user('同意')
}

test('execution is off before any plan', async () => {
  const h = host()
  apply(h.ctx, {})
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /EXECUTION_OFF/)
})

test('reading is never gated', async () => {
  const h = host()
  apply(h.ctx, {})
  const decision = await h.runPre({ name: 'read', arguments: { file_path: 'a.txt' }, agent })
  assert.equal(decision.kind, 'allow')
})

test('registering a plan does not approve it', async () => {
  const h = host()
  apply(h.ctx, {})
  await h.propose({ plan: '# 计划', tools: ['write'], files: ['a.txt'] }, agent)
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /AWAITING_APPROVAL/)
})

test('a chat approval opens exactly the approved scope', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('an unlisted tool is blocked, then confirmed, then allowed', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)

  const blocked = await h.runPre({ name: 'edit', arguments: { file_path: 'a.txt' }, agent })
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /TOOL_NOT_APPROVED/)

  await h.user('同意')
  assert.equal((await h.runPre({ name: 'edit', arguments: { file_path: 'a.txt' }, agent })).kind, 'allow')
})

test('a file outside the plan is blocked, then confirmed, then allowed', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)

  const blocked = await h.runPre(write('b.txt'))
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /FILE_NOT_APPROVED/)

  await h.user('同意')
  assert.equal((await h.runPre(write('b.txt'))).kind, 'allow')
})

test('a command outside the plan is blocked, then confirmed, then allowed', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h, { tools: ['pwsh'], commands: ['pnpm test'] })

  const blocked = await h.runPre(pwsh('pnpm build'))
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /COMMAND_NOT_APPROVED/)

  await h.user('同意')
  assert.equal((await h.runPre(pwsh('pnpm build'))).kind, 'allow')
})

test('network needs its own approval', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h, { tools: ['web_fetch'], network: false })

  const blocked = await h.runPre({ name: 'web_fetch', arguments: { url: 'https://x' }, agent })
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /NETWORK_NOT_APPROVED/)

  await h.user('同意')
  assert.equal((await h.runPre({ name: 'web_fetch', arguments: { url: 'https://x' }, agent })).kind, 'allow')
})

test('delegation needs its own approval', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h, { tools: ['subagent'], subagents: false })

  const blocked = await h.runPre({ name: 'subagent', arguments: {}, agent })
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /SUBAGENTS_NOT_APPROVED/)

  await h.user('同意')
  assert.equal((await h.runPre({ name: 'subagent', arguments: {}, agent })).kind, 'allow')
})

test('while a confirmation is pending, even approved actions stay blocked', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)

  const blocked = await h.runPre({ name: 'edit', arguments: { file_path: 'a.txt' }, agent })
  assert.match(blocked.reason, /TOOL_NOT_APPROVED/)

  const second = await h.runPre(write('a.txt'))
  assert.equal(second.kind, 'deny')
  assert.match(second.reason, /AWAITING_CONFIRMATION/)
})

test('a new instruction turns execution off again', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')

  await h.user('再帮我加个功能')
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /EXECUTION_OFF/)
})

test('a continuation keeps the approval', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  await h.user('继续')
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})

test('a delegated child runs under its owner approval', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  const child = { session: { id: 'child' }, parent: agent }
  assert.equal((await h.runPre(write('a.txt', child))).kind, 'allow')
})

test('sessions do not share approvals', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  const other = { session: { id: 's2' } }
  const decision = await h.runPre(write('a.txt', other))
  assert.equal(decision.kind, 'deny')
})

test('propose_plan requires tools and a heading', async () => {
  const h = host()
  apply(h.ctx, {})
  await assert.rejects(() => h.propose({ plan: '# 计划' }, agent), /requires `tools`/)
  await assert.rejects(() => h.propose({ plan: '改一下', tools: [] }, agent), /# 标题/)
})

test('a new proposal revokes the standing approval', async () => {
  const h = host()
  apply(h.ctx, {})
  await approved(h)
  await h.propose({ plan: '# 另一件事', tools: ['write'], files: ['b.txt'] }, agent)
  const decision = await h.runPre(write('a.txt'))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /AWAITING_APPROVAL/)
})

test('the plugin adds a policy section and registers one tool', () => {
  const h = host()
  apply(h.ctx, {})
  assert.equal(h.sections.length, 1)
  assert.match(h.sections[0].text(), /Execution gate/)
  assert.deepEqual(h.tools.map((entry) => entry.name), ['propose_plan'])
})

test('a broken registration opens the gate instead of locking the session', async () => {
  const h = host({ registerThrows: true })
  apply(h.ctx, {})
  assert.ok(h.warnings.some((line) => line.includes('DISABLED')))
  assert.equal((await h.runPre(write('a.txt'))).kind, 'allow')
})
