<#
  apply-compaction-patch.ps1 —— 给 @deepseek-ai/dsh-compaction-basic 打上 compactRange 补丁

  为什么需要它：
    上游有「空闲态压缩」（compactNow）与「指定区间压缩」（compactRegion）两半，却没有它们的组合 ——
    compactNow 的区间由 selectCompactableRange 自己选（只能是前缀），compactRegion 收显式区间却要求
    存在打开的轮次。而 **Web GUI 的按钮、斜杠命令天然是空闲态**，需要的正是这个组合。
    dsh-compaction-selective 的客户端面板要靠它才能一键折叠。

  ⚠ 2026-10-15 实测教训：**宿主加载的是 CLI 安装树里那一份，不是 profile 里那一份。**
    证据：profile 副本已打补丁（50.2 KB），CLI 副本无补丁（48.3 KB），而宿主在补丁之后启动却报
    「折叠通道 仅限轮内（补丁缺失）」。所以只打 profile 一处会得到「文件里有、运行时没有」的假象。
    本脚本**两处都打**。

  幂等：两处都已有 marker 就什么都不做。重装 profile 或升级 CLI 会各自还原对应的那一份。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File apply-compaction-patch.ps1 [-DryRun]
  退出码：0 = 两处都已就位或已成功打上；1 = 需要人工处理（锚点找不到 / 语法校验失败 / 两处都不存在）
#>
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$marker = 'compactRange(start, end, agent, signal, sourceCommandId)'
$targets = @(
  (Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js'),
  (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js')
)

$anchor = @'
	async compactRegion(start, end, agent, signal) {
		return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, {
			owner: "current-turn",
			stability: "whole-surface"
		}, signal);
	}
'@
$anchor = $anchor -replace "`r`n", "`n"

$patch = @'

	/* ==== 本地补丁 / compactRange（本地维护，供过渡期使用）（2026-10-15）=========================
	 * 上游有「空闲态」与「指定区间」两半，却没有它们的组合：`compactNow` 可以是空闲态，但区间由
	 * `selectCompactableRange` 自己选（只能是前缀）；`compactRegion` 收显式区间，却要求存在打开的
	 * 轮次（`owner: "current-turn"`）。而 **Web GUI 的按钮、斜杠命令天然是空闲态** —— 它们需要
	 * 的正是这个入口。语义完全照 `compactNow` 的手动路径：`runMaintenance` 保证 idle 且与驱动
	 * 轮次互斥、`owner: null`、`stability: "selected-span"`（压缩期间有新消息也不会作废）、
	 * 结尾一次 `sessions.flush` 作为持久化检查点。
	 * 重装 profile / 升级 CLI 都会覆盖对应那一份 → 用 <repo>/patches/apply-compaction-patch.ps1 重打（两处都打）。
	 * ================================================================================== */
	compactRange(start, end, agent, signal, sourceCommandId) {
		signal.throwIfAborted();
		try {
			return agent.runMaintenance(async (agentSignal) => {
				const operationSignal = AbortSignal.any([agentSignal, signal]);
				try {
					operationSignal.throwIfAborted();
					return await compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, {
						owner: null,
						stability: "selected-span",
						...sourceCommandId === void 0 ? {} : { sourceCommandId },
						flush: async () => {
							await this.ctx.sessions.flush(agent.session);
						}
					}, operationSignal);
				} catch (error) {
					if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw new ManualCompactionError("cancelled", "manual compaction was cancelled", { cause: error });
					operationSignal.throwIfAborted();
					throw error;
				}
			});
		} catch (error) {
			throw new ManualCompactionError("busy", "manual compaction requires an idle agent with no waking queued work", { cause: error });
		}
	}
'@
$patch = $patch -replace "`r`n", "`n"

$problems = 0
$present = 0
foreach ($target in $targets) {
  $label = if ($target -like '*\profiles\*') { 'profile' } else { 'CLI-tree' }
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host ("x [{0}] missing: {1}" -f $label, $target) -ForegroundColor Red
    $problems++
    continue
  }
  $text = [System.IO.File]::ReadAllText($target)
  if ($text.Contains($marker)) {
    Write-Host ("OK [{0}] already patched." -f $label) -ForegroundColor Green
    $present++
    continue
  }
  $normalized = $text -replace "`r`n", "`n"
  if (-not $normalized.Contains($anchor)) {
    Write-Host ("x [{0}] anchor not found (upstream compactRegion changed), manual fix needed: {1}" -f $label, $target) -ForegroundColor Red
    $problems++
    continue
  }
  if ($DryRun) { Write-Host ("[DryRun] [{0}] anchor ok, would patch: {1}" -f $label, $target); continue }

  $backupDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-compaction-patch-backups'
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backupName = 'dsh-compaction-basic.index.js.bak-{0}-{1}' -f $label, (Get-Date -Format 'yyyyMMdd-HHmmss')
  $backup = Join-Path $backupDir $backupName
  Copy-Item -LiteralPath $target -Destination $backup -Force
  Write-Host ("  backup: {0}" -f $backup)

  $updated = $normalized.Replace($anchor, ($anchor + $patch))
  $tmp = "$target.patched.js"
  [System.IO.File]::WriteAllText($tmp, $updated, (New-Object System.Text.UTF8Encoding($false)))
  & node --check $tmp 2>&1 | ForEach-Object { Write-Host ("  node --check: {0}" -f $_) -ForegroundColor Red }
  if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force; Write-Host ("x [{0}] syntax check failed, file untouched." -f $label) -ForegroundColor Red; $problems++; continue }
  Move-Item -LiteralPath $tmp -Destination $target -Force
  $after = [System.IO.File]::ReadAllText($target)
  if ($after.Contains($marker)) { Write-Host ("OK [{0}] patched (restart the host to take effect)." -f $label) -ForegroundColor Green; $present++ }
  else { Write-Host ("x [{0}] marker still missing after write, inspect manually." -f $label) -ForegroundColor Red; $problems++ }
}

if ($problems -gt 0) { exit 1 }
if ($DryRun) { exit 0 }
Write-Host ("All {0} location(s) ready; restart the host to enable one-click folding." -f $present) -ForegroundColor Green
exit 0
