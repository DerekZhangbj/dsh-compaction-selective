# 兼容性审计：0.2.0-rc.2 → dsh-v0.2.1-rc.2（含 v0.2.1 线内部增量）

> 审计方式：**源码级**比对（本地 0.2.0-rc.2 读安装产物；上游从公开仓库读源码）。全程只读，未安装、未改动。
> 审计日期：2026-10-16（第一轮 alpha.4）、2026-10-19（第二轮 rc.2 增量）。
> 标签与 commit：`dsh-v0.2.1-rc.2` = `687f282`、`rc.1`、`alpha.5` = `1517a4d`、`alpha.4` = `86a4022`
> （`.3` = 2fbf435、`.2` = d743267、`.1` = 5badb15）；本地对照版本 `dsh-v0.2.0-rc.2` = `639ed0153`。
> 上游**没有 CHANGELOG.md**，但有 **GitHub release notes**（rc.2 那份只有新功能、无 breaking，见文末）。

## 结论

| 问题 | 结论 |
|---|---|
| 能否声明兼容 0.2.1-alpha1..4 | **有条件能** —— 我们依赖的接口几乎全部存活，只有 **1 处硬破坏**（见下），且该处只有"诊断降级"后果 |
| 本地补丁还需不需要 | **需要**。上游 alpha.4 的 `CompactionEngine` 仍只有 `compactIfNeeded` / `compactNow` / `compactRegion` 三个抽象方法，**没有**空闲态折指定区间的公开入口；`/compact` 仍是无参数 |
| 建议的依赖声明 | 用上游**新增的专用闸门字段** `"engines": { "dsh": ">=0.2.0-rc.2 <0.3.0" }`；它存在时**单独生效并忽略 peers**。peers 同步收紧，不再用 `"*"` |
| 必须改的代码 | ① `serviceForAgent(ctx, agent, 'compaction')` → `ctx.agentPresets?.serviceFor(agent, 'compaction')`（后者在本机 rc.2 与**整条 0.2.1 线**都有）② 删掉 `popupSelect` 里被忽略的 `title` 字段 ③ 补 `engines.dsh` 声明 —— **三项已于 2026-10-19 落地**（主套件 124 项 + 3 个 harness 全绿） |

## 逐条对照

| 接口 | rc.2（本地） | alpha.4（上游） | 判断 |
|---|---|---|---|
| `compactRegion(start,end,agent,signal?)` | `owner:"current-turn"` / `stability:"whole-surface"` | `override async compactRegion(...)`，同参数同语义 | 一致 |
| `compactNow(agent,signal,sourceCommandId?)` | `owner:null` / `selected-span` / `runMaintenance` + flush | 逐行同语义 | 一致 |
| `selectCompactableRange(...)` | 只选前缀 | 同名同参，仍是内部函数 | 一致 |
| **空闲态 + 指定区间** | 无（靠本地补丁的 `compactRange`） | **仍无**（`compactIfNeeded`/`compactNow`/`compactRegion` 三个抽象） | **补丁仍必需** |
| `conversation.input.left` | `kind:"list"` / `scope:"session"` / `ownerProps:[]` | 契约同 | 一致 |
| `plugins.bundle.config` | `kind:"keyed"` / `scope:"root"` / 必填 `key` | 同（`slot-contract.ts`） | 一致 |
| keyed 分发 + `configured = ledger.bundles.has(pkg.name)` | 按 `entry.options.key` | 重构进 `config-ledger.ts`，**语义不变** | 一致 |
| `CommandContribution` / `commandUi.register` | `label?()` / `icon?` / `ui: popupSelect\|action` | 与本地**逐字相同** | 无变化 |
| bundle 形态（`dsh.bundle.patch` + 包内 `cordis.patch.yml`） | 参与组合 | 仍 `readBundlePatches('dsh', profile)` → `composeEntries` | 仍成立（字面键名半确认） |
| 客户端半边发现（`dsh.client` + `exports['./client']`） | `platform`/`immediately` | `parseDshClient` 仍校验 `platform`；`<id>/client` 子路径仍被识别 | 仍成立 |
| `ctx.tools.register` / `defineTool`（含强制 `output`） | 已提供 `output` | 仍强制 `output` | 一致 |
| `ctx.webServer.register({kind:'prefix'})` | 支持 | 仍支持（另新增 upgrade/fallback 面） | 一致 |
| `ctx.agents.roots()/get(id)` | 有 | 有 | 一致 |
| `sessionProjections.stateOf(session,'turnOutline')` | 有 | 有（上游自用同一 API） | 一致 |
| `tokenMeter.measure(session)` | 有 | 有 | 一致 |
| `internal/service` 事件 | 发射 | 仍在（vendor/cordis） | 一致 |
| `agent/pre-step` / `ctx.effect` | 在用 | 上游同样在用 | 一致 |
| **`serviceForAgent(ctx, agent, name)`** | 包根导出 | **不再从包根导出**；能力改为实例方法 `serviceFor(agent,name)`（rc.2 已有），根帮助函数改名 `serviceForMount` 且未 re-export | **破坏**（能力未丢，改用实例方法即可） |
| 计时器限制（`DYNAMIC_CLIENT_REDIRECTS`） | 只作用于动态求值包 | 仍只作用于动态求值；预构建 bundle 走 `factory(require)` | 一致 |
| **`engines.dsh` 兼容闸门** | 无 | **新增**：`engines.dsh` 存在则单独判定（忽略 peers）；不满足会**拦截安装**，可用 `dsh plugin allow-version` 精确豁免 | **新增，直接关系本插件安装** |

