/**
 * Per-session gate state.
 *
 * In-process only by design: a restart drops every approval, so the next
 * action asks again. Failing towards one extra confirmation is the right
 * direction for a gate whose job is to stop unapproved work.
 *
 * States:
 *   thinking  execution off; the model may read and reply
 *   approved  one frozen scope is in force
 *
 * `draft` is a registered plan waiting for the user's reply; `pending` is one
 * blocked out-of-scope action waiting for the user's confirmation; `amendment`
 * is a requirement the user added while approving ("同意，但还要加个日志"),
 * which the next plan has to absorb.
 */

const EMPTY = () => ({
  mode: 'thinking',
  scope: null,
  draft: null,
  pending: null,
  amendment: null,
  locale: undefined,
})

export class GateState {
  #sessions = new Map()

  #of(sessionId) {
    const key = String(sessionId)
    let state = this.#sessions.get(key)
    if (state === undefined) {
      state = EMPTY()
      this.#sessions.set(key, state)
    }
    return state
  }

  /** @returns the live record; callers must not mutate it structurally. */
  snapshot(sessionId) {
    return this.#of(sessionId)
  }

  /** Back to read-only, forgetting draft, scope, pending request, and amendments. */
  reset(sessionId) {
    const state = this.#of(sessionId)
    const locale = state.locale
    this.#sessions.set(String(sessionId), { ...EMPTY(), locale })
  }

  setLocale(sessionId, locale) {
    this.#of(sessionId).locale = locale
  }

  /** Register a plan. Registering a new one revokes any standing approval. */
  setDraft(sessionId, scope) {
    const state = this.#of(sessionId)
    state.mode = 'thinking'
    state.scope = null
    state.pending = null
    state.amendment = null
    state.draft = scope
  }

  /** Bind the draft as the scope in force. @returns whether a draft existed. */
  approveDraft(sessionId) {
    const state = this.#of(sessionId)
    if (state.draft === null) return false
    state.scope = state.draft
    state.draft = null
    state.amendment = null
    state.mode = 'approved'
    return true
  }

  /**
   * Record an approval that carried an extra requirement.
   *
   * Execution stays off — the requirement changes the deal — but the plan
   * itself is superseded rather than reviewed: the model has to fold the note
   * into a new plan and submit it again.
   */
  amend(sessionId, note) {
    const state = this.#of(sessionId)
    state.mode = 'thinking'
    state.scope = null
    state.draft = null
    state.pending = null
    state.amendment = String(note ?? '').trim() || null
  }

  /** Record one blocked out-of-scope action awaiting the user's confirmation. */
  setPending(sessionId, pending) {
    this.#of(sessionId).pending = pending
  }

  /**
   * Apply the pending request to the scope, then clear it.
   * @returns the applied request, or undefined when nothing was pending.
   */
  grantPending(sessionId) {
    const state = this.#of(sessionId)
    const pending = state.pending
    if (pending === null || state.scope === null) return undefined
    const scope = state.scope
    // Scope records are frozen, so an extension replaces the record instead of
    // mutating it. Keeping the old value intact until the replace also means a
    // failed extension cannot leave a half-updated scope behind.
    switch (pending.kind) {
      case 'tool':
        state.scope = Object.freeze({ ...scope, tools: [...scope.tools, pending.value] })
        break
      case 'file':
        state.scope = Object.freeze({ ...scope, files: [...scope.files, pending.value] })
        break
      case 'command':
        state.scope = Object.freeze({ ...scope, commands: [...scope.commands, pending.value] })
        break
      case 'network':
        state.scope = Object.freeze({ ...scope, network: true })
        break
      case 'subagents':
        state.scope = Object.freeze({ ...scope, subagents: true })
        break
      default:
        return undefined
    }
    state.pending = null
    return pending
  }
}
