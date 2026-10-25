# dsh-plan-gate

DeepSeek Harness 插件：**执行权默认不在模型手里。** 用户批准之前，模型只能读、只能说，任何实际动作都执行不了。

> 本文分两部分。**第一部分写给使用者**，讲它解决什么问题、怎么用、边界在哪。
> **第二部分写给 AI 维护者**，讲设计推导、状态机、以及我们踩过的每一个坑——读完应当能从零复现。

---

# 第一部分 · 给人看

## 它解决什么问题

DSH 收到指令就动手：先写出一堆废版，再一点一点改。根因不是模型不聪明，是**「写文件」这个动作没有被拦住**——它可以在还没有跟你对齐方案的时候，就已经动了几十个文件。

这个插件把「先想、先确认、再执行」变成流程上绕不过去的顺序：不是靠提示词劝模型，而是在工具调用层直接拦。

## 一次对话长什么样

```
你：把登录改成短信验证码

DSH：读代码（只读，不打扰）
     调用 propose_plan，提交方案 + 明确的工具清单
     ↓
     方案正文展示给你，然后停下

你：同意          ← 也可以说「收到」「好嘞」「动吧」「我觉得可以」
     ↓
DSH：按方案执行。方案内的动作直接放行
     清单外的工具 / 文件 / 命令 → 拦下，等你确认
```

## 安装

```powershell
dsh plugin --profile desktop add dsh-plan-gate
```

本地开发用目录链接（不复制文件）：

```powershell
dsh plugin --profile desktop add link:"F:\path\to\dsh-plan-gate"
```

装完**必须重启 DSH**：Host 侧插件只在启动时加载。改配置、改源码同理。

## 配置

写在 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`）：

```yaml
- id: plan-gate
  name: dsh-plan-gate
  config:
    locale: auto
    exemptDelegated: false
    debug: false
    approvalWords: []
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `locale` | `auto` | 按会话语言选中英文案；也可强制 `zh` / `en`。 |
| `exemptDelegated` | `false` | 子代理不再受闸门约束。默认关闭：子代理继承父会话的已批准清单。 |
| `debug` | `false` | 把状态切换写进日志。 |
| `allowTools` | `[]` | 额外放行、不需要方案的工具名。 |
| `gateTools` | `[]` | 强制要求方案的工具名，优先级高于内置只读名单。 |
| `approvalWords` | `[]` | **追加**批准词，进「标点边界」档。加词不用改代码。 |

> patch 层的 `config` 会**覆盖整个 config**，不是逐字段合并。所以上面把默认值也写全了。

## 三条硬规则

1. **默认关闭执行。** 没有批准方案，`write` / `pwsh` / `subagent` / 联网一律拒绝，只有只读工具能用。
2. **方案必须列清楚工具。** `propose_plan` 强制要求 `tools` 字段；清单外的工具、文件、命令、联网、子代理都要你单独点头。
3. **「同意 + 新要求」不是批准，是修订。** 你说「同意，但还要加个日志」，模型必须把要求并进方案、重新提交、再等你确认。

## 你的回复怎么被判读

不看语序，只看两件事：**有没有批准表达**、**除了批准之外还剩什么**。

| 你发的 | 判定 |
|---|---|
| 同意 / 好的 / ok / go ahead | 批准 |
| 先这样，我同意 | 批准（倒装也认） |
| 收到 / 好嘞 / 得嘞 / 要得 | 批准（应答词与方言） |
| 就这么办 / 听你的 / 你说了算 | 批准 |
| 你执行吧 / 动吧 / 开工吧 / 整吧 | 批准（口语祈使） |
| 我赞同这个方案 | 批准（正式同义词） |
| 同意，但还要加个日志 | 修订 |
| 日志要加，我同意 | 修订（倒装也能带要求） |
| 可以吗？ / 收到了吗？ | 新指令（提问） |
| 不同意 / 先别动 / 不太行 | 新指令（否定） |
| 行距调大一点 / 好像有点问题 / 调整 / 集中 | 新指令（收尾字不是边界） |
| 按你说的做了 / 听你的了 | 新指令（过去式，不是批准） |

判定顺序：**排除提问 → 排除否定 → 找批准表达 → 删掉它、去掉语气词 → 剩空即批准，剩内容即修订。**

## 加自己的词

`approvalWords` 里的词进「标点边界」档，和内置的 可以 / 好的 / 收到 / 好嘞 同等待遇：

- 算批准：`整吧`、`靠谱`、`靠谱，`
- 不算：`整一下`、`靠谱吗？`

规则：最多 12 字、自动去重、只在结尾或标点/语气词前生效。

