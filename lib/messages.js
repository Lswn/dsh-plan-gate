/**
 * Model- and user-facing strings.
 *
 * Denial reasons are model-facing first (they must be actionable), but they are
 * also what the human sees in the transcript, so they are localized. `auto`
 * follows the last user message's script.
 */

const EN = {
  executionOff: (tool) =>
    `EXECUTION_OFF: "${tool}" is an action and no plan is approved. ` +
    'Call propose_plan with your approach and the exact tool list, present it to the user, then stop. ' +
    'Execution stays off until the user replies.',
  awaitingPlan: (tool) =>
    `AWAITING_APPROVAL: the plan is registered but the user has not approved it. ` +
    `"${tool}" is blocked. Present the plan and stop; do not retry.`,
  awaitingPending: (pending) =>
    `AWAITING_CONFIRMATION: "${pending.value}" is waiting for the user's confirmation. ` +
    'Ask the user and stop; other actions stay blocked until they answer.',
  revisionRequired: (tool, note) =>
    `REVISION_REQUIRED: the user approved the direction but added a requirement: "${note}". ` +
    `"${tool}" stays blocked. Do not execute. Merge that requirement into the plan, call propose_plan ` +
    'again, present the revised plan, and stop for approval.',
  toolNotApproved: (tool) =>
    `TOOL_NOT_APPROVED: "${tool}" is not in the approved tool list. ` +
    'Tell the user which tool you need and why, then stop and wait for their confirmation. Do not retry.',
  fileNotApproved: (path) =>
    `FILE_NOT_APPROVED: "${path}" is not in the approved file list. ` +
    'Tell the user which file you need and why, then stop and wait for their confirmation. Do not retry.',
  commandNotApproved: (command) =>
    `COMMAND_NOT_APPROVED: \`${command}\` is not in the approved command list. ` +
    'Tell the user which command you need and why, then stop and wait for their confirmation. Do not retry.',
  networkNotApproved: (tool) =>
    `NETWORK_NOT_APPROVED: "${tool}" reaches the network and the plan did not approve network access. ` +
    'Tell the user and wait for their confirmation. Do not retry.',
  subagentsNotApproved: (tool) =>
    `SUBAGENTS_NOT_APPROVED: "${tool}" starts another agent and the plan did not approve delegation. ` +
    'Tell the user and wait for their confirmation. Do not retry.',
  badPlan: 'propose_plan needs markdown starting with a # heading, for example "# 修复登录超时".',
  needTools:
    'propose_plan requires `tools`: list every action tool this plan will call, exactly as named. ' +
    'Pass [] only when the plan needs no action at all.',
  registered: 'Plan registered. Present it to the user and stop; execution stays off until they reply.',
  internal:
    'PLAN_GATE_ERROR: the gate failed internally and denied this call. ' +
    'Tell the user the plugin is malfunctioning; disabling it is the only way to restore execution.',
}

const ZH = {
  executionOff: (tool) =>
    `EXECUTION_OFF：当前没有已批准的执行方案，「${tool}」属于实际动作，已拦下。` +
    '请调用 propose_plan 提交方案和明确的工具清单，展示给用户后停下。用户回复批准前，执行保持关闭。',
  awaitingPlan: (tool) =>
    `AWAITING_APPROVAL：方案已登记，但用户还没有批准。「${tool}」已拦下。请展示方案后停下，不要重试。`,
  awaitingPending: (pending) =>
    `AWAITING_CONFIRMATION：「${pending.value}」正在等待用户确认。请询问用户后停下；` +
    '在你得到答复之前，其他动作同样被拦下。',
  revisionRequired: (tool, note) =>
    `REVISION_REQUIRED：用户同意了方向，但补充了要求：「${note}」。「${tool}」仍被拦下。` +
    '不要执行；请把这条要求并入方案，重新调用 propose_plan，重新展示，然后停下等确认。',
  toolNotApproved: (tool) =>
    `TOOL_NOT_APPROVED：「${tool}」不在已批准的工具清单内。` +
    '请向用户说明你需要这个工具、为什么需要，然后停下等待确认。不要重试。',
  fileNotApproved: (path) =>
    `FILE_NOT_APPROVED：「${path}」不在已批准的文件清单内。` +
    '请向用户说明你需要这个文件、为什么需要，然后停下等待确认。不要重试。',
  commandNotApproved: (command) =>
    `COMMAND_NOT_APPROVED：命令 \`${command}\` 不在已批准的命令清单内。` +
    '请向用户说明你需要这条命令、为什么需要，然后停下等待确认。不要重试。',
  networkNotApproved: (tool) =>
    `NETWORK_NOT_APPROVED：「${tool}」需要联网，方案未批准联网。请告知用户并等待确认。不要重试。`,
  subagentsNotApproved: (tool) =>
    `SUBAGENTS_NOT_APPROVED：「${tool}」会创建新的 agent，方案未批准委派。请告知用户并等待确认。不要重试。`,
  badPlan: 'propose_plan 的方案必须以 # 标题开头的 markdown，例如「# 修复登录超时」。',
  needTools:
    'propose_plan 必须提供 `tools`：列出这个方案会调用的全部动作工具，名字要与实际一致。' +
    '确实不需要任何动作时才传 []。',
  registered: '方案已登记。请把它展示给用户，然后停下；用户回复批准前，执行保持关闭。',
  internal:
    'PLAN_GATE_ERROR：闸门内部异常，本次调用已拒绝。请告知用户插件工作不正常；' +
    '恢复执行的唯一办法是停用这个插件。',
}

/** @param locale - 'zh' or 'en'. @returns the message table. */
export function messages(locale) {
  return locale === 'zh' ? ZH : EN
}
