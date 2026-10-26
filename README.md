# dsh-plan-gate

DeepSeek Harness 插件：**执行权默认不在模型手里。** 用户批准之前，模型只能读、只能说，任何实际动作都执行不了。

> 本文两部分：**第一部分给使用者**，**第二部分给 AI 维护者**（含从零复现与全部踩坑记录）。

---

# 第一部分 · 给人看

## 它解决什么问题

DSH 收到指令就动手：先写出一堆废版，再一点一点改。根因不是模型不聪明，是**「写文件」这个动作没有被拦住**。

这个插件把「先想、先确认、再执行」变成绕不过去的顺序：不靠提示词劝模型，而是在工具调用层直接拦。

## 一次对话

```
你：把登录改成短信验证码

DSH：读代码（只读，不打扰）
     调用 propose_plan，提交方案 + 明确的工具清单
     ↓
     方案正文展示给你，然后停下

你：同意      ← 「收到」「好嘞」「动吧」「继续」都算
     ↓
DSH：按方案执行。方案内的动作放行；
     清单外的工具/文件/命令 → 拦下，等你确认
```

## 安装

```powershell
dsh plugin --profile desktop add dsh-plan-gate
```

本地开发用链接（不复制文件）：

```powershell
dsh plugin --profile desktop add link:"F:\path\to\dsh-plan-gate"
```

装完**必须重启 DSH**：Host 侧插件只在启动时加载；改配置、改源码同理。

## 配置

写在 profile 的 `cordis.patch.yml`：

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
| `locale` | `auto` | 按会话语言选中英文案；可强制 `zh` / `en`。 |
| `exemptDelegated` | `false` | 子代理不再受约束。默认关闭：子代理继承父会话的已批准清单。 |
| `debug` | `false` | 把状态切换写进日志。 |
| `allowTools` | `[]` | 额外放行、不需要方案的工具名。 |
| `gateTools` | `[]` | 强制要求方案的工具名，优先级高于内置只读名单。 |
| `approvalWords` | `[]` | **追加**批准词（标点边界档）。加词不用改代码。 |

> patch 层的 `config` 覆盖整个 config，不是逐字段合并——所以默认值也写全了。

## 三条硬规则

1. **默认关闭执行。** 没有批准方案，`write` / `pwsh` / `subagent` / 联网一律拒绝。
2. **方案必须列清楚工具。** 清单外的工具、文件、命令、联网、子代理都要单独点头。
3. **「同意 + 新要求」不是批准，是修订。** 模型必须把要求并进方案、重新提交。

## 你的回复怎么被判读

不看语序，只看：**有没有批准表达**、**除了它还剩什么**。

| 你发的 | 判定 |
|---|---|
| 同意 / 好的 / ok / go ahead | 批准 |
| 先这样，我同意 | 批准（倒装也认） |
| 收到 / 好嘞 / 得嘞 / 要得 | 批准（应答词与方言） |
| 你执行吧 / 动吧 / 开工吧 / 整吧 | 批准（口语祈使） |
| 继续 / 继续吧 / 接着 | 批准（续接即放行） |
| 我赞同这个方案 | 批准（正式同义词） |
| 同意，但还要加个日志 | 修订 |
| 日志要加，我同意 | 修订（倒装也能带要求） |
| 可以吗？ / 收到了吗？ | 新指令（提问） |
| 不同意 / 先别动 / 不太行 | 新指令（否定） |
| 行距调大一点 / 调整 / 集中 | 新指令（收尾字不是边界） |
| 按你说的做了 / 听你的了 | 新指令（过去式） |

判定顺序：排除提问 → 排除否定 → 续接词直接算批准 → 扫批准表达 → 删掉并去语气词 → 剩空即批准。

## 它不保证什么

