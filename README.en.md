# dsh-plan-gate

A DeepSeek Harness plugin: **execution authority does not belong to the model by default.** Until the user approves a plan, the model can read and talk — and nothing else.

> Two parts. **Part 1 is for users** (what it does, how to use it, where it stops). **Part 2 is for AI maintainers** (design rationale, state machine, and every pitfall we hit).

---

# Part 1 · For users

## The problem

DSH acts the moment it receives an instruction: it produces a pile of throwaway drafts, then patches them one by one. The root cause is not that the model is unwise — it is that **the file write itself is not blocked**, so work starts before there is agreement.

## What it changes

```
You:  switch the login page to SMS codes

DSH:  reads the code (read-only, no interruption)
      calls propose_plan with the plan AND the exact tool list
     ↓
      presents the plan, then stops

You:  同意  (or "ok", "收到", "动吧", "sounds good")
     ↓
DSH:  implements the plan. Steps inside it run without asking;
      anything outside it is blocked until you confirm.
```

## Install

```powershell
dsh plugin --profile desktop add dsh-plan-gate
```

Local development, linked rather than copied:

```powershell
dsh plugin --profile desktop add link:"F:\path\to\dsh-plan-gate"
```

**Restart DSH afterwards.** Host-side plugins load at boot only; editing config or source requires the same restart.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: plan-gate
  name: dsh-plan-gate
  config:
    locale: auto
    exemptDelegated: false
    debug: false
    approvalWords: []
