/**
 * dsh-plan-gate — execution stays off until the user approves a plan.
 *
 * Two touch points, one tool:
 *   session/event      the user's replies drive the state machine
 *   tools/pre-execute  every action tool is checked against the approved scope
 *   propose_plan       registers a plan; it never approves anything
 *
 * Approval is a chat reply, not a dialog the model can raise: the model can ask,
 * but only the human can unlock execution.
 */

import {
  classifyReply,
  commandApproved,
  commandOf,
  describeScope,
  detectLocale,
  fileTargets,
  firstHeading,
  isContinuation,
  isDelegationTool,
  isGated,
  isNetworkTool,
  isPlanDocument,
  normalizeConfig,
  normalizeScope,
  pathApproved,
  textOf,
} from './rules.js'
import { messages } from './messages.js'
import { GateState } from './session-state.js'

export const name = 'plan-gate'
export const inject = ['tools']

const PROMPT = [
  '## Execution gate',
  'Execution is OFF by default in this session. You may read files and reply, but every action tool is refused until the user approves a plan.',
  'To act, call `propose_plan` with: the plan (markdown, `#` heading), the exact list of action tools you will use, the files and commands the plan touches, and whether it needs network or subagents.',
  'Writing the plan in your reply does NOT register it. Call `propose_plan` first and wait for `registered: true`; only then may you ask the user to confirm.',
  'Never ask "please confirm" before a plan is registered — the user answering yes would have nothing to approve, and the next action would be refused anyway.',
  'List files as absolute paths: the gate compares absolute with absolute and relative with relative, and will not guess that two spellings mean the same file.',
  'Then present the plan to the user in your reply and stop.',
  'Only a chat reply from the user can approve it. The approval binds that exact list: any tool, file, or command outside it is blocked and needs the user to confirm it first.',
  'If the user approves with an extra requirement ("同意，但还要加个日志"), that is NOT execution: fold the requirement into the plan and submit it again for approval.',
  'Never retry a blocked call. Tell the user what you need and why, and wait.',
].join('\n')

function loggerOf(ctx) {
  const logger = ctx?.logger
  return {
    info: (line) => logger?.info?.(line),
    warn: (line) => logger?.warn?.(line),
  }
}

/** A delegated child cannot approve anything; it runs under its owner's scope. */
function owningAgent(agent) {
  let current = agent
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const parent = current.parent ?? current.owner ?? current.parentAgent ?? current.supervisor
    if (!parent || parent === current) break
    current = parent
  }
  return current ?? agent
}

function isRootAgent(ctx, agent) {
  try {
    const agents = ctx?.get?.('agents')
    if (!agents || typeof agents.roots !== 'function') return true
    return agents.roots().includes(agent)
  } catch {
    return true
  }
}

function sessionIdOf(agent) {
  const owner = owningAgent(agent)
  return String(owner?.session?.id ?? agent?.session?.id ?? 'global')
}

function createProposePlan(config, state) {
  return {
    name: 'propose_plan',
    description:
      'Register the plan you want the user to approve. Required before any action tool: execution is off until ' +
      'the user approves. You MUST list every action tool the plan will use, exactly as named — a call to an ' +
      'unlisted tool is blocked and needs the user to confirm it separately. This tool registers only; it does ' +
      'not approve or execute anything. After calling it and seeing registered: true, present the plan to the ' +
      'user and stop.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: {
          type: 'string',
          description: "The complete plan as markdown, starting with a # heading. Write it in the user's language.",
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every action tool this plan will call (for example: write, edit, pwsh), exactly as named. ' +
            'Pass [] only if the plan needs no action.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every file the plan will create or modify, preferably as absolute paths. ' +
            'A path ending in / approves that whole directory.',
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every command the plan will run, exactly as written. A trailing * marks a deliberate prefix.',
        },
        network: { type: 'boolean', description: 'Whether the plan needs network access.' },
        subagents: { type: 'boolean', description: 'Whether the plan starts subagents or workflows.' },
      },
      required: ['plan', 'tools'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { registered: { type: 'boolean' } },
        required: ['registered'],
      },
      render: (args, value) => {
        const m = messages(detectLocale(args?.plan, config.locale))
        return [{ type: 'text', text: value?.registered === true ? m.registered : m.badPlan }]
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: firstHeading(args?.plan) ?? 'Plan',
      kind: 'other',
      content: [
        { type: 'text', text: String(args?.plan ?? '') },
        { type: 'text', text: '```\n' + describeScope(normalizeScopeSafe(args)) + '\n```' },
      ],
    }),
    execute: async (args, exec) => {
      const plan = String(args?.plan ?? '').trim()
      const locale = detectLocale(plan, config.locale)
      const m = messages(locale)
      if (!isPlanDocument(plan)) throw new Error(m.badPlan)
      const scope = normalizeScope(args)
      const sessionId = sessionIdOf(exec?.agent)
      state.setLocale(sessionId, locale)
      state.setDraft(sessionId, scope)
      return { registered: true }
    },
  }
}

