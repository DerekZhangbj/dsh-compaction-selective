# dsh-compaction-selective 设计方案

- 日期：2026-10-14
- 目标环境：DSH 0.2.0-rc.2（web profile，`<dsh-home>\profiles\web`）
- 状态：**设计待评审，未写任何代码、未改动任何配置**
- 需求来源：现在所有 agent 只压「早期对话」，但实际需要压的是「最近几轮临时插进来的内容」；且**人类判断重要性比模型可靠**，所以触发必须是人类的显式指令，模型不得自行发起。
- 已定取舍：**只做 A（模型工具）与 D（换压缩后端）的组合；不做 B（改 dsh-compaction-basic 加参数）与 C（不摘要直接省略）。**

---

## 0. 一页结论

| 项 | 决定 |
|---|---|
| 触发 | **只由人类显式指令**触发；模型不得因 token 压力或自身判断发起 |
| 谁定区间 | **插件按确定性规则计算**（turnOutline → 表面区间 → 平衡吸附）；模型只做参数搬运 |
| 执行门禁 | **强制人类确认卡片**（`ctx.userQuestions.askTimed`），超时=不执行 |
| 执行原语 | `ctx.compaction.compactRegion(start, end, agent, signal)` —— 官方契约里的「调用方指定区间」操作 |
| A 的作用 | 工具 + 区间定位 + 审批门禁（Phase 1，**零核心改动、零组合改动**） |
| D 的作用 | 子类化 `BasicCompactionEngine`，**只覆盖 `summarize()`** 定制「局部折叠」摘要模板（Phase 2，可选） |
| 不需要 B 的原因 | 人类说出「压掉上一段」这句话时**已经开了一轮**（`turn/start` 已落盘），`compactRegion` 的 owner 约束天然满足，不需要空闲态入口 |
| 不需要 C 的原因 | 放弃语义信息；A 走的是官方压缩事务，UI 有「上下文已压缩」标记与可展开摘要 |

---

## 1. 目标与非目标

### 1.1 目标
1. 人类可以用一句话（「把上一段压掉」「把 42-45 轮折叠掉」）触发一次**针对指定轮次区间**的压缩。
2. 压缩对象可以是会话的**中段或尾段**，而不是只能是最前面的一段。
3. 模型**没有**自行决定「压什么」的权力；即使它判断失误，也不会造成不可逆后果。
4. 复用官方压缩事务：锁、稳定性校验、摘要收敛校验、checkpoint 标记、客户端呈现全部沿用。
5. 全过程可审计：日志里留下 `compaction/start`→`summary`→替换 →`end` 的完整括号。

### 1.2 非目标
- 不改动 `/compact` 的现有行为（无参数、压最老的一段）。
- 不做自动策略（不因 token 压力自动压近期内容）。
- 不做「不生成摘要的纯删除」。
- 不做 GUI 多选面板（列为 Phase 3 可选）。
- 不改压缩的存储格式、不新增事件类型。

---

## 2. 关键判断：为什么是 A + D，而不是 A 或 D

### 2.1 A 单独就够跑通主链路
人类发出「压掉上一段」这条消息时，宿主已经 append 了 `turn/start`；模型在这一轮内调用工具，`entryState.openTurn !== null`，因此 `ctx.compaction.compactRegion(start, end, agent, signal)` 完全合法。**不需要空闲态入口，也就不需要给 `dsh-compaction-basic` 加 `compactRange()`**（这正是 B 方案唯一的必要性来源）。

证据：
- `dsh-compaction/lib/types/index.d.ts:138-157` —— `compactRegion` 是三个抽象操作之一，文档原文：*"Forcibly compact a range of surface nodes into a single summary node… `start` and `end` name an inclusive span by surface position, not numeric seq order"*。
- `dsh-compaction-basic/lib/index.js:971` —— `compactRegion` 传 `owner: "current-turn"`；`compactSurfaceRegion`（:456-462）在有 open turn 时取 `entryState.openTurn`，无则抛 `compactRegion: no open turn`。
- `dsh-session/lib/types/surface.js:441-443` —— `state.nodes.splice(startIdx, span, newSeq)`，**任意连续区间**都可替换，格式层不限制前缀。