```

| Field | Default | Meaning |
|---|---|---|
| `locale` | `auto` | Follow the conversation's language; force `zh` / `en` if you prefer. |
| `exemptDelegated` | `false` | Let subagents bypass the gate. Off by default: a child runs under its owner's approved scope. |
| `debug` | `false` | Log every state transition. |
| `allowTools` | `[]` | Extra tools that need no plan. |
| `gateTools` | `[]` | Force these tools through the gate even if their name looks read-only. |
| `approvalWords` | `[]` | **Append** approval words (punctuation-boundary tier). No code change needed. |

> A patch layer's `config` replaces the whole config object, not per-field. That is why the defaults are repeated above.

## Three hard rules

1. **Execution is off by default.** Without an approved plan, `write` / `pwsh` / `subagent` / network calls are refused; only read-only tools work.
2. **The plan must list its tools.** `propose_plan` requires `tools`; a tool, file, command, network call, or subagent outside that list needs its own confirmation.
3. **"Approve + one more thing" is not approval — it is an amendment.** The model must fold the requirement into a new plan and ask again.

## How your reply is read

Word order does not matter. Two questions: **is there an approval expression**, and **what is left once it is removed**?

| You send | Verdict |
|---|---|
| 同意 / 好的 / ok / go ahead | approve |
| 先这样，我同意 (approval at the end) | approve |
| 收到 / 好嘞 / 要得 (acknowledgement, dialect) | approve |
| 你执行吧 / 动吧 / 开工吧 | approve |
| 我赞同这个方案 | approve |
| 同意，但还要加个日志 | amend |
| 日志要加，我同意 | amend |
| 可以吗？ / 收到了吗？ | new instruction (question) |
| 不同意 / 先别动 / 不太行 | new instruction (negation) |
| 行距调大一点 / 调整 / 集中 | new instruction (no boundary) |
| 按你说的做了 / 听你的了 | new instruction (past tense) |

## Limits

- **It does not judge the plan.** It guarantees nothing happens before approval, not that the plan is good.
- **The classifier is heuristic.** The bias is "miss rather than mis-grant": single-character verbs only count before a particle ("动吧" yes, "调整" no); characters like 中 / 得 / 妥 / 冲 are never accepted. A miss costs one extra round; a false grant costs the guarantee.
- **Subagents run under their owner's scope.** If the host does not expose the parent link, a child is treated as its own session and blocked; set `exemptDelegated: true` to trust the parent instead.
- **Registration failure disables the plugin** (with a WARN) — otherwise a broken `propose_plan` would lock the session forever.

---

# Part 2 · For AI maintainers

## 0. One-paragraph reproduction

A cordis plugin with three touch points: `session/event` drives a state machine, `tools/pre-execute` enforces the scope, `propose_plan` receives the plan. Zero runtime dependencies, no build step, plain ESM.

## 1. Why not the built-in plan mode

`dsh-plan-mode`'s own comments say entering or leaving it **only changes a prompt section, not the request tool catalog** — the model can still write files while "in plan mode". Enforcement has to be added anyway, so this plugin owns the gate itself and avoids coupling to another plugin's internals.

Rejected alternatives:

| Alternative | Why not |
|---|---|
| Approval through a UI dialog (`userQuestions`) | the model can call it → the model decides when it may work |
| An LLM judging "is this an approval?" | non-deterministic, unreproducible, and hands the decision to another model |
| Prefix/suffix path matching | bypassed by `../a.txt`, `C:/other/a.txt` (pitfall 4) |
| `defineTool` from `@deepseek-ai/dsh-tools` | pins the host version; `tools.register()` accepts a plain object anyway |
| Fail-open on errors | contradicts "never execute without approval" |

## 2. Files

```
lib/index.js           events, gate, propose_plan definition
lib/rules.js           pure rules: read-only set, reply classifier, path/command matching
lib/session-state.js   per-session state machine (in memory)
lib/messages.js        bilingual strings
```

Runtime contract:

```js
export const name = 'plan-gate'
export const inject = ['tools']
export function apply(ctx, config) {}
```

- `ctx.on('session/event', …)` — only `user/message` with `source.kind === 'user'`.
- `ctx.on('tools/pre-execute', async (exec, next) => decision)` — return `{kind:'deny', reason}` to refuse; `return next()` to allow.
- `ctx.tools.register({name, description, parameters, output:{schema, render}, execute, presentCall})` — a plain object; `parameters` uses the host's JSON Schema subset (`additionalProperties` must be a boolean).

## 3. State machine

```
{ mode: 'thinking' | 'approved', scope, draft, pending, amendment, locale }
```

| Trigger | Condition | Effect |
|---|---|---|
| `propose_plan` | valid plan | `draft = scope`, `mode = thinking`, revoke any approval |
| reply | `approve` + `pending` | merge the pending item into `scope`, clear `pending` |
| reply | `approve` + `draft` | `scope = draft`, `mode = approved` |
| reply | `approve` with nothing to approve | ignore (do not reset) |
| reply | `amend` | `thinking`, clear draft/scope/pending, record `amendment` |
| reply | `other` + continuation word | keep state |
| reply | anything else | reset |
| tool call | not approved | deny: draft → awaiting approval; amendment → revise; else → execution off |
| tool call | pending exists | deny: resolve that first |
| tool call | tool/file/command/network/subagent outside scope | record `pending`, deny |

Only one `pending` at a time, so "同意" cannot be ambiguous.

## 4. Classifier

```
1) question?      → other
2) scan approvals: strong anywhere / weak on a boundary / single-char verb before a particle
3) none found     → other
4) strip the approval phrases (and nested weak words)
5) strip particles and references (就/吧/了/这样/这个方案/我觉得/我…)
6) empty → approve; otherwise → amend(note)
```

Three tiers exist because one list cannot be both sensitive and safe:

- **strong** (同意/批准/赞同/认可/没问题/准了 + English) is unambiguous, so position does not matter — that is what makes inverted wording work.
- **weak** (可以/好的/收到/好嘞…) is ordinary prose mid-sentence ("行距", "可以优化"), so it needs a boundary.
- **single-character verbs** (动/上/来/搞/整) have the widest blast radius ("调整", "乱搞"), so they only count before a particle.

Negation looks 3 characters back (不/别/没/未/勿/不用/不要/无需/没有, plus English `not/no/don't`). Past tense is special-cased: `听你的了` reports what already happened, so `PAST_SENSITIVE` phrases followed by 了 are not approval, and 做 is deliberately absent from the filler list so the residue makes it an amendment.