附：新增槽位 `plugins.add.actions`、`plugins.tab`（纯附加，不影响我们）。

## 未确认（发布前若要写进 README，需先补）

1. **alpha.1 / .2 / .3 未逐版本核对** —— 只实测 alpha.4。上面那处"移除导出型"破坏理论上可能出现在更早的 alpha。
   补法：对 4 个 tag 各取 `packages/preset/agent-preset-registry/src/index.ts`，看导出列表即可。
2. `dsh.bundle.patch` 的**字面键名**未打开实现确认（已知 bundle patch 仍参与组合）。
3. `slots.register` 的 entry-level `inject` 未读到正式声明（用上游真实注册调用反证仍被支持）。
4. `{ global: true }` 监听器选项语义未在 vendor 源码核对（事件本体已确认存在）。
5. alpha.4 的 app 组合是否仍装载 `dsh-compaction-basic`、preset 内 `isolate:{compaction:true}` 的挂法未核对。
6. 上游该 tag 无 CHANGELOG / 无 releases，因此**没有官方兼容性声明可引用** —— 版本矩阵只能基于本审计。

## 第二轮：v0.2.1 线内部增量（alpha.4 → rc.2）= **零破坏**

结论：**适配 rc.2**。窗口内三个关键契约文件与 alpha.4 **逐字节相同**（diff=0），本窗口没有新增破坏。

| 接口 | alpha.4 | rc.2 | 判断 |
|---|---|---|---|
| `CompactionEngine` 抽象面 | `compactIfNeeded` / `compactNow` / `compactRegion` | 同（`compaction/src/index.ts` 8736B，diff=0） | 未变 |
| **空闲态 + 指定区间** | 无 | **仍无**（无 `compactRange`；`compactRegion` 无选项参数；`/compact` 仍 `USAGE='Usage: /compact (no arguments)'`） | **补丁不可删**。可用公开签名：`compactRegion(start, end, agent, signal?)` |
| `conversation.input.left` | list / session / ownerProps 空 | `slots.ts` 26711B，diff=0 | 未变 |
| `plugins.bundle.config` | keyed / root / 必填 key | `slot-contract.ts` 8676B，diff=0 | 未变 |
| `settings.general.item` | list / root | diff=0（仍在） | 未变（可作过渡） |
| `CommandContribution` | — | `contract.ts` 6118B，diff=0 | 逐字相同 |
| `engines.dsh` 闸门 | 有 | `plugin-compatibility.ts` **diff=0**；豁免命令仍是 `allow-version`/`revoke-version`/`version-exemptions` | 规则未变 |
| `readBundlePatches('dsh', profile)` | 有 | diff=0 | 未变 |
| `parseDshClient` | — | `manifest.ts` 22987B，diff=0；`platform` 仍必填、`<id>/client` 仍识别 | 未变 |
| `defineTool` / `tools.register` | — | 仅 6 行差异（`SDK_RENDERERS` 增 `programFormat`），注册面未变 | 未变 |
| 新增槽位 | — | `conversation.input.model.label`（single/session/inline） | 纯附加，不冲突 |

### 纠正上一轮的一处归属

`serviceForAgent` 从包根消失**不是 alpha.4 引入的**，而是 **v0.2.0-rc.2 → alpha.1 之间**就发生了：

| tag | 包根是否导出 `serviceForAgent` |
|---|---|
| `dsh-v0.2.0-rc.2`（本地基线） | **是** |
| `alpha.1` / `.2` / `.3` / `.4` / `.5` / `rc.1` / `rc.2` | **否**（6 个 tag 一路未回补） |

⇒ 迁移目标 `ctx.agentPresets.serviceFor(agent, name)` 在整个 0.2.1 线都可用；而**不改它**的后果是
「preset 隔离下的实例定位降级」，从 alpha.1 起就存在。

### 官方 release notes（原判断"无 releases"已过时）

- `rc.2`：只有两条新功能（模型更新 + Search/Fetch 开关），**无 breaking**。
- `alpha.5`：4 项修复 + 新增 `conversation.input.model.label` 槽位。
- `rc.1`：累积式清单，提到 `engines.dsh` 优先判定、移除各包 `./invariant` 导出、移除 `both` 展示模式、
  azure provider 改名等 —— 其中 invariant/both 在 alpha.4 的源码里已完成，**不在本窗口**；本插件也不使用它们。