### 2.2 D 的唯一不可替代价值是「摘要长什么样」
`BasicCompactionEngine` 的内置摘要指令是一份**硬编码的英文 8 段工作前史模板**（`dsh-compaction-basic/lib/index.js:243-278`：Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context，并要求 *"Write concise English engineering prose"*）。

用这套模板去压「一段临时插话」是错配的：它会试图把插话总结成「原始诉求 + 技术概念 + 错误与修复 + 下一步」，产出冗长且偏离。

而 `summarize(input, agent, signal)` 是官方 README 明说的**唯一子类定制钩子**（*"`summarize()` is the sole subclass customization hook"*）。所以：

> **D 不是「另一个实现路径」，而是 A 的摘要质量开关。** 只要 Phase 1 试出来的摘要不能用，就上 Phase 2，用子类把摘要指令换成「局部折叠」模板。

### 2.3 D 单独用不成立，理由是「可达性」（2026-10-14 更正）

> **本节更正首版的理由。** 首版写的是「D 单独用会把 B 变回必需」，理由是「空闲态压指定区间绕不开基类（`compactNow` 不接区间、`compactSurfaceRegion` 未导出）」。**这个理由不成立**：本方案的触发方式是「人类在对话里说一句话」，那条消息本身就打开了新一轮，因此永远走 turn 内路径，**根本不存在空闲态，也就不需要 B 的补丁**。
>
> D 单独用不成立的真实理由是**可达性**，与空闲态无关。

`CompactionEngine` 是 Cordis 服务，**只有代码能调用**；而**模型只能通过 `ctx.tools.register()` 注册的工具来行动**，人类只能通过命令或消息来行动。一个「只覆盖了 `summarize()` 的子类」对外暴露的新能力是**零**：

| 单独运行 D 之后，谁能发起一次「折叠 turn 42-45」 | 结果 |
|---|---|
| 模型 | 没有任何工具可调 —— 无法表达这个请求 |
| 人类 | 只有 `/compact`，选区由 `selectCompactableRange()` 硬编码为「最老的一段」 |
| 子类自己 | 它没有触发源（没注册工具、没注册命令），`summarize()` 永远不会被调用 |

即：**单跑 D = 一个新的摘要模板 + 和今天完全一样的压缩行为（只会压最老的一段）**。人类那句「压掉上一段」，在单跑 D 的世界里无处落地 —— 不是「要手动选轮次」，而是「根本选不了」。

**结论：Phase 1 用 A（工具 + 区间定位 + 审批门禁）；Phase 2 只在摘要质量不达标时加 D。入口、区间、门禁三件事全在 A；D 只决定「压出来那段文字写得好不好」。两者可以在同一个插件包里交付，但能力上不可互相替代。**

---

## 3. 触发链路（时序）

```
人类: 「把上一段压掉」/「把 42-45 轮折叠掉」
  │
  ├─(1) 宿主 append user/message → turn/start   ← 这一轮由此打开
  │
  ├─(2) 模型读到工具描述里的硬约束：
  │       "只在人类本轮明确要求折叠某段历史时调用；不得因上下文压力自行调用"
  │       ↓
  ├─(3) 模型调用 compact_turns({ turns: [42,45] } 或 { recent_turns: 3 } 或 { up_to_turn: 45 })
  │
  ├─(4) 插件（宿主侧，确定性）：
  │       a. 校验调用者（exec.agent 必须是 live root，且本轮有打开）
  │       b. turnOutline → turn/start seq → 表面位置 → 区间
  │       c. 平衡吸附（toolPairingBalancedBefore/After）
  │       d. 硬护栏检查（见 §5）；命中则直接拒绝，不打扰人类
  │       e. 组装预览 + token 估算
  │
  ├─(5) 人类确认卡片（ctx.userQuestions.askTimed，默认 180s）
  │       确认折叠 / 取消 / 只看预览
  │       ↓ 只有「确认折叠」继续
  ├─(6) ctx.compaction.compactRegion(start, end, agent, signal)
  │       → 摘要调用 → 写 checkpoint → 原地替换 → 释放锁
  │
  └─(7) 工具返回结构化结果，模型据此用一句人话汇报
```

关键点：**(4)(5)(6) 全在插件里，模型在链路中只做「把人类的意图翻译成参数」这一件事**，而且参数错了会在 (4) 被确定性规则纠正或拒绝。