## 它不保证什么

- **不判断方案好坏。** 它保证「没批准不动手」，不保证模型想得对。
- **判定是启发式的。** 选词原则是「宁可漏，不可误放」：单字动词只在带语气词时算（「动吧」算，「调整」不算）；收尾字（中/得/妥/冲）一律不收。漏判的代价是多提一轮方案，误放行的代价是执行没被批准的活。
- **子代理继承父清单。** 宿主不暴露父子关系时，子代理会被当作独立会话拦下；可设 `exemptDelegated: true` 放行（等于信任父代理）。
- **注册失败会自我禁用。** 如果 `propose_plan` 注册不上，就没有任何批准通道，硬拦会把会话永久锁死——这种情况插件放行并写 WARN 日志。

---

# 第二部分 · 给 AI 维护者

## 0. 一句话复现

一个 cordis 插件，三个接触点：`session/event` 驱动状态机、`tools/pre-execute` 做拦截、`propose_plan` 接收方案。零运行时依赖、无构建、纯 ESM。

## 1. 为什么不用内置 plan mode

`dsh-plan-mode` 的源码注释写得很清楚：进入/退出**只改变提示词段落，不改变请求的工具目录**。也就是说模型在 plan mode 里照样可以写文件——它只是被建议别写。

想让它生效也必须加同一个闸门；那就干脆自己拿闸门，少耦合一层别人的内部状态（对一个要长期发布的 npm 包尤其重要）。

**被否掉的备选方案：**

| 方案 | 否掉的理由 |
|---|---|
| 审批走 UI 按钮（`userQuestions`） | 模型可以自己调用它 → 等于把「什么时候能干活」的开关交给模型 |
| 用 LLM 判定「这句话算不算批准」 | 不确定、不可复现、有成本；而且判定权不该再交给一个模型 |
| 前缀/后缀匹配路径 | 可被 `../a.txt`、`C:/other/a.txt` 绕过（见坑 4） |
| 依赖 `@deepseek-ai/dsh-tools` 的 `defineTool` | peer 版本钉死宿主，升级即可能不加载；`tools.register()` 本来就接受普通对象 |
| fail-open（出错放行） | 与「永远不能执行」直接冲突 |

## 2. 架构

```
lib/index.js          事件注册、闸门、propose_plan 定义
lib/rules.js          纯规则：只读名单、批准判定、路径/命令匹配、配置归一化
lib/session-state.js  会话状态机（内存）
lib/messages.js       中英双语文案
```

运行时契约：

```js
export const name = 'plan-gate'
export const inject = ['tools']
export function apply(ctx, config) { /* 1 个 section + 2 个事件 + 1 个工具 */ }
```

- `ctx.on('session/event', (session, event) => {})` —— 只处理 `user/message` 且 `source.kind === 'user'`。
- `ctx.on('tools/pre-execute', async (exec, next) => decision)` —— 返回 `{kind:'deny', reason}` 即拒绝；放行必须 `return next()`。
- `ctx.tools.register({name, description, parameters, output:{schema, render}, execute, presentCall})` —— 普通对象即可，`parameters` 走宿主支持的 JSON Schema 子集（`additionalProperties` 只能是布尔）。

## 3. 状态机

每个会话一条记录：

```
{
  mode: 'thinking' | 'approved',
  scope: null | { plan, tools[], files[], commands[], network, subagents },
  draft: null | scope,        // 已登记、待批准的方案
  pending: null | {kind, value, tool},  // 一个被拦下、等确认的越界动作
  amendment: null | string,   // 用户「同意 + 新要求」里那部分新要求
  locale: 'zh' | 'en'
}
```

转移表：

| 触发 | 条件 | 结果 |
|---|---|---|
| `propose_plan` | 方案合法（`#` 开头、带 `tools`） | `draft = scope`，`mode = thinking`，撤销既有批准 |
| 用户回复 | 判定为 `approve` 且有 `pending` | 把 `pending` 并入 `scope`（tool/file/command/network/subagents），清空 `pending` |
| 用户回复 | 判定为 `approve` 且有 `draft` | `scope = draft`，`mode = approved`，清空 `amendment` |
| 用户回复 | 判定为 `approve` 但无可批对象 | **忽略**，不重置（防手滑） |
| 用户回复 | 判定为 `amend` | `mode = thinking`，清空 draft/scope/pending，记下 `amendment` |
| 用户回复 | 判定为 `other` 且命中续接词 | 保持现状 |
| 用户回复 | 其它 | 全部清空，回 `thinking` |
| 工具调用 | `mode !== approved` | 拒绝：有 draft → 等批准；有 amendment → 要求并入后重提；否则 → 执行关闭 |
| 工具调用 | 有 `pending` | 拒绝：先处理上一个确认请求 |
| 工具调用 | 工具不在 `scope.tools` | 记 `pending(tool)` 并拒绝 |
| 工具调用 | 文件/命令/联网/子代理越界 | 记对应 `pending` 并拒绝 |
| 工具调用 | 全部命中 | 放行 |

