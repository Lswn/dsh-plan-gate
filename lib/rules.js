/**
 * Pure rules for dsh-plan-gate.
 *
 * No cordis, no filesystem, no clock: everything the gate decides is a function
 * of the call and the approved scope, so the rules can be tested in isolation
 * and audited in one file.
 */

/** Defaults for every config field. Unknown fields are ignored, never fatal. */
const DEFAULTS = {
  locale: 'auto',
  exemptDelegated: false,
  debug: false,
  allowTools: [],
  gateTools: [],
  approvalWords: [],
}

/**
 * Tools that only observe the workspace or talk to the human.
 *
 * Everything absent from this list is an action and needs an approved plan.
 * Default-deny is deliberate: a tool shipped by a future DSH release must not
 * become a silent bypass just because this package predates it.
 */
export const READ_ONLY_TOOLS = new Set([
  'read',
  'read_file',
  'read_text',
  'glob',
  'grep',
  'list',
  'list_dir',
  'ls',
  'find',
  'search',
  'view',
  'todo_write',
  'ask_user_question',
  'present',
  'job_output',
  'job_list',
  'get_goal',
  'schedule_list',
  'skill',
  'working_directory',
  'load_workspace_dependencies',
  'list_agents',
  'exit_plan_mode',
  // This plugin's own registration tool. It asks the human; it acts on nothing.
  'propose_plan',
])

/** Tools that write or edit a file. */
const FILE_WRITE_TOOLS = new Set(['write', 'write_file', 'edit', 'str_replace_editor', 'create_file'])

/** Tools that run a shell command. */
const COMMAND_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal', 'exec', 'command', 'run'])

/** Tools that reach the network. */
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search', 'fetch', 'http_request'])

/** Tools that create another agent. */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'agent', 'team'])

/** Argument keys naming a file-writing tool's target. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'target']

/** Argument keys naming a command tool's command line. */
const COMMAND_KEYS = ['command', 'cmd', 'script']

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/** Sentence-final particles: they soften or complete an approval. */
const PARTICLES = '吧啊了呀呢啦咯哒嘞'

/**
 * Sentence punctuation, whitespace, particles, and pictographs. An emoji after
 * "同意" is decoration, not a requirement.
 *
 * The hyphen is escaped: unescaped, `—-吧` is a character RANGE from U+2014 to
 * U+5427 and silently swallows thousands of Han characters.
 */
const BOUNDARY = `[\\s。.!！,，:：;；~—\\-${PARTICLES}\\p{Extended_Pictographic}]`

/** Particles only — for verbs too ambiguous to accept ordinary punctuation. */
const PARTICLE = `[${PARTICLES}]`

/** Punctuation and symbols that may sit at either end without meaning anything. */
const EDGES = /^[\s。.!！,，:：;；~—-]+|[\s。.!！,，:：;；~—-]+$/g
const EDGE_GLYPHS = /^[\p{Extended_Pictographic}\uFE0F\u200D]+|[\p{Extended_Pictographic}\uFE0F\u200D]+$/gu

/**
 * Unambiguous approval phrases. These count anywhere in the reply, so inverted
 * wording ("先这样，我同意") is understood. Formal synonyms live here because
 * "我赞同这个方案" leaves only reference words behind, which the filler list
 * already removes.
 */
const STRONG = new RegExp(
  [
    '同意',
    '批准',
    '赞同',
    '赞成',
    '认可',
    '没问题',
    '按这个来',
    '按这个',
    '就这样',
    '准了',
    // English needs boundaries: "book" must not contain "ok".
    '\\b(?:approved|approve|lgtm|proceed|go ahead|sure thing|got it|alright|okay|okie|okey|yeah|yup|sure|roger|yes|ok|do it)\\b',
  ].join('|'),
  'giu',
)

/**
 * Phrases whose "了" turns them into a report of what already happened
 * ("听你的了", "按你说的做了") rather than an approval.
 */
const PAST_SENSITIVE = new Set([
  '听你的',
  '按你说的',
  '按你说的办',
  '依你',
  '随你',
  '就这么办',
  '就这么定',
  '就这么着',
])

/**
 * Words safe to accept before punctuation, a particle, or the end of the reply.
 * Mid-sentence they are ordinary Chinese ("行距", "好像", "可以优化",
 * "跑一下"), so the boundary keeps those out.
 */