---

## 4. 区间定位算法

### 4.1 输入形态（三选一，互斥）
| 形态 | 例子 | 语义 |
|---|---|---|
| `turns: [from, to]` | `[42, 45]` | 折叠第 42..45 轮（含两端） |
| `recent_turns: N` | `3` | 折叠「当前轮之前的最近 N 轮」，**包含刚结束的那一轮**（`N=1` 即压掉上一轮） |
| `up_to_turn: T` | `45` | 折叠第 1..T 轮，用于「前面那一大段都压掉」 |

### 4.2 计算步骤
1. 取 `ctx.sessionProjections.stateOf(session, "turnOutline")` → `{ turns: [{ turn, seq, prompt, response }] }`（已装：web profile 的 `session-turn-outline`，id = `session-turn-outline`）。
2. 把轮号区间映射为 `[startSeq, endSeq]`（`SEQ = turnOutline.turns[i].seq`）：
   - start：目标首轮的 `turn/start` seq。
   - end：目标末轮结束前**最后一个表面节点** —— 从 `session.surface.nodes` 中取「下一个 turn 的 turn/start 之前的最后一个节点」；若目标涵盖最后一轮，取当前表面末尾。
   - **允许折叠刚结束的那一轮**（2026-10-14 人类决定）；**只排除当前正在进行的轮次**（尚未 `turn/end`，节点还在增长，且选区必然无法平衡），见 §5 护栏 2。
3. 平衡吸附：
   - `toolPairingBalancedBefore(session, startSeq)` 为假 → `startIdx += 1` 重试，直到为真或超出区间。
   - `toolPairingBalancedAfter(session, endSeq)` 为假 → `endIdx -= 1` 重试。
   - 吸附后区间为空 → 拒绝（`unbalanced`）。
4. 估价：用 `ctx.tokenMeter.measure(session).nodes` 取选区内节点的 `tokens` 求和，作为「预计释放」的路由 token 数；`heuristicTokens` 求和作为兜底。

**整轮选择天然平衡**（一轮的结束切点必然 `inProgressToolCalls === 0`），所以按轮选基本不会走到吸附。

---

## 5. 硬护栏（全部在审批之前生效，任一命中即拒绝并要求人类给出更明确的指令）

| # | 护栏 | 拒绝理由码 |
|---|---|---|
| 1 | 选区不得包含表面节点 0（系统提示） | `SYSTEM_HEAD` |
| 2 | 选区不得包含任何处于**当前正在进行**轮次内的节点（刚结束的上一轮允许） | `OPEN_TURN` |
| 3 | 选区路由 token 估算 < `minShadowedTokens`（默认 3000） | `TOO_SMALL` |
| 4 | 选区 > 表面总 token 的 `maxSurfaceShare`（默认 0.6） | `TOO_LARGE` |
| 5 | 会话已有未配对的 `compaction/start`（锁） | `BUSY` |
| 6 | 调用者不是 live root agent（子智能体不得压父会话） | `NOT_ROOT` |
| 7 | 区间的 `turn` 列表为空 / 不连续 / 起止倒置 | `BAD_RANGE` |
| 8 | 同一轮内折叠次数超过 `maxPerTurn`（默认 1） | `RATE_LIMIT` |

护栏 3 的存在理由：官方在 `summarizeCompaction`（`dsh-compaction-basic/lib/index.js:601`）里有一条硬校验 —— `framedSummaryTokenCount >= shadowedRouteTokenCount` 就直接抛 *"summary is not smaller than the shadowed content"*。折叠太小的一段必然失败，与其让它失败，不如在审批前拒绝并告诉人类「这段太小，压缩不划算」。

**2026-10-14 定值**：`minShadowedTokens = 3000`、`maxSurfaceShare = 0.6`、审批超时 `180_000` ms，三者均可配。因为已允许折叠「刚结束的那一轮」（往往只有一两轮、token 很少），护栏 3 的下限保护比原先更关键：它会把「压掉上一轮」这类小请求在弹卡之前就挡回去，并给出「这段太小，压缩不划算」的明确理由。

---

## 6. 审批卡片（硬门禁）

调用 `ctx.userQuestions.askTimed({ questions: [...], agent, wait: { callId: exec.callId } }, exec.callId, timeoutMs)`。