## 5. Path matching

A plan says `a.txt`; the call may say `../a.txt`, `C:/other/a.txt`, or `a.txt`. Literal suffix matching approves the first two as well, which voids the scope.

Rules (no workspace root needed):

1. lexical normalisation: unify separators, resolve `.` and `..`, note whether it escaped above the start;
2. absolute matches absolute only, relative matches relative only;
3. an escape above the start is refused;
4. a trailing `/` entry matches by segment prefix.

Cost: a relative plan with an absolute call asks for confirmation — hence the prompt tells the model to write absolute paths.

Commands match **exactly** (whitespace-normalised, case-insensitive) unless the entry ends in `*`; a prefix would also approve `pnpm test && rm -rf`.

## 6. Pitfalls

**1. A character class swallowed thousands of Han characters.** `[…~—-吧]` parsed `—-吧` as the range U+2014–U+5427, so 好像 matched. Fix: escape the hyphen. Guarded by `好像有点问题` / `行距调大一点`.

**2. Residue destroyed punctuation inside requirements.** A global punctuation replace turned `b.txt` into `b txt`. Fix: trim only the edges. Guarded by the amendment carrying `b.txt`.

**3. A duplicate 同意 revoked approval.** An approval with nothing to approve fell through to the reset branch. Fix: ignore it. Guarded by `a redundant approval keeps execution on`.

**4. Suffix path matching let `../a.txt` and `C:/other/a.txt` through.** Fix: §5. Guarded by the two escape tests.

**5. Inverted approvals were treated as new instructions**, discarding the draft. Fix: scan anywhere + residue. Guarded by `approval survives inverted word order`.

**6. Single-character verbs hit 调整 / 乱搞 / 集中.** Fix: particle-only boundary. Guarded by the lookalike tests.

**7. Past tense read as approval** (`按你说的做了`) — the dangerous direction. Fix: `PAST_SENSITIVE` + no 做 filler. Guarded by `a past-tense "了" is not an approval`.

**8. Emoji turned approval into amendment** (`同意👍`). Fix: pictographs in the boundary class and in edge trimming. Guarded by `同意👍` / `收到👌`.

**9. fail-open vs fail-closed.** A gate error denies (fail-closed); a failed `propose_plan` registration disables the plugin (fail-open) because there would be no approval channel left — a broken gate must not lock a session forever.

**10. Editing source does not take effect.** Host plugins are loaded and cached at boot. After `link:` installs, source and config changes need a restart.

## 7. Test matrix (91 cases)

| Suite | Count | Responsibility |
|---|---|---|
| `rules.test.mjs` | 16 | pure rules: classification, config, paths, commands |
| `gate.test.mjs` | 18 | gate behaviour: approval, out-of-scope, delegation, registration failure |
| `stress.test.mjs` | 28 | adversarial: injection, sessions, concurrency, 1 MiB plan, prototype pollution, perf |
| `amend.test.mjs` | 20 | three-way classification: inverted, colloquial, dialect, past tense, questions |
| `stress2.test.mjs` | 9 | second round: reported speech, emoji, mixed language, parallel sessions |

```bash
node test/rules.test.mjs
node test/gate.test.mjs
node test/stress.test.mjs
node test/amend.test.mjs
node test/stress2.test.mjs
```

## 8. Adding words

1. Write **three non-approval sentences** containing the candidate; confirm none of them match.
2. Pick the tier: unique meaning → strong; everyday word → punctuation boundary; single-character verb → particle boundary.
3. Add it to `rules.js` and add both positive and negative cases.
4. All five suites green before shipping.
5. User-specific phrasing belongs in `approvalWords`, not in code.

## License

MIT