const WEAK_A_BASE = [
  '按你说的办',
  '干就完了',
  '你说了算',
  '就这么办',
  '就这么定',
  '就这么着',
  '听你的',
  '收到',
  '好嘞',
  '得嘞',
  '要得',
  '走起',
  '走着',
  '开整',
  '开干',
  '依你',
  '随你',
  '办它',
  '必须的',
  '妥妥的',
  '欧了',
  '哦了',
  '可以',
  '好的',
  '开始',
  '执行',
  '开工',
  '好',
  '行',
  '跑',
  '干',
]

/**
 * Verbs that are approval only before a particle. Bare "动" or "整" is too
 * easy to hit by accident ("调整", "乱搞", "修改"), so they never count alone —
 * but "改吧" and "做吧" are how people say yes.
 */
const WEAK_B = new RegExp(`(动|上|来|搞|整|改|弄|做)(?=${PARTICLE})`, 'gu')

function escapeWord(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build the punctuation-boundary matcher, with any operator-supplied words. */
function buildWeakA(extraWords) {
  const words = [...new Set([...WEAK_A_BASE, ...extraWords])]
    .map((word) => word.trim())
    .filter((word) => word !== '' && word.length <= 12)
    .sort((a, b) => b.length - a.length)
    .map(escapeWord)
  return new RegExp(`(${words.join('|')})(?=$|${BOUNDARY})`, 'gui')
}

const WEAK_A = buildWeakA([])

/**
 * Particles and references that carry no requirement of their own.
 *
 * "做" is deliberately absent: leaving it behind turns "按你说的做了" into an
 * amendment instead of a false approval.
 */
const FILLERS = [
  '就按这个做',
  '这个方案',
  '我觉得',
  '我认为',
  '看起来',
  '看着',
  '这么办',
  '就这样',
  '执行吧',
  '这个',
  '这样',
  '这么',
  '先',
  '就',
  '吧',
  '了',
  '的',
  '那',
  '嗯',
  '啊',
  '呀',
  '呢',
  '啦',
  '咯',
  '哒',
  '嘞',
  '是',
  '对',
  '都',
  '也',
  '还',
  '我',
  '你',
  '执行',
  '开始',
  '可以',
  '好的',
  '好',
  '行',
  '跑',
  '干',
]

/**
 * "继续" is how people say "go ahead" once a plan is on the table. It is an
 * approval, not a third kind of reply; treating it as "keep the current state"
 * meant a registered plan could never be started with the most natural word.
 *
 * The trailing class allows particles so "继续吧" and "继续啊" work too.
 */
const CONTINUATION = new RegExp(
  '^(' +
    ['继续', '接着', '继续做', '往下', 'go on', 'continue', 'keep going'].join('|') +
    `)[\\s。.!！~${PARTICLES}]*$`,
  'iu',
)

/** Read a config value that a host may hand over wrapped in a `{ get() }` reference. */
function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

function stringOf(value, fallback) {
  const raw = unwrap(value)
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
}

function lowerList(value) {
  const raw = unwrap(value)
  if (raw === undefined || raw === null) return []
  const items = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const item of items) {
    const text = unwrap(item)
    if (typeof text !== 'string' || text.trim() === '') continue
    out.push(text.trim().toLowerCase())
  }
  return out
}

/** A case-preserving string list: operator-supplied approval words. */
function stringList(value) {
  const raw = unwrap(value)
  if (raw === undefined || raw === null) return []
  const items = Array.isArray(raw) ? raw : [raw]
  const out = []
  for (const item of items) {
    const text = unwrap(item)
    if (typeof text !== 'string') continue
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.length > 12) continue
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** Normalise raw loader config. Invalid values fall back; nothing throws. */
export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const locale = stringOf(config.locale, DEFAULTS.locale).toLowerCase()
  return {
    locale: locale === 'zh' || locale === 'en' ? locale : 'auto',
    exemptDelegated: Boolean(unwrap(config.exemptDelegated) ?? DEFAULTS.exemptDelegated),
    debug: Boolean(unwrap(config.debug) ?? DEFAULTS.debug),
    allowTools: lowerList(config.allowTools),
    gateTools: lowerList(config.gateTools),
    approvalWords: stringList(config.approvalWords),
  }
}

/** Whether one tool call is an action that needs the gate. */
export function isGated(name, config) {
  const tool = String(name ?? '').toLowerCase()
  if (tool === '') return false
  if (config.gateTools.includes(tool)) return true
  if (config.allowTools.includes(tool)) return false
  return !READ_ONLY_TOOLS.has(tool)
}

/** A question is never an approval, however it is phrased. */
function isQuestion(value) {
  if (/[？?]\s*$/.test(value)) return true
  if (/(吗|呢|是不是|能否|可不可以)\s*[。.!！~]*$/.test(value)) return true
  return /是否/.test(value)
}