- 默认 `timeoutMs = 180_000`（可配）。
- 超时 → 返回 `{ pending: true }` → **不执行折叠**，工具返回 `status: "timeout"`，提示「未获确认，未做任何改动；你可以稍后重新要求」。
- 取消/关闭 → 工具返回 `status: "declined"`。
- 之所以用带超时的前台等待而不是无限等待：避免一个没人答的卡片永久挂住这一轮。

### 卡片内容（`question` + `detail`）

```
question: 折叠 turn 42-45？共 4 轮 / 23 条表面节点
detail:
  预览
    · turn 42  你: 「顺手问一下 ffmpeg 的 -ss 参数…」→ 我: 「…」
    · turn 43  你: 「那顺便看看 sharp 的…」→ 我: 「…」
    · turn 44 …（每轮 prompt 截 50 字、response 截 120 字，来自 turnOutline）
    · turn 45 …
  预计
    · 释放 ~8.2k 路由 token；摘要约 0.6k token 回填
  须知
    · 表面层不可逆：这些轮次之后不会再进入我的上下文
    · 原文仍在会话日志中，可回放、可在「上下文已压缩」处展开摘要
    · 摘要不会保留逐轮细节；若要保留某条，请先说明
options:
  - 确认折叠
  - 取消
  - 只看预览（不执行）
```

---

## 7. 工具契约（草案）

```js
// 文件：<plugin-dir>\lib\index.js
const name = "compaction-selective";
const inject = ["tools", "compaction", "tokenMeter", "sessionProjections", "sessions", "userQuestions", "agents"];

ctx.tools.register(defineTool({
  name: "compact_turns",
  description:
    "Fold an explicitly requested span of this session's earlier turns into one summary message, " +
    "freeing context while keeping the rest of the conversation intact. " +
    "Call this ONLY when the human explicitly asks in this turn to fold/drop a span of earlier turns " +
    "(for example \"把上一段压掉\"). Never call it on your own initiative, and never because of context pressure, " +
    "token budget, or your own judgement that content is unimportant. " +
    "The human must confirm the operation through a prompt before anything changes.",
  parameters: {
    turns:        { type: "array", description: "Two turn numbers [from, to], inclusive." },
    recent_turns: { type: "number", description: "Fold the last N turns before the current one." },
    up_to_turn:   { type: "number", description: "Fold turns 1..T." },
    note:         { type: "string", description: "Optional: what the human wants preserved from that span." }
  },
  output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
  async execute(args, exec) { /* §3 的 (4)(5)(6)(7) */ },
  presentCall: (args) => ({ card: "generic", title: "Fold turns", kind: "other", rawInput: ... })
}));
```

### 返回结构
```json
{
  "status": "compacted | declined | timeout | rejected | failed",
  "reason": "TOO_SMALL | OPEN_TURN | ... | null",
  "turns": [42, 45],
  "seqs": { "start": 812, "end": 903 },
  "shadowedNodes": 23,
  "shadowedTokens": 8200,
  "summarySeq": 1204,
  "message": "已折叠 turn 42-45（约释放 8.2k token）。原文仍在会话日志中。"
}
```

失败时 `status: "failed"`，`message` 用人话解释，并明确「未做任何改动」或「已发生部分改动，请检查当前会话」。

---

## 8. 失败分支表

| 现象 | 抛出/来源 | 插件处理 |
|---|---|---|
| 摘要不比原文小 | `Error: summary is not smaller than the shadowed content` | 护栏 3 提前拦截；真发生时返回 `failed`，说明「这段太小」 |
| 压缩期间表面被改写 | `SurfaceChangedError` → `ManualCompactionError("changed")` | 自动重试 1 次；仍失败则 `failed`（原文未变） |
| 已有压缩在跑 / 未配对锁 | `ManualCompactionError("busy")` 或 `compactRegion: no open turn` | 返回 `failed`，提示稍后重试 |
| 摘要调用失败 | `LlmError` / `compaction/summary-error` 瀑布 | 已装 `dsh-compaction-image-offload` 之类的 recovery 会接管；否则 `failed`，日志留 `compaction/end` 带 errorChain |
| 提交阶段异常 | `ManualCompactionError("commit")` | 返回 `failed` 并**明确要求人工检查会话**（这是唯一可能留下部分改动的情况） |
| 调用者非 live root | `UserQuestionError CALLER_NOT_LIVE / DELEGATED_CALLER` | 在护栏 6 提前拒绝 |
| 人类未答 | `askTimed` 返回 `{ pending: true }` | `timeout`，零改动 |