## 发布时的声明口径（建议）

- `verified on`：**0.2.0-rc.2** 与 **0.2.1-rc.2**（两版都实机跑过；rc.2 上验证了"加载 + 125/10/9 全绿 + 客户端路径真折叠"）。
  精确口径：**客户端路径（空闲态折指定区间）已在 rc.2 端到端验证**；**工具路径**结构未变但尚未在 rc.2 实跑。
- `audited against`：**0.2.1-alpha.1 … rc.2**（源码级，6 个 tag；其中 alpha.4→rc.2 窗口为零破坏）。
- `engines.dsh`：`>=0.2.0-rc.2 <0.3.0`（并在 README 注明：更宽的豁免可用上游的 `allow-version`）。

## 实机记录：升级到 0.2.1-rc.2（2026-10-19 02:07）

| 检查项 | 结果 |
|---|---|
| `dsh --version` | **0.2.1-rc.2** |
| `engines.dsh` 闸门 | 放行（插件正常加载） |
| 核心补丁 | **升级后已重打**：profile 与 CLI 树两处均含 `compactRange(...)`（mtime 01:22） |
| 组合 | `- id: compaction-selective` **恰好 1 行** |
| 实例捕获 + 摘要模板 | 正常（日志已到「第 13 个 compaction 实例」） |
| 测试基线 | **125 / 10 / 9 / 树校验全过**（比升级前 124 多 1 项：新增“preset 缺失应走服务面”的断言） |
| `preset` 模块导出 | 三个副本都**没有** `serviceForAgent`（与审计一致）→ 定位改走 `ctx.agentPresets.serviceFor`；该缺失**不再报 warn**（措辞改为「preset=服务面」，级别 info） |

**真折叠验证（2026-10-19，用户执行）**：在会话「奇瑞-春节营销案例PPT分析」通过面板折了一次，
日志实况：

```
[compaction-selective] 可选依赖：tools=ok；llm=ok；preset=服务面（模块导出在 0.2.1 起已移除，改用 ctx.agentPresets.serviceFor）
[compaction-selective] 捕获到第 1 个 compaction 实例
[compaction-selective] 已为第 1 个 compaction 实例装上局部压缩摘要模板
[compaction-selective] 客户端压缩：compacted — 已压缩 turn 2-3（49 条表面节点，约释放 28837 token）
```

⇒ **客户端路径在 0.2.1-rc.2 上端到端可用**（空闲态折指定区间 = 本地补丁的 `compactRange` 生效）。
**工具路径**（模型调 `compact_turns` + 审批卡）在 rc.2 上尚未实跑：它走上游 `compactRegion`
（审计里 diff=0）且被 125 项离线断言覆盖，但严格说属于「结构未变、未实机验证」。



## 桌面端（Electron）适配记录（2026-11-09，核心 **0.2.2-rc.1**）

**根因不是"桌面端不支持插件"，而是两层：**

1. **桌面端用另一个 profile**：`~/.dsh/profiles/desktop`（web 端是 `profiles/web`）。插件原先只装在 web，所以桌面端根本没装它。
   → 已修：给 `profiles/desktop/package.json` 加 `link:` 依赖 + `dsh.profile.bundles` 加包名，并建目录联接。备份：`dsh-plugins\profile-desktop-package.json.bak-20261109-173155`。
2. **桌面端的核心打包在 `app.asar` 里**（`resources\app.asar` 203 MB，二进制里命中 `dsh-compaction-basic` 于偏移 829694；`runtime\` 下**没有**可读副本）
   ⇒ **本地补丁无处可落**，所以"空闲态折指定区间"这一项在桌面端仍缺失。

**实机状态（桌面端 `/compaction-selective/state`，HTTP 200）**：

| 项 | 值 | 含义 |
|---|---|---|
| 摘要模板 | `fold` | 我们的局部压缩模板已装上 |
| 压缩通道 | `仅限轮内（补丁缺失）` | `app.asar` 里的核心没有 `compactRange` |
| 定位 | `how=service` / `service=hit` | **服务面路径（ctx.agentPresets.serviceFor）在 0.2.2-rc.1 上真的在用** |
| `patched` | `False` | 同上 |

**结论**：桌面端可用 —— 工具路径（`compact_turns` + 审批卡，走官方 `compactRegion`）、客户端按钮/面板/＋菜单、
摘要模板都正常；**只有"面板里空闲态折指定区间"需要核心补丁，目前无解**（除非改 `app.asar`）。

**这也是向上游要 API 的最强论据**：桌面端用户**根本无法**像 CLI 那样打补丁，官方入口是唯一可持续方案。

**顺带**：`engines.dsh: ">=0.2.0-rc.2 <0.3.0"` 放行了 0.2.2-rc.1；该版本**未做源码级审计**，但这次实机证据（加载 + 服务面命中 + 模板安装 + API 200）已覆盖主要路径。