/** Whether the phrase starting at `index` is negated by what precedes it. */
function isNegated(text, index) {
  const before = text.slice(Math.max(0, index - 3), index)
  if (/(没有|不用|不要|无需|不必|[不别没未勿])\s*$/.test(before)) return true
  return /\b(not|no|never|don'?t|dont)\s*$/i.test(before)
}

/**
 * Remove every non-negated approval phrase.
 *
 * @returns the remaining text and whether any approval phrase was found.
 */
function stripApprovals(text, extraWords) {
  let found = false
  const strip = (source, pattern) =>
    source.replace(pattern, (match, ...rest) => {
      const offset = rest[rest.length - 2]
      const whole = rest[rest.length - 1]
      if (isNegated(whole, offset)) return match
      if (PAST_SENSITIVE.has(match) && whole[offset + match.length] === '了') return match
      found = true
      return ' '
    })

  const weakA = extraWords.length > 0 ? buildWeakA(extraWords) : WEAK_A
  const strong = strip(text, STRONG)
  const weak = strip(strong, weakA)
  const verb = strip(weak, WEAK_B)
  return { text: verb, found }
}

/** Trim whitespace, punctuation, and pictographs from the ends only. */
function trimEdges(value) {
  let text = String(value).replace(/\s+/g, ' ').trim()
  let previous
  do {
    previous = text
    text = text.replace(EDGES, '').replace(EDGE_GLYPHS, '').trim()
  } while (text !== previous && text !== '')
  return text
}

/**
 * Drop particles and references from the ends; what is left is a requirement.
 *
 * Only the edges are cleaned, never the middle: a requirement mentioning
 * "b.txt" or "v1.2" must keep its punctuation.
 */
function residue(text) {
  let value = trimEdges(text)
  let changed = true
  while (changed) {
    changed = false
    for (const filler of FILLERS) {
      if (value === filler) {
        value = ''
        changed = true
        break
      }
      if (value.startsWith(filler)) {
        value = trimEdges(value.slice(filler.length))
        changed = true
      }
      if (value.endsWith(filler)) {
        value = trimEdges(value.slice(0, -filler.length))
        changed = true
      }
    }
  }
  return value
}

/**
 * Read one user reply as one of three things.
 *
 * - `approve`: the reply approves and adds nothing.
 * - `amend`: it approves and also carries a requirement ("同意，但还要加个日志",
 *   "日志要加，我同意").
 * - `other`: no approval at all, which is a new instruction.
 *
 * Word order does not matter: a reply is scanned for approval phrases anywhere,
 * then the phrases and their particles are removed. What survives is the
 * requirement. A bare "继续" is an approval too.
 *
 * @param text - the reply's text content.
 * @param options - `{ extraWords }`: operator-supplied approval words.
 * @returns `{ kind, note? }`.
 */
export function classifyReply(text, options = {}) {
  const value = String(text ?? '').trim()
  const extraWords = Array.isArray(options.extraWords) ? options.extraWords : []
  if (value === '') return { kind: 'other' }
  if (isQuestion(value)) return { kind: 'other' }
  if (isContinuation(value)) return { kind: 'approve' }

  const stripped = stripApprovals(value, extraWords)
  if (!stripped.found) return { kind: 'other' }

  const note = residue(stripped.text)
  return note === '' ? { kind: 'approve' } : { kind: 'amend', note }
}

/** Whole-reply approval only. */
export function isApproval(text, options = {}) {
  return classifyReply(text, options).kind === 'approve'
}

/** A bare "keep going" reply, which counts as approval. */
export function isContinuation(text) {
  const value = String(text ?? '').trim()
  return value !== '' && value.length <= 24 && CONTINUATION.test(value)
}

/** Flatten the host's content-part array (or a plain string) to text. */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n').trim()
}

/** Pick a language. `auto` follows the text's own script. */
export function detectLocale(text, configured = 'auto') {
  if (configured === 'zh' || configured === 'en') return configured
  return CJK.test(String(text ?? '')) ? 'zh' : 'en'
}

/** Whether a string is a heading-led markdown plan. */
export function isPlanDocument(text) {
  return /^#\s+\S/.test(String(text ?? '').trim())
}

/** The plan's first markdown heading, for the tool card's title. */
export function firstHeading(text) {
  const match = /^#{1,6}\s+(.+?)\s*$/m.exec(String(text ?? ''))
  return match ? match[1] : undefined
}