---

## 9. 不变量与验收

### 9.1 不变量（每次成功折叠后必须成立）
1. 日志新增且仅新增一组 `compaction/start` → `compaction/summary` → `user/message(replace)` → `compaction/end`。
2. 替换消息的 `sourceEventSeqs` 覆盖全部被遮蔽的表面节点。
3. `surface.replaceGeneration` 恰好 +1；表面长度减少 `shadowedNodes - 1`。
4. checkpoint 的 `source.kind === "compact-checkpoint"`，`compactionId` 与括号一致。
5. 未被选中的表面节点及其相对顺序不变。
6. 重放同一份会话日志得到同一份表面（确定性）。

### 9.2 验收清单（Phase 1 完成时必须逐条跑过）
- [ ] 折叠尾部（最近 N 轮）→ 成功，UI 出现「上下文已压缩」标记，可展开摘要
- [ ] 折叠中段（前后都保留）→ 成功，正文 + 折叠点 + 正文，顺序正确
- [ ] 人类说「压掉上一段」但模型给出错误区间 → 审批卡显示的区间与人类预期一致（由插件算，不由模型算）
- [ ] 人类点「取消」→ 日志零新增事件
- [ ] 人类不答 180s → `status: "timeout"`，日志零新增事件
- [ ] 选区 < 3000 token → `rejected / TOO_SMALL`，无审批卡片弹出
- [ ] 区间跨越当前打开轮 → `rejected / OPEN_TURN`
- [ ] 压缩进行中人类插话（steering）→ `changed` 后重试成功，或干净失败且原文未变
- [ ] 折叠后进行 3 轮普通对话 → 无异常、无 `deriveMessages` 报错
- [ ] 重启 DSH 并重新载入该会话 → 表面与折叠后一致（确定性回放）
- [ ] 子智能体尝试调用 → `NOT_ROOT` 拒绝

---

## 10. 阶段划分