- **不判断方案好坏。** 只保证「没批准不动手」。
- **判定是启发式的，偏向「宁可漏，不可误放」。** 单字动词只在带语气词时算（「动吧」算，「调整」不算）；中/得/妥/冲这类收尾字不收。漏判的代价是多提一轮，误放行的代价是执行了没被批准的活。
- **复合续接（如「接着做」）不认。** 续接词是整词匹配，后面跟别的字就不算，会被当成新指令。
- **子代理继承父清单。** 宿主不暴露父子关系时子代理会被拦，可设 `exemptDelegated: true`。
- **注册失败会自我禁用**（否则会话会被永久锁死），并写 WARN。

---

# 第二部分 · 给 AI 维护者

## 0. 一句话复现

一个 cordis 插件，三个接触点：`session/event` 驱动状态机、`tools/pre-execute` 做拦截、`propose_plan` 接收方案。零运行时依赖、无构建、纯 ESM。

## 1. 为什么不用内置 plan mode

`dsh-plan-mode` 的源码注释写明：进入/退出**只改变提示词段落，不改变请求的工具目录**——模型在 plan mode 里照样能写文件。它只建议，不拦截。

被否掉的备选：

| 方案 | 理由 |
|---|---|
| UI 按钮审批（`userQuestions`） | 模型可自己调用 → 开关交给模型 |
| LLM 判定「算不算批准」 | 不确定、不可复现 |
| 前缀/后缀路径匹配 | 被 `../a.txt`、`C:/other/a.txt` 绕过 |
| 依赖 `dsh-tools` 的 `defineTool` | peer 版本耦合，升级即坏 |
| fail-open | 与「永远不能执行」冲突 |

## 2. 文件

```
lib/index.js          事件、闸门、propose_plan
lib/rules.js          纯规则：只读名单、判定器、路径/命令匹配
lib/session-state.js  会话状态机（内存）
lib/messages.js       中英双语文案
```

运行时契约：

```js
export const name = 'plan-gate'
export const inject = ['tools']
export function apply(ctx, config) {}
```

- `ctx.on('session/event', …)` 只处理 `user/message` 且 `source.kind === 'user'`。
- `pre-execute` 返回 `{kind:'deny', reason}` 即拒绝；放行必须 `return next()`。
- `tools.register()` 接受普通对象；`parameters` 走宿主 JSON Schema 子集（`additionalProperties` 只能是布尔）。

## 3. 状态机

```
{ mode: 'thinking' | 'approved', scope, draft, pending, amendment, locale }
```

| 触发 | 条件 | 效果 |
|---|---|---|
| `propose_plan` | 方案合法 | `draft = scope`，回 thinking，撤销既有批准 |
| 回复 | approve + pending | 并入 scope，清 pending |
| 回复 | approve + draft | `scope = draft`，approved |
| 回复 | approve 但无可批对象 | 忽略（不重置） |
| 回复 | amend | 回 thinking，清 draft/scope/pending，记 amendment |
| 回复 | 其它 | 全清，回 thinking |
| 工具调用 | 未批准 | 拒绝：draft → 等批准；amendment → 要求修订；否则执行关闭 |
| 工具调用 | 有 pending | 拒绝：先处理上一个确认 |
| 工具调用 | 越界 | 记 pending 并拒绝 |

pending 只允许一条，避免「同意」指向不明。越界不「锁死」而是「等确认」——锁死会让漏写一个文件就整轮作废。

## 4. 判定器

```
1) 提问？    → other
2) 续接词？  → approve（"继续"就是"放行"）
3) 扫批准表达：强词任意位置 / 弱词在边界 / 单字动词在语气词前
4) 没扫到    → other
5) 删掉批准表达（含嵌套弱词）
6) 剥掉语气词
7) 空 → approve；非空 → amend(note)
```

三档的由来：强词语义唯一，放任意位置才支持倒装；弱词在中句是普通汉字（「行距」），必须靠边界；单字动词误伤面最大（「调整」），只认语气词。

否定看前 3 字（不/别/没/未/勿/不用/不要/无需/没有 + 英文 not/no/don't）。过去式特殊处理：`PAST_SENSITIVE` 短语后跟「了」不算；`做` 不进语气词表，让它留在残余里降级为 amend。