**为什么 `pending` 只允许一条**：多条会让「同意」指向不明。先解决一条，再谈下一条。

**为什么越界不「锁死」而是「等确认」**：锁死会把「漏写一个文件」变成整轮作废；等确认既满足「没点头不执行」，又不惩罚小失误。

## 4. 判定器：三档 + 剥离-残余

`classifyReply(text)` 是唯一入口，返回 `approve | amend | other`。

```
1) 提问？      以 ？/?/吗/呢 结尾，或含 是否/是不是/可不可以        → other
2) 扫批准表达   强词任意位置 / 弱词在边界 / 单字动词在语气词前
3) 没扫到                                                          → other
4) 删掉批准表达（包括嵌套的弱词）
5) 剥掉语气词（就/吧/了/这样/这个方案/我觉得/我/执行吧…）
6) 剩余为空 → approve；非空 → amend(note = 剩余)
```

**为什么分三档**（而不是一张大表）：

- 强词（同意/批准/赞同/认可/没问题/准了/英文那批）语义唯一，放任意位置都安全，才能支持倒装。
- 弱词（可以/好的/行/收到/好嘞…）在中句里是普通汉字（「行距」「可以优化」），必须靠边界。
- 单字动词（动/上/来/搞/整）误伤面最大（「调整」「乱搞」），只认语气词。

**否定与过去式**

- 否定：批准词前 3 字内有 不/别/没/未/勿/不用/不要/无需/没有，或英文 not/no/don't。
- 过去式：`听你的了`、`按你说的做了` 是汇报已发生的事，不是批准——`PAST_SENSITIVE` 里的短语后跟「了」直接不算；`做` 也从语气词表里拿掉了，让它留在残余里，把句子降级成 amend。

## 5. 路径匹配：为什么不能靠后缀

批准时方案写 `a.txt`，调用时可能是 `../a.txt`、`C:/other/a.txt`、`a.txt`。字面后缀匹配会把前两个也放行——清单形同虚设。

采纳的规则（不需要 workspace root）：

1. 词法归一化：统一分隔符、吃掉 `.` 和 `..`，记录是否越过顶部。
2. 绝对只配绝对，相对只配相对；跨形态一律不认（由用户确认）。
3. 越过顶部的 `..` 直接拒绝。
4. 目录条目（以 `/` 结尾）按段边界做前缀匹配。

代价：方案写相对、调用给绝对时会多一次确认。所以系统提示要求**方案的 files 写绝对路径**。

命令匹配则是**精确匹配**（空白归一化、大小写不敏感），条目以 `*` 结尾才表示前缀——否则 `pnpm test` 会连带放行 `pnpm test && rm -rf`。

## 6. 踩坑清单

> 每一条都是真实发生过的，不是设想的。格式：现象 → 根因 → 修法 → 守它的测试。

**坑 1 · 正则字符类吞掉几千汉字**
- 现象：「好像有点问题」被判成修订。
- 根因：字符类写成 `[…~—-吧]`，`—-吧` 被解析成 Unicode 区间 U+2014–U+5427，汉字「像」落在里面。
- 修法：连字符转义 `\\-`。
- 测试：`好像有点问题`、`行距调大一点` 必须不是批准。

**坑 2 · 剥离残余时把正文标点吃光**
- 现象：要求里的 `b.txt` 变成 `b txt`。
- 根因：`residue` 用 `/[\s。.!！…]/g` 全局替换，把文件名里的点也换了。
- 修法：只清首尾（`trimEdges`），中间标点原样保留。
- 测试：修订时 note 必须包含 `b.txt`。

**坑 3 · 重复「同意」把已批准状态重置**
- 现象：执行中再发一次「同意」，执行权被收回。
- 根因：批准词没有可批准对象时落到「新指令」分支。
- 修法：`approve` 但无可批对象 → 忽略。
- 测试：`a redundant approval keeps execution on`。

**坑 4 · 路径后缀匹配可被绕过**
- 现象：批准 `a.txt`，却写进了 `../a.txt` 和 `C:/other/a.txt`。
- 根因：`endsWith('/'+a)` 没有「根」的概念。
- 修法：词法归一化 + 同形态比较（见 §5）。
- 测试：`a parent-relative path…`、`an absolute path outside…`。