### Phase 1 —— 工具 + 审批 + 区间定位（A）
- 交付：`<plugin-dir>\`（`package.json` / `lib/index.js` / `tests/`）
- 组合：profile patch 里 `- insert:` 一行（**不 disable 任何现有行**，与压缩后端共存）
- 预计规模：约 250–350 行 + 测试
- 风险等级：低（不动现有行为，纯增量；最坏情况是工具不可用）
- 验收：§9.2

### Phase 2 —— 定制摘要模板（D，仅当 Phase 1 摘要质量不达标）
- 交付：同一插件里增加 `class SelectiveCompactionEngine extends BasicCompactionEngine`，只覆盖 `async summarize(input, agent, signal)`
- 组合改动：
  ```yaml
  - id: compaction-basic
    disabled: true
  - insert:
      - id: compaction-selective
        name: 'dsh-compaction-selective'
        config: { ... }
  ```
- 摘要模板（「局部折叠」而非「工作前史」）：
  ```
  这段历史被人类主动要求折叠。它不是项目的起点，而是一段已经被处理掉的支线。
  只输出以下四节，总长不超过 200 字：
  ## 这段在做什么
  ## 结论 / 产出物（保留确切的文件名、命令、参数、结果数字）
  ## 被搁置的支线（本可以继续但没继续的方向）
  ## 可安全丢弃的细节
  语言：**跟随被折叠原文的主体语言**（中文对话一律用中文，禁止输出英文工程散文）。不要复述工具输出，不要写"下一步"。
  ```
- 已知影响（2026-10-14 人类接受）：换成子类后 `/compact` 与自动压力压缩也会继承这套模板，即出厂那套英文 8 段模板在所有压缩路径上都被替换掉。
- 另有一条支持这个改动的证据：折叠**中段/尾段**时，摘要调用只把**选区本身**发给模型（`buildSummarizationInput` 只取被遮蔽的 seqs，见附录 B），模型根本看不到「Primary Request and Intent」所指的主线内容 —— 出厂模板在这种情况下必然跑偏。
- 预计规模：约 80–150 行 + 组合改动 + 升级后 smoke test
- 风险等级：中（替换压缩服务 = 影响所有压缩路径；升级后基类内部变化可能破坏继承）
- 回滚：删掉 `disabled: true` 两行即可回到出厂后端

### Phase 3 —— GUI 选段面板（可选，暂不做）
- 数据源：`turnOutline`（每轮 turn / seq / prompt / response 预览）
- 形态：客户端插件渲染多选列表 → 回传区间 → 复用 Phase 1 的执行路径
- 不做，直到 Phase 1/2 的实际使用证明需要

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 模型滥用工具自行折叠 | ① 工具描述硬约束；② 人类确认卡是**硬门禁**，模型无法跳过；③ `maxPerTurn` 速率限制；④ 计划模式下禁用；⑤ 全部折叠都留审计括号 |
| 折叠误伤重要内容 | ① 只能整轮/连续区间；② 上限 60% 表面；③ 审批卡片带每轮预览，人类按预览否决；④ 原文永久保留在日志 |
| 摘要质量差、丢失关键信息 | Phase 2 的「局部折叠」模板 + 强制保留可回溯锚点；失败即回滚到出厂后端 |
| 表面层不可逆导致后悔 | 审批卡明确写明；且 checkpoint 在 UI 可展开查看摘要内容 |
| Phase 2 影响自动压缩 | 子类完整继承 `compactIfNeeded` / `compactNow` / `compactRegion`，只改 `summarize`；升级后跑一遍 §9.2 + 一次自动触发压测 |
| 与已有 `dsh-compaction-*` 插件冲突 | 不动 `tool-result-pruner` / `image-offload`；`image-offload` 监听的是 `compaction/summary-error`，与子类覆盖 `summarize` 不冲突 |

---

## 12. 决策记录（2026-10-14 人类已拍板）

| # | 问题 | 决定 |
|---|---|---|
| 1 | 折叠粒度 | **只允许整轮**（不切同一轮内的一段） |
| 2 | `minShadowedTokens` | **3000**（可配） |
| 3 | 单次上限比例 | 表面的 **60%**（可配） |
| 4 | 审批卡片超时 | **180_000 ms**（可配） |
| 5 | 摘要语言 | **跟随原文** |
| 6 | Phase 2 后 `/compact` 继承新摘要模板 | **接受** |
| 7 | 折叠「刚结束的那一轮」 | **允许**（仍排除正在进行的那一轮） |

只剩两件不阻塞开工的小事：

8. 插件包名与目录 `dsh-compaction-selective` / `<plugin-dir>\` 沿用（默认按此执行）。
9. Phase 1 是否保留 `note` 参数（人类可顺带说明「这段里某条要保留」）—— 默认保留，透传进审批卡与摘要指令；若不想影响摘要文本，则只在审批卡上显示。

---

## 附录 A：证据索引

| 结论 | 文件 | 位置 |
|---|---|---|
| `compactRegion` 是官方契约的「显式区间」操作 | `…\dsh\node_modules\@deepseek-ai\dsh-compaction\lib\types\index.d.ts` | 138–157 |
| `/compact` 无参数、显式区间走 `compactRegion()` | `…\dsh-compaction\README.md` | 78、174 |
| `summarize()` 是唯一子类 hook | `…\dsh-compaction-basic\lib\index.js` | 796–903 |
| 内置摘要模板是英文 8 段工作前史 | 同上 | 243–278 |
| 只压早期是选择策略 | 同上 `selectCompactableRange` | 410–433 |
| 空闲态入口 `compactNow` 不接区间、且要求 idle | 同上 | 985–1011 |
| `compactRegion` 要求 open turn、whole-surface 稳定性 | 同上 | 971–976 |
| 表面替换是 `splice(startIdx, span, seq)` | `…\dsh-session\lib\types\surface.js` | 441–443 |
| 系统提示节点 0 受保护 | 同上 `assertSystemHeadRewrite` | 388–397 |
| 摘要必须比原文小 | `…\dsh-compaction-basic\lib\index.js` | 601 |
| 工具注册 + `exec.agent` / `exec.callId` | `…\dsh-tools\lib\types\index.d.ts` | 228–229、636 |
| 阻塞式人类确认原语 | `…\dsh-user-questions\lib\types\index.d.ts` | 79–98 |
| 轮次大纲投影（turn / seq / prompt / response） | `…\dsh-session-turn-outline\lib\types\types.d.ts` | 12–43 |
| 组合行 id 与 disable 语法 | `…\dsh-base\cordis.patch.yml` | 341–347、445–452 |

---

## 附录 B：KV cache 代价详解（2026-10-14 补充）

### B.1 什么叫「前缀缓存」
provider 侧缓存的粒度是**前缀**：只有「从请求的第一个 token 开始连续相同」的那一段才会命中，一旦某个位置的 token 不一样，从那里往后全部按未缓存重新预填充（prefill）。命中缓存与未命中的输入单价，量级上通常差 10 倍。

### B.2 压缩走的是哪一次调用
压缩不是「改写历史」，而是**额外再发一次 LLM 请求**去生成摘要。这次请求的内容由 `buildSummarizationInput` 决定：

```
[会话 system 提示] + [被选中区间内的消息，按表面顺序] + [一条 user 消息：压缩指令]
```

（`dsh-compaction-basic/lib/index.js:695-704` 组装前两段；`:292-338` 把 `COMPACTION_INSTRUCTION` 作为最后一条 user 消息追加 —— 这个设计的用意就是让这次辅助调用尽量成为「上一次真实请求的前缀」。）

### B.3 两种选区的缓存账不一样

| 选区 | 摘要调用的前部 | 与「上一次真实请求」的公共前缀 | 结果 |
|---|---|---|---|
| 压最老的一段（出厂行为） | system + 第 1..K 条 | system + 第 1..K 条 | **整段选区命中缓存** |
| 压中段 / 尾段（本方案） | system + 第 42..45 轮的消息 | 只有 system + 工具定义 | 选区那几千 token **按未缓存价重算** |

原因很直接：压最老的一段时，摘要调用的开头与上一次真实请求的开头一字不差；压「从第 42 轮开始」的一段时，上一次真实请求在那个位置放的是第 1 轮的内容，**从选区第一个 token 起就分叉了**。

### B.4 所以额外成本有多大
就是**选区那几千 token 的一次性未缓存 prefill**（示例约 8.2k token）。它不是每轮都付，每次折叠只付一次；按未缓存输入价算通常在一分钱以内。而且这些内容本来就要被读一遍才能总结，区别只是「读缓存」还是「读原文」。

### B.5 反向的好处（比成本更值得注意）
- **压尾段**：新表面 = `[主线程 1..41] + [checkpoint]`。主线程那一段的前缀**依然有效**，后续请求仍能命中缓存。
- **压最老段**：新表面 = `[checkpoint] + [尾部]`。第一条消息就变了，**后续请求整段缓存失效**，要全额重算。

也就是说，压尾段是「摘要那一次多花一点、之后每一次反而更省」，压最老段正好相反。首版把这件事写成单向的额外成本，**不完整，此处更正：两个方向的缓存账是对称的，压近期并不吃亏。**

### B.6 一条与缓存无关但更重要的发现
压中段 / 尾段时，摘要模型**只看得到选区本身**，看不到主线程（`buildSummarizationInput` 只取被遮蔽的 seqs）。出厂那套 `Primary Request and Intent` / `Next Step` 模板在这种情况下**必然跑偏** —— 这是 Phase 2 换模板的硬理由，与缓存无关。

---

## 附录 C：实现记录（2026-10-14，Phase 1 + Phase 2 已落盘）

状态：**代码与安装均已完成；离线 56 项测试全绿；待一次宿主重启后实跑验收**（清单见 `~/.dsh/the maintainer knowledge base` §0.9）。

### C.1 与原设计的差异（都是实现阶段才看清的，逐条记明）

| # | 原设计 | 实际实现 | 原因 |
|---|---|---|---|
| 1 | D 用「子类化 `BasicCompactionEngine` + disable `compaction-basic`」 | **在已加载的实例上覆盖 `summarize()`** | `regionDependencies()` 走 `this.summarize` 的**实例属性查找**，自有属性即可生效；于是不必 disable 后端、不必 import `@deepseek-ai/dsh-compaction`（本机 profile 里没有这个包，它是 peer）、也不存在第二份 cordis / Service 身份问题。风险与改动面都显著更小 |
| 2 | 摘要语言跟随原文 | 同上，但**只覆盖正文** | checkpoint 外层那句英文框架语（`frameSummary` 的 preamble）与 `<compacted-summary>` 标签由后端私有函数生成，覆盖不到；正文（`<compacted-summary>` 内部）完全由本插件控制 |
| 3 | 摘要调用按路由取 `maxTokens` | 用服务级 `config.maxTokens` | 出厂实现里的 `resolveTargetPolicy()` 是模块私有，拿不到；只有显式配了 `modelPolicies[].maxTokens` 时才有区别 |
| 4 | 用 turn 号定位选区 | 一律**在表面下标空间**工作 | 压缩替换会让可见 seq 非单调，官方文档也明说 `start`/`end` 是「表面位置而非 seq 大小」；`attributeTurns()` 用日志顺序 + 事件自带的 `turn` 字段还原归属 |
| 5 | 审批超时 180 s | `askTimed(180s)`；客户端按业务等待通道的 deadline 渲染倒计时，并给一个「慢慢回答」把等待变成不计时 | 实测客户端源码：`#timedWait = channel.deadline !== undefined`，与是哪个工具发起的无关 |
| 6 | （原设计没提「服务在哪」） | 首次重启实测：插件整条 **pending (waiting for service: compaction)**，工具未注册 | **`compaction` 是每个 agent preset 一份的隔离服务**：web-app 把 `compaction-basic` / `command-compact` 在根上 `disabled: true`，改到每个 preset 内的 `- id: compaction / name: cordis:group / isolate: {compaction: true}` 里挂载 → **根作用域没有它**。修正：工具在根注册，执行时另找那份实例。**教训：`inject` 一个服务前，先 `--dump-config` 确认它在根作用域是 enabled 的。** |
| 7 | （修正 6 的取法） | 第二次重启实测：工具能跑，但报 `NO_SERVICE`、候选 0 个 | 原设计想用「纤维祖先链」认领实例 —— 上游文档明确 **`the mount is not under the agent's fiber`**，此路不通；且 `ctx.on` 默认受作用域过滤，根上的监听器收不到 preset 域事件。改为四条路径：`agent.ctx` 直达 → **上游正式入口 `serviceForAgent(ctx, agent, 'compaction')`** → 唯一候选 → 干净失败（诊断写进工具返回值）。候选捕获改用 `ctx.on(..., { global: true })`，模板钩子挂 `agent/pre-step`（`{global:true, prepend:true}`）。另修两个致命顺序问题：**捕获钩子必须注册在任何早退之前**（否则 dsh-llm 加载失败会导致「工具在、候选永远 0」）；**`ctx.logger` 不进宿主日志文件**，诊断改双通道（`console.error`）。 |