/** Paths a file-writing call intends to touch, or null for other tools. */
export function fileTargets(name, args) {
  if (!FILE_WRITE_TOOLS.has(String(name ?? '').toLowerCase())) return null
  if (!args || typeof args !== 'object') return []
  const targets = []
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') targets.push(value.trim())
  }
  return targets
}

/** The command line a command tool intends to run, or null for other tools. */
export function commandOf(name, args) {
  if (!COMMAND_TOOLS.has(String(name ?? '').toLowerCase())) return null
  if (!args || typeof args !== 'object') return ''
  for (const key of COMMAND_KEYS) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/** Whether a command needs a network allowance. */
export function isNetworkTool(name) {
  return NETWORK_TOOLS.has(String(name ?? '').toLowerCase())
}

/** Whether a tool spawns another agent. */
export function isDelegationTool(name) {
  return DELEGATION_TOOLS.has(String(name ?? '').toLowerCase())
}

/**
 * Lexically normalise one path.
 *
 * `.` and `..` are resolved as text — no root is needed, and none is assumed.
 * `escaped` records a `..` that climbed above the starting point, which the
 * gate refuses rather than guessing what it pointed at.
 */
function normalizePath(value) {
  const raw = String(value ?? '').replace(/\\/g, '/')
  const absolute = /^[a-zA-Z]:\//.test(raw) || raw.startsWith('/')
  const parts = []
  let escaped = false
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
      else escaped = true
      continue
    }
    parts.push(segment.toLowerCase())
  }
  return { absolute, key: parts.join('/'), escaped }
}

/**
 * Whether a target path falls inside the approved file list.
 *
 * Absolute targets only match absolute entries and relative only match
 * relative ones. Cross-kind matching was the old behaviour and it let any path
 * with the same tail through (`../a.txt`, `C:/other/a.txt`), so it is gone:
 * a mismatch now asks the user instead of guessing.
 */
export function pathApproved(target, approved) {
  const t = normalizePath(target)
  if (t.key === '' || t.escaped) return false
  for (const entry of approved ?? []) {
    const raw = String(entry).trim()
    if (raw === '') continue
    const isDir = /[\\/]$/.test(raw)
    const a = normalizePath(raw)
    if (a.key === '' || a.escaped) continue
    if (a.absolute !== t.absolute) continue
    if (a.key === t.key) return true
    if (isDir && t.key.startsWith(a.key + '/')) return true
  }
  return false
}

/** Collapse whitespace and case so a command compares by what it runs. */
function normalizeCommand(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Whether a command is inside the approved list.
 *
 * Entries match exactly unless they end in `*`, which marks a deliberate
 * prefix. Exact matching is the default because a prefix would also approve
 * `pnpm test && something-else`.
 */
export function commandApproved(command, approved) {
  const c = normalizeCommand(command)
  if (c === '') return false
  for (const entry of approved ?? []) {
    const raw = normalizeCommand(entry)
    if (raw === '') continue
    if (raw.endsWith('*')) {
      if (c.startsWith(raw.slice(0, -1).trimEnd())) return true
      continue
    }
    if (c === raw) return true
  }
  return false
}

/** Normalise a string list: trimmed, empties dropped, order kept, duplicates removed. */
export function normalizeList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * Validate and normalise one proposed scope.
 *
 * @param args - the `propose_plan` arguments.
 * @returns a frozen scope record.
 * @throws when the tool list is missing or malformed — an unlistable plan is
 *   not approvable, which is the whole point of the field.
 */
export function normalizeScope(args) {
  if (!Array.isArray(args?.tools)) {
    throw new Error('propose_plan requires `tools`: the exact list of action tools this plan will use (pass [] if none).')
  }
  return Object.freeze({
    plan: String(args?.plan ?? '').trim(),
    tools: [...new Set(normalizeList(args.tools).map((name) => name.toLowerCase()))],
    files: normalizeList(args?.files),
    commands: normalizeList(args?.commands),
    network: args?.network === true,
    subagents: args?.subagents === true,
  })
}

/** A one-line summary of a scope, for the tool card and for error messages. */
export function describeScope(scope) {
  if (!scope) return ''
  const parts = []
  parts.push(`tools: ${scope.tools.length > 0 ? scope.tools.join(', ') : '(none)'}`)
  if (scope.files.length > 0) parts.push(`files: ${scope.files.join(', ')}`)
  if (scope.commands.length > 0) parts.push(`commands: ${scope.commands.join(' | ')}`)
  if (scope.network) parts.push('network: yes')
  if (scope.subagents) parts.push('subagents: yes')
  return parts.join('\n')
}