## 5. 路径匹配

方案写 `a.txt`，调用可能是 `../a.txt`、`C:/other/a.txt`。后缀匹配会一并放行，清单形同虚设。

规则（不需要 workspace root）：

1. 词法归一化，吃掉 `.` 和 `..`，记录是否越过顶部；
2. 绝对只配绝对，相对只配相对；
3. 越过顶部的 `..` 拒绝；
4. 目录条目按段边界前缀匹配。

命令是**精确匹配**（空白归一化、大小写不敏感），条目以 `*` 结尾才当前缀——否则 `pnpm test` 会连带放行 `pnpm test && rm -rf`。

## 6. 踩坑清单

> 格式：现象 → 根因 → 修法 → 守它的测试。

1. **正则字符类吞汉字**：`[…~—-吧]` 里 `—-吧` 是 U+2014–U+5427 区间，`好像` 命中。修：转义 `\-`。测试：`好像有点问题`。
2. **残余清理吃掉正文标点**：全局替换把 `b.txt` 变成 `b txt`。修：只清首尾。测试：修订 note 含 `b.txt`。
3. **重复「同意」重置批准**：无可批对象时落到重置分支。修：忽略。测试：`a redundant approval keeps execution on`。
4. **路径后缀绕过**：`../a.txt`、`C:/other/a.txt` 被放行。修：§5。测试：两条 escape 用例。
5. **倒装句冲掉 draft**：只认开头。修：任意位置扫描 + 残余。测试：`approval survives inverted word order`。
6. **单字动词误伤**：`调整`/`乱搞`/`集中`。修：语气词边界。测试：lookalike 组。
7. **过去式当批准**（最危险方向）：`按你说的做了`。修：`PAST_SENSITIVE` + 去掉 `做` 填充词。测试：`a past-tense "了" is not an approval`。
8. **emoji 让批准变修订**：`同意👍`。修：边界类加 `\p{Extended_Pictographic}`，首尾清理图形符号。测试：`同意👍`、`收到👌`。
9. **fail-open 与 fail-closed**：闸门异常 → 拒绝；`propose_plan` 注册失败 → 自我禁用（否则没有审批通道，会永久锁死）。
10. **改源码不等于生效**：Host 插件启动时加载并缓存，`link:` 安装后改源码/配置都要重启。
11. **续接词正则漏了语气词**：`继续吧` 不匹配 `[\s。.!！~]*$`。修：尾类加 `PARTICLES`。注意整词匹配的局限：`接着做` 仍然不认。

## 7. 测试矩阵（93 条）

| 套件 | 数量 | 职责 |
|---|---|---|
| `rules.test.mjs` | 16 | 纯规则 |
| `gate.test.mjs` | 18 | 闸门行为 |
| `stress.test.mjs` | 28 | 注入、并发、1MB、原型污染、性能 |
| `amend.test.mjs` | 22 | 三分法、倒装、口语、方言、续接 |
| `stress2.test.mjs` | 9 | 转述、emoji、混排、并行会话 |

```bash
node test/rules.test.mjs && node test/gate.test.mjs && node test/stress.test.mjs && node test/amend.test.mjs && node test/stress2.test.mjs
```

## 8. 加词规程

1. 先写**三个非批准句子**，确认候选词都不命中。
2. 选档：语义唯一 → 强词；日常词 → 标点边界；单字动词 → 语气词边界。
3. 加进 `rules.js` 并在 `amend.test.mjs` 补正反用例。
4. 五套全绿再发布。
5. 个人说法走 `approvalWords`，不要改代码。

## 9. 从零复现

1. `package.json`：`type: module`、`main`、`dsh.bundle.patch`、零依赖。
2. `cordis.patch.yml`：`insert` 一条 `plan-gate`。
3. 先写 `rules.js` + 测试，把判定与路径规则钉死；再写状态机；最后接线。
4. `dsh plugin --profile desktop add link:"<路径>"`，重启。
5. 用一句口语批准一次，验证真实流量。

## 许可

MIT