### C.2 交付物

| 文件 | 说明 |
|---|---|
| `lib/index.js` | 配置、`compact_turns` 注册、审批、执行、装配 |
| `lib/range.js` | 零 import 的纯逻辑（区间定位、平衡吸附、护栏、估价、预览） |
| `lib/summarizer.js` | 「局部折叠」指令 + 实例级覆盖/还原 |
| `tests/run.mjs` | 56 项离线断言（含真实 `defineTool` 编译、`apply` 装配、审批五分支、覆盖幂等/还原） |
| `README.md` | 用法、配置、安装形态、依赖解析、回滚、已知边界 |
| `package.json` | `peerDependencies` = 依赖解析的第二层保险 |

```powershell
node <plugin-dir>\tests\run.mjs   # 56/56
```

### C.3 安装落点

- `~/.dsh/profiles/web/node_modules/dsh-compaction-selective` → 目录联接（junction）到源码目录
- `~/.dsh/profiles/web/package.json`：`"dsh-compaction-selective": "link:<plugin-dir>"`
- `~/.dsh/profiles/web/cordis.patch.yml`：末尾 `insert:` 一行（id `compaction-selective`），**不动 `compaction-basic`**
- 备份：`dsh-plugins\cordis.patch.yml.bak-selective-20261014-162245`、`package.json.bak-selective-20261014-162245`
- 回滚：删那个 `insert:` 块 → 重启；彻底移除再 `rmdir` 那条 junction
