# 平台与发布笔记（维护者视角）

本文件记录三件**在代码里看不出来、但每次升级/发布都会用到**的事。都是踩过之后才写下来的。

---

## 1. 桌面端（Electron）的核心打包在 `app.asar` 里 —— 无法打补丁

- 桌面端核心位置：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`（约 200 MB）。
  二进制里能搜到 `dsh-compaction-basic`；`resources\runtime\` 下**没有**可读副本，
  `app.asar.unpacked\` 里只有原生模块（`@img`、`libreoffice-kit` 等）。
- **后果**：`patches/apply-compaction-patch.ps1` 只能作用于 CLI 安装树与 profile 副本；
  桌面端**没有可写的目标文件**，所以「空闲态 + 指定区间」在桌面端不可用。
- **插件的应对**（不要改回去）：
  - `available(session)` 探测不到 `compactRange` → **＋菜单那一行不出现**；
  - 面板在 `patched === false` 时**禁用动作按钮**并提示改用对话指令；
  - 绝不让用户"点了才收到 `NO_PATCH`"。
- **为什么不改 asar**：破坏完整性、每次应用更新被覆盖、写坏会导致应用无法启动。收益低于风险。
  正解是上游公开这个入口（需求帖：`deepseek-ai/deepseek-harness` discussions **12813**）。
- 桌面端用的是**另一个 profile**：`~/.dsh/profiles/desktop`（web 端是 `profiles/web`）。
  **插件必须分别装进两个 profile**（`link:` 依赖 + `dsh.profile.bundles` + 目录联接）。

> 需要在 upstream 讨论里解释「桌面端为何不行」时，直接引用 `docs/UPSTREAM-REPLY.md`（含可直接粘贴的中英段落与追问预案）。

## 2. `engines.dsh` 是安装闸门，不是文档

- DSH 0.2.1 起，`package.json` 的 `engines.dsh` **存在即单独判定，并忽略 `peerDependencies`**；
  判定用 `semver.satisfies(..., { includePrerelease: true })`。不满足会**拦截安装**，
  上游提供 `dsh plugin allow-version` 做精确版本豁免。
- **下边界不要写成 `>=0.2.0`**：那按 semver **不含** `0.2.0-rc.2` 这类预发布版本，
  会误拦已经验证过的环境。当前取值 `>=0.2.0-rc.2 <0.3.0` 与"支持 0.2.0 – 0.2.2"等价。
- 每次支持新版本，改的是**这一个字段** + README 的兼容矩阵（`COMPATIBILITY-AUDIT.md` 记证据与 SHA）。

## 3. 截图脱敏的正确顺序（我一开始做反了）

先决定**这张图要演示哪几步**，再把**那几步之外**的文字遮掉。反着做会遮掉要演示的内容：

| 图 | 要展示的 | 该遮的 |
|---|---|---|
| `menu.png` | "指令里能找到它" | 顶部残留的会话行 |
| `panel.png` | 概况 + 快捷轮数 + 区间 + 轮次表 | 面板外的会话背景、轮次表的**内容列**（保留轮号/用量） |
| `approval.png` | 你发指令 → 确认卡 → 三个选项 | 第三方正文、思考行；**指令气泡必须保留** |

- 做法：Pillow 按**相对坐标**遮矩形 + 高斯模糊（半径按图宽缩放），脚本思路见提交历史。
- **必须回读成品确认**，不要"应该没问题"。

## 4. 客户端的本地文案目前**只有中文**

- 面板、菜单项、设置页标签、确认卡提示全部是硬编码中文字符串（无 i18n 层）。
- 因此 README 里的截图是中文界面，英文 README 中已注明。
- 若要支持英文界面：客户端可注入 `locale` 服务（`ctx.locale`），按当前语言选字符串；
  工作量集中在 `lib/client.js` 的文案表与 `lib/index.js` 的审批卡文案。
