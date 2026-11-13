# 给上游讨论的补充说明（可直接粘贴）

> 用途：当维护者或用户追问「为什么桌面端不能用」「为什么不自己打补丁」时，直接引用下面的段落，省一次往返。
> 对应需求帖：https://github.com/deepseek-ai/deepseek-harness/discussions/12813
> 证据来源：本机 2026-11 实测（DSH `0.2.2-rc.1` 桌面端 + `0.2.2-rc.1` CLI），另见 `PLATFORM-NOTES.md`。

---

## 1. 英文回复（可直接粘贴）

```markdown
Thanks — a concrete answer to "why doesn't it just work on the desktop app", with what I actually
checked on a Windows install (DSH 0.2.2-rc.1):

**The desktop app's core is inside `resources/app.asar` and is not addressable at runtime.**

- `resources/app.asar` (~203 MB) contains `dsh-compaction-basic` — searching the archive's bytes for
  that name hits at offset ~829694.
- `resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/` contains only native/binary packages
  (`dsh-session-log-export`, `libreoffice-kit`, `libreoffice-kit-win32-x64`) — the core packages are
  **not** unpacked there.
- `resources/runtime/` has `bin`, `cli`, `office-skills`, `primary-runtime`, `versions.json`, but no
  `@deepseek-ai/dsh-compaction-basic` anywhere in that tree.
- The profile (`~/.dsh/profiles/desktop/node_modules`) only contains what the profile declares; DSH
  itself is resolved from the packed app.

So the 15-line bridge that works on a CLI install (`compactRange` added to the engine, mirroring
`compactNow`'s manual path) has **no file to patch** on the desktop app. Repacking `app.asar` would
work in principle, but it breaks the app bundle's integrity, is overwritten by every update, and can
leave the app unstartable — not something a plugin should ask users to do.

**What the plugin does instead**: it detects the situation at runtime (the engine has no
`compactRange`) and degrades visibly — the tool path keeps working, the summary template keeps
working, and the panel disables its actions and explains why, instead of failing after a click. The
diagnostic line in the panel literally reads `fold channel: during a turn only (local patch missing)`.

**The ask** (same as the original post, now with this constraint as the motivation): a supported way
to compact an **explicit span while the agent is idle**. Either shape would do:

- `CompactionEngine#compactRange(start, end, agent, signal?, sourceCommandId?)`, or
- `compactRegion(start, end, agent, signal, { owner: null, stability: 'selected-span' })`.

On our side that's the difference between "works everywhere" and "works only where the user can patch
a file". Happy to test a branch, and happy to be told there's already a sanctioned way I missed.
```

## 2. 中文（同一内容，供中文读者）

> 说明「桌面端为何不行」的实测依据：`resources/app.asar`（约 203 MB）里包含 `dsh-compaction-basic`
> （按包名字节搜索命中于偏移 ~829694）；`app.asar.unpacked` 下只有原生包（session-log-export、
> libreoffice-kit 等），核心包**没有**解包；`resources/runtime/` 里也没有这个包；profile 的
> `node_modules` 只包含 profile 自己声明的依赖。
>
> 所以 CLI 上那 15 行桥接（给引擎加 `compactRange`）在桌面端**没有可改的文件**。重打 `app.asar`
> 理论上可行，但会破坏完整性、每次更新被覆盖、写坏会让应用起不来——这不该是插件要求用户做的事。
>
> 插件现在的做法是**运行时探测并显式降级**：工具路径与摘要模板照常工作，面板禁用动作并说明原因
> （诊断行会写 `压缩通道：仅限轮内（补丁缺失）`），而不是让人点了才报错。
>
> 需求依旧是：给出「**空闲态 + 显式区间**」的受支持入口——`compactRange(...)`，或
> `compactRegion(..., { owner: null })`。对我们来说，这就是「到处能用」与「只有能打补丁的地方能用」
> 的区别。

## 3. 追问预案（我们这边先想好的答案）

| 追问 | 回答要点 |
|---|---|
| 「为什么不 monkey-patch / 用 loader hook？」 | 桌面端主进程与本插件的运行环境不同，且核心对象在 asar 内被一次性加载；没有官方扩展点的情况下，任何 hook 都依赖内部实现细节，升级即碎，还可能被完整性校验拒绝 |
| 「为什么不安个 profile 级依赖覆盖掉核心？」 | 插件与宿主必须解析到**同一个** `dsh-compaction-basic` 实例（引擎状态在实例上）；profile 里再装一份只会得到第二个实例，打补丁的那个不生效——这一点 CLI 上我们也踩过（宿主实际加载的是安装树那份） |
| 「CLI 上也别打补丁不行吗？」 | 行，但代价是「空闲态折指定区间」这个能力直接消失；打补丁的作用是**在官方入口出现前保住能力**，且脚本幂等、锚点变化即拒绝执行 |
| 「会不会破坏官方压缩语义？」 | 不会：折法复用官方 `compactRegion`/`compactNow` 的事务、稳定性校验与摘要收敛校验，我们不自定义这些；插件只负责「选哪一段」与「人确认」 |

## 4. 可复现的检查命令（Windows）

```powershell
$res = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources"

# 1) 核心包在 asar 里（按字节搜包名）
$bytes = [IO.File]::ReadAllBytes("$res\app.asar")
$needle = [Text.Encoding]::ASCII.GetBytes('dsh-compaction-basic')
# ……线性搜索命中即证明

# 2) unpacked 里只有原生包
Get-ChildItem "$res\app.asar.unpacked\dsh\node_modules\@deepseek-ai"

# 3) runtime 里没有核心包
Get-ChildItem $res\runtime -Directory

# 4) profile 只含自己声明的依赖
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules" -Directory
```