/** Best-effort scope preview for the card; a malformed one must not throw. */
function normalizeScopeSafe(args) {
  try {
    return normalizeScope(args)
  } catch {
    return undefined
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const state = new GateState()
  const log = loggerOf(ctx)
  const debug = (line) => {
    if (config.debug) log.info(`[plan-gate] ${line}`)
  }
  let disabled = false

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({ name: 'plan-gate:policy', order: 480, text: () => PROMPT })
  })

  // The human's replies are the only approval channel.
  ctx.on(
    'session/event',
    (session, event) => {
      try {
        if (event?.type !== 'user/message') return
        if (event.data?.source?.kind !== 'user') return
        const sessionId = String(session?.id ?? 'global')
        const text = textOf(event.data?.content)
        state.setLocale(sessionId, detectLocale(text, config.locale))

        const snapshot = state.snapshot(sessionId)
        const reply = classifyReply(text, { extraWords: config.approvalWords })

        if (reply.kind === 'approve') {
          if (snapshot.pending !== null) {
            const granted = state.grantPending(sessionId)
            if (granted !== undefined) debug(`granted ${granted.kind}: ${granted.value}`)
            return
          }
          if (snapshot.mode === 'thinking' && snapshot.draft !== null) {
            state.approveDraft(sessionId)
            debug('plan approved')
            return
          }
          // An approval with nothing to approve — a duplicate, or one sent
          // before a plan exists — is not a new instruction. Ignoring it keeps
          // a standing approval alive instead of revoking it by typo.
          debug('approval ignored: nothing pending')
          return
        }

        if (reply.kind === 'amend') {
          state.amend(sessionId, reply.note)
          debug(`amendment recorded: ${reply.note}`)
          return
        }

        if (snapshot.mode === 'approved' && isContinuation(text)) {
          debug('continuation kept the approval')
          return
        }
        state.reset(sessionId)
        debug('new instruction: execution off')
      } catch (error) {
        log.warn(`[plan-gate] session event failed: ${error?.message ?? error}`)
      }
    },
    { global: true },
  )

  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = String(exec?.name ?? '').toLowerCase()
    const agent = exec?.agent
    const sessionId = sessionIdOf(agent)
    const m = messages(state.snapshot(sessionId).locale ?? 'en')

    try {
      if (disabled) return next()
      if (!isGated(tool, config)) return next()
      if (agent === undefined) return next()
      if (config.exemptDelegated && !isRootAgent(ctx, agent)) return next()

      const snapshot = state.snapshot(sessionId)
      const scope = snapshot.scope

      if (snapshot.mode !== 'approved' || scope === null) {
        let reason
        if (snapshot.draft !== null) reason = m.awaitingPlan(tool)
        else if (snapshot.amendment !== null) reason = m.revisionRequired(tool, snapshot.amendment)
        else reason = m.executionOff(tool)
        return { kind: 'deny', reason }
      }
      if (snapshot.pending !== null) return { kind: 'deny', reason: m.awaitingPending(snapshot.pending) }

      if (!scope.tools.includes(tool)) {
        state.setPending(sessionId, { kind: 'tool', value: tool, tool })
        return { kind: 'deny', reason: m.toolNotApproved(tool) }
      }
      if (isNetworkTool(tool) && !scope.network) {
        state.setPending(sessionId, { kind: 'network', value: tool, tool })
        return { kind: 'deny', reason: m.networkNotApproved(tool) }
      }
      if (isDelegationTool(tool) && !scope.subagents) {
        state.setPending(sessionId, { kind: 'subagents', value: tool, tool })
        return { kind: 'deny', reason: m.subagentsNotApproved(tool) }
      }

      const command = commandOf(tool, exec.arguments)
      if (command !== null && !commandApproved(command, scope.commands)) {
        const value = String(command).replace(/\s+/g, ' ').trim()
        state.setPending(sessionId, { kind: 'command', value, tool })
        return { kind: 'deny', reason: m.commandNotApproved(value) }
      }

      const targets = fileTargets(tool, exec.arguments)
      if (targets !== null) {
        for (const target of targets) {
          if (pathApproved(target, scope.files)) continue
          state.setPending(sessionId, { kind: 'file', value: target, tool })
          return { kind: 'deny', reason: m.fileNotApproved(target) }
        }
      }

      return next()
    } catch (error) {
      log.warn(`[plan-gate] gate failed, denying "${tool}": ${error?.message ?? error}`)
      return { kind: 'deny', reason: m.internal }
    }
  })

  try {
    ctx.tools.register(createProposePlan(config, state))
  } catch (error) {
    // Without the registration tool there is no path to approval at all, so a
    // hard gate here would lock the session forever. Open, and say so loudly.
    disabled = true
    log.warn(`[plan-gate] cannot register propose_plan, the gate is DISABLED: ${error?.message ?? error}`)
  }
}