**坑 5 · 倒装句把 draft 冲掉**
- 现象：「先这样，我同意」被判成新指令，已登记方案被清空，用户要重来。
- 根因：只认「批准词在开头」。
- 修法：任意位置扫描 + 剥离残余。
- 测试：`approval survives inverted word order`。

**坑 6 · 单字动词误伤**
- 现象：「调整」「乱搞」「集中」被当成批准。
- 根因：单字进了弱词表且允许结尾匹配。
- 修法：单字动词只在语气词前才算；`做` 不进语气词表。
- 测试：`words that merely end in an approval character…`。

**坑 7 · 过去式误判**
- 现象：「按你说的做了」被判成批准——这是最危险的方向。
- 根因：「了」既是语气也是完成态。
- 修法：`PAST_SENSITIVE` 短语后跟「了」不算；`做` 留在残余里降级为 amend。
- 测试：`a past-tense "了" is not an approval`。

**坑 8 · emoji 让批准变修订**
- 现象：「同意👍」被判成修订，note 是 `👍`。
- 根因：emoji 既不在边界字符里，也不在残余清理里。
- 修法：边界类加 `\p{Extended_Pictographic}`；`trimEdges` 清理首尾图形符号。
- 测试：`同意👍`、`收到👌` 必须是批准。

**坑 9 · fail-open 与 fail-closed 的取舍**
- 闸门内部异常 → 拒绝（fail-closed），因为这是「不能执行」的保证。
- 但 `propose_plan` 注册失败 → **自我禁用**（fail-open），否则没有任何批准通道，会话会被永久锁死。
- 两者不矛盾：前者是「判定出错时不动手」，后者是「没有审批通道时不能把人锁死」。

**坑 10 · 改了源码不等于生效**
- Host 侧插件在启动时加载并缓存。`link:` 安装后改源码、改配置，都必须重启 DSH。
- 这一点在开发期反复咬人：测试全绿但线上行为没变，十有八九是没重启。

## 7. 测试矩阵（91 条）

| 套件 | 数量 | 职责 |
|---|---|---|
| `rules.test.mjs` | 16 | 纯规则：分类、配置、路径、命令 |
| `gate.test.mjs` | 18 | 闸门行为：批准、越界、确认、子代理、注册失败 |
| `stress.test.mjs` | 28 | 对抗：注入、跨会话、并发、1MB 方案、原型污染、性能 |
| `amend.test.mjs` | 20 | 三分法：倒装、口语、方言、过去式、反问 |
| `stress2.test.mjs` | 9 | 二轮：转述、emoji、混排、并行会话、长消息 |

跑法（沙箱里 `node --test` 会 spawn 子进程，需逐个跑）：

```bash
node test/rules.test.mjs
node test/gate.test.mjs
node test/stress.test.mjs
node test/amend.test.mjs
node test/stress2.test.mjs
```

## 8. 加词的规程

1. 先写**三个非批准句子**，把候选词放进去，确认都不命中。
2. 判断档位：语义唯一 → 强词；日常词 → 标点边界；单字动词 → 语气词边界。
3. 加进 `rules.js` 对应常量，同时在 `amend.test.mjs` 补正反用例。
4. 跑五套全绿再谈发布。
5. 用户临时想要的说法，走 `approvalWords` 配置，不要改代码。

## 9. 从零复现

1. `package.json`：`"type": "module"`、`main: lib/index.js`、`dsh.bundle.patch`、零依赖。
2. `cordis.patch.yml`：`- insert: [{ id: plan-gate, name: dsh-plan-gate, config: {...} }]`。
3. 先写 `rules.js`（纯函数）+ 它的测试，把判定和路径规则钉死。
4. 再写 `session-state.js`（纯状态），最后写 `index.js` 接线。
5. 接线只做三件事：`session/event` 调状态机、`pre-execute` 查 scope、注册 `propose_plan`。
6. `dsh plugin --profile desktop add link:"<路径>"`，**重启 DSH**。
7. 用一句口语批准一次（比如「动吧」），验证真实流量。

## 10. 发布前检查

- [ ] 五套测试全绿
- [ ] `package.json` 的 `test` 脚本指向实际存在的文件
- [ ] `npm pack --dry-run` 确认 `test/`、`node_modules`、`_scratch/` 不入包
- [ ] README 的两部分都更新（尤其词表和踩坑清单）
- [ ] 没有 `@deepseek-ai/*` 运行时依赖

## 许可

MIT
